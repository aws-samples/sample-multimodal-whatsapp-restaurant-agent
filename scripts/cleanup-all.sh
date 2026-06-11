#!/bin/bash

################################################################################
# Cleanup All - WhatsApp Restaurant AI Host
#
# Destroys the WhatsApp-variant stacks in REVERSE deploy order. Resumable via
# the shared .deployment-state.json. No Chime, no SIP, no PSTN number, no
# synthetic-data layer (this variant never had any of those).
#
# REVERSE teardown order (mirror of deploy-all.sh layer order):
#   1.  wa-webhook              whatsapp-interface/whatsapp-webhook/cdk
#   2.  wa-runtime-chat         whatsapp-interface/whatsapp-chat-agent/cdk
#   3.  wa-runtime-voicenotes   backend/agentcore-runtime-voicenotes/cdk
#   4.  wa-runtime-call         backend/agentcore-runtime-voice-webrtc/cdk
#   5.  wa-memory               backend/agentcore-memory
#   6.  wa-gateway              backend/agentcore-gateway/cdk
#   7.  wa-apigw                backend/backend-infrastructure  (ApiGatewayStack)
#   8.  wa-lambdas              backend/backend-infrastructure  (LambdaStack)
#   9.  wa-location             backend/backend-infrastructure  (LocationStack)
#   10. wa-ddb                  backend/backend-infrastructure  (DynamoDBStack)
#   11. wa-network              backend/network                 (NetworkStack)
#
# FORWARD-COMPATIBILITY GUARD: the memory / runtime / webhook modules are built
# by later tasks. destroy_stack guards each on module_ready: a missing CDK app
# is skipped with a clear notice rather than hard-failing (cdk destroy needs to
# synthesize, which needs the app to exist).
#
# AUTO-HEAL (working agreement #9): on a DELETE_FAILED stack, drain the common
# blockers (non-empty S3 bucket, non-empty ECR repo, lingering ENIs) and retry
# the delete once. Capped, no infinite loops.
#
# Usage:
#   ./scripts/cleanup-all.sh [OPTIONS]
#
# Options:
#   --skip-webhook            Skip wa-webhook cleanup
#   --skip-runtime-chat       Skip wa-runtime-chat cleanup
#   --skip-runtime-voicenotes Skip wa-runtime-voicenotes cleanup
#   --skip-runtime-call       Skip wa-runtime-call cleanup
#   --skip-memory             Skip wa-memory cleanup
#   --skip-gateway            Skip wa-gateway cleanup
#   --skip-apigw              Skip wa-apigw cleanup
#   --skip-lambdas            Skip wa-lambdas cleanup
#   --skip-location           Skip wa-location cleanup
#   --skip-ddb                Skip wa-ddb cleanup
#   --skip-network            Skip wa-network cleanup
#   --deploymentPrefix <name> Prefix for orphan-resource auto-heal sweeps.
#   --ignore-missing-resources  Continue even if stacks do not exist
#   --force                   Skip confirmation prompts (the destructive gate)
#   --dry-run                 Preview what would be deleted
#   --help                    Show this help
################################################################################

set +e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=deployment-state.sh
source "$SCRIPT_DIR/deployment-state.sh"

OUTPUTS_DIR="cdk-outputs"

SKIP_WEBHOOK=false
SKIP_RUNTIME_CHAT=false
SKIP_RUNTIME_VOICENOTES=false
SKIP_RUNTIME_CALL=false
SKIP_MEMORY=false
SKIP_GATEWAY=false
SKIP_APIGW=false
SKIP_LAMBDAS=false
SKIP_LOCATION=false
SKIP_DDB=false
SKIP_NETWORK=false
IGNORE_MISSING=true
FORCE=false
DRY_RUN=false
CONTINUE_ON_ERROR=true

# Project prefix for orphan resource sweeps. Read from .deployment-state.json
# if available, fall back to "qsr-wa" matching deploy-all.sh's default.
PROJECT_PREFIX="qsr-wa"
if [ -f "$WORKSPACE_ROOT/.deployment-state.json" ]; then
  state_prefix=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$WORKSPACE_ROOT/.deployment-state.json','utf8'));
      const c = d.components || {};
      const first = Object.values(c).find(v => v && v.prefix);
      if (first && first.prefix) console.log(first.prefix);
    } catch (e) {}
  " 2>/dev/null || true)
  if [ -n "$state_prefix" ]; then
    PROJECT_PREFIX="$state_prefix"
  fi
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-webhook)             SKIP_WEBHOOK=true;             shift ;;
    --skip-runtime-chat)        SKIP_RUNTIME_CHAT=true;        shift ;;
    --skip-runtime-voicenotes)  SKIP_RUNTIME_VOICENOTES=true;  shift ;;
    --skip-runtime-call)        SKIP_RUNTIME_CALL=true;        shift ;;
    --skip-memory)              SKIP_MEMORY=true;              shift ;;
    --skip-gateway)             SKIP_GATEWAY=true;             shift ;;
    --skip-apigw)               SKIP_APIGW=true;               shift ;;
    --skip-lambdas)             SKIP_LAMBDAS=true;             shift ;;
    --skip-location)            SKIP_LOCATION=true;            shift ;;
    --skip-ddb)                 SKIP_DDB=true;                 shift ;;
    --skip-network)             SKIP_NETWORK=true;             shift ;;
    --deploymentPrefix)         PROJECT_PREFIX="$2";           shift 2 ;;
    --ignore-missing-resources) IGNORE_MISSING=true; CONTINUE_ON_ERROR=true; shift ;;
    --force)                    FORCE=true;                    shift ;;
    --dry-run)                  DRY_RUN=true;                  shift ;;
    --help) grep "^#" "$0" | grep -v "^#!/" | sed 's/^# //'; exit 0 ;;
    *) echo -e "${RED}[ERROR] Unknown option: $1${NC}"; echo "Use --help for usage information"; exit 1 ;;
  esac
done

print_section() {
  echo ""
  echo -e "${BLUE}============================================================${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}============================================================${NC}"
  echo ""
}

print_success() { echo -e "${GREEN}[OK] $1${NC}"; }
print_error()   { echo -e "${RED}[ERROR] $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[INFO] $1${NC}"; }

# Forward-compatibility guard: only attempt a destroy when a synthesizable CDK
# app exists (cdk destroy synthesizes first).
module_ready() {
  local dir="$WORKSPACE_ROOT/$1"
  [ -d "$dir" ] && [ -f "$dir/cdk.json" ]
}

# safe_npm_install ensures deps exist so `cdk destroy` can synthesize. Unlike
# the deploy script we do NOT wipe sibling node_modules during teardown
# (that was the root cause of "Cannot find module 'aws-cdk-lib'" destroy
# failures). FAIL LOUDLY if install errors - destroy cannot synth without deps.
safe_npm_install() {
  local current_dir
  current_dir=$(pwd)

  if [ ! -d "node_modules" ] || [ ! -d "node_modules/aws-cdk-lib" ]; then
    print_info "Installing dependencies in $(basename "$current_dir")..."
    if ! npm install --no-fund --no-audit > /dev/null 2>&1; then
      print_error "npm install failed in $current_dir - cdk destroy cannot synthesize without dependencies."
      print_info  "Re-run: (cd $current_dir && npm install) then re-run cleanup-all.sh"
      return 1
    fi
  fi

  # Detect an aws-cdk CLI too old to read the aws-cdk-lib schema (cdk destroy
  # synthesizes first). On skew, flip USE_NPX_LATEST_CDK so destroy_stack pulls
  # a current CLI via npx.
  if [ -f node_modules/aws-cdk-lib/package.json ]; then
    local probe
    probe=$(npx cdk ls 2>&1 || true)
    if echo "$probe" | grep -q "Cloud assembly schema version mismatch"; then
      print_warning "aws-cdk CLI too old for aws-cdk-lib in $(basename "$current_dir"); destroy will use npx cdk@latest."
      USE_NPX_LATEST_CDK=true
    fi
  fi
}

################################################################################
# DELETE_FAILED auto-heal (working agreement #9).
#
# drain_and_retry_delete <stack-name> - inspects a DELETE_FAILED stack, drains
# the common blockers (non-empty S3 bucket, non-empty ECR repo, lingering ENIs
# on the prefix's security group), then retries delete-stack once. The blast
# radius is scoped to resources owned by this stack / deployment prefix.
################################################################################
heal_delete_failed() {
  local stack_name="$1"
  local region="us-east-1"

  local status
  status=$(aws cloudformation describe-stacks --region "$region" \
    --stack-name "$stack_name" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")
  [ "$status" = "DELETE_FAILED" ] || return 0

  print_warning "Auto-heal: $stack_name is DELETE_FAILED - draining blockers and retrying."

  # Drain non-empty S3 buckets owned by this stack.
  local buckets
  buckets=$(aws cloudformation describe-stack-resources --region "$region" \
    --stack-name "$stack_name" \
    --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
    --output text 2>/dev/null || echo "")
  for b in $buckets; do
    [ -n "$b" ] || continue
    print_info "Draining S3 bucket $b"
    aws s3 rm "s3://$b" --recursive 2>/dev/null || true
    # Remove any versioned objects / delete markers that block bucket delete.
    aws s3api delete-objects --bucket "$b" --region "$region" \
      --delete "$(aws s3api list-object-versions --bucket "$b" --region "$region" \
        --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null)" \
      2>/dev/null || true
    aws s3api delete-objects --bucket "$b" --region "$region" \
      --delete "$(aws s3api list-object-versions --bucket "$b" --region "$region" \
        --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null)" \
      2>/dev/null || true
  done

  # Drain non-empty ECR repositories owned by this stack (force-delete images).
  local repos
  repos=$(aws cloudformation describe-stack-resources --region "$region" \
    --stack-name "$stack_name" \
    --query "StackResources[?ResourceType=='AWS::ECR::Repository'].PhysicalResourceId" \
    --output text 2>/dev/null || echo "")
  for r in $repos; do
    [ -n "$r" ] || continue
    print_info "Force-deleting ECR repository $r (images included)"
    aws ecr delete-repository --repository-name "$r" --region "$region" --force 2>/dev/null || true
  done

  # Detach lingering ENIs on this stack's security groups (a common VPC-delete
  # blocker for the runtime stacks). Only ENIs in 'available' state are removed.
  local sgs
  sgs=$(aws cloudformation describe-stack-resources --region "$region" \
    --stack-name "$stack_name" \
    --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" \
    --output text 2>/dev/null || echo "")
  for sg in $sgs; do
    [ -n "$sg" ] || continue
    local enis
    enis=$(aws ec2 describe-network-interfaces --region "$region" \
      --filters "Name=group-id,Values=$sg" "Name=status,Values=available" \
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null || echo "")
    for eni in $enis; do
      [ -n "$eni" ] || continue
      print_info "Deleting available ENI $eni on $sg"
      aws ec2 delete-network-interface --network-interface-id "$eni" --region "$region" 2>/dev/null || true
    done
  done

  # Retry the delete once. CFN can re-attempt with the blockers cleared.
  print_info "Retrying delete-stack for $stack_name"
  aws cloudformation delete-stack --region "$region" --stack-name "$stack_name" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack_name" 2>/dev/null || true
}

print_section "WhatsApp Restaurant AI Host - Full Cleanup"

if [ "$DRY_RUN" = true ]; then
  print_warning "DRY RUN MODE - No resources will be deleted"
  echo ""
fi

# Destructive-action confirmation gate (working agreement #9): without --force
# the script MUST prompt or refuse. --dry-run also bypasses the prompt safely.
if [ "$FORCE" != true ] && [ "$DRY_RUN" != true ]; then
  echo -e "${YELLOW}[WARN] This will delete the WhatsApp Restaurant AI Host stacks!${NC}"
  echo ""
  echo "This includes (in reverse deploy order):"
  echo "  - WebhookStack           (API Gateway, webhook Lambda, secrets, window table)"
  echo "  - ChatAgentStack         (Chat runtime: ECR, CodeBuild, AgentCore Runtime)"
  echo "  - VoiceNotesStack        (VoiceNotes runtime: ECR, CodeBuild, AgentCore Runtime)"
  echo "  - VoiceWebrtcStack       (Call runtime: ECR, CodeBuild, AgentCore Runtime, KVS)"
  echo "  - MemoryStack            (shared AgentCore Memory)"
  echo "  - AgentCoreGatewayStack  (MCP/AWS_IAM gateway + provisioner Lambda)"
  echo "  - ApiGatewayStack        (backend REST API, AWS_IAM auth)"
  echo "  - LambdaStack            (ordering Lambdas)"
  echo "  - LocationStack          (place-index, route-calculator)"
  echo "  - DynamoDBStack          (5 tables: Menu, Carts, Orders, Customers, Locations)"
  echo "  - NetworkStack           (VPC, subnets, NAT, SG)"
  echo ""
  echo -e "${RED}This action cannot be undone!${NC}"
  echo ""
  read -r -p "Are you sure you want to continue? (yes/no): " response
  if [[ "$response" != "yes" && "$response" != "y" ]]; then
    print_info "Cleanup cancelled"
    exit 0
  fi
fi

init_state

# ---- Resolve Bedrock AgentCore-supported AZs (synth-time context) ----
# backend/network/lib/network-stack.ts requires the agentcoreAzs context key
# to synthesize, AND `cdk destroy` runs synthesis first. Mirror deploy-all.sh.
# On AWS-call failure, fall back to a valid pair; the value is not consumed at
# destroy time, it only satisfies synth-time validation.
BEDROCK_SUPPORTED_AZ_IDS="use1-az1 use1-az2 use1-az4"
AGENTCORE_AZS=$(aws ec2 describe-availability-zones \
  --region us-east-1 \
  --filters Name=zone-type,Values=availability-zone \
  --query 'AvailabilityZones[].[ZoneName,ZoneId]' \
  --output text 2>/dev/null \
  | awk -v supported="$BEDROCK_SUPPORTED_AZ_IDS" '
      BEGIN { split(supported, arr, " "); for (i in arr) s[arr[i]] = 1; n = 0 }
      { if ($2 in s && n < 2) { if (n > 0) printf ","; printf "%s", $1; n++ } }
      END { print "" }
    ')
if [ -z "$AGENTCORE_AZS" ] || [ "$(echo "$AGENTCORE_AZS" | tr ',' '\n' | wc -l)" -lt 2 ]; then
  print_warning "Could not resolve AZ mapping from AWS; using fallback us-east-1a,us-east-1b for synth-only context"
  AGENTCORE_AZS="us-east-1a,us-east-1b"
fi

print_info "Starting cleanup in reverse deploy order..."
echo ""
OVERALL_SUCCESS=true

# destroy_stack - destroy one stack with shared error-handling semantics. Runs
# in a subshell so `cd` stays local. Respects --force / --dry-run /
# --ignore-missing-resources. Guards on module_ready so not-yet-built modules
# skip cleanly. On a failed destroy, runs heal_delete_failed and retries once.
#
# Arguments:
#   $1 = CDK dir (relative to workspace root)
#   $2 = CDK construct id (UN-prefixed; matches bin/cdk.ts)
#   $3 = cdk-outputs/<file>.json basename
#   $4 = component key for .deployment-state.json
#   $5 = optional extra cdk flags (space-separated, e.g. "--context k=v")
destroy_stack() {
  local cdk_dir=$1
  local stack_id=$2
  local outputs_file=$3
  local component_key=$4
  local extra_flags=${5:-}
  local destroy_flags=""

  if ! module_ready "$cdk_dir"; then
    print_warning "$component_key: no CDK app at $cdk_dir - layer not yet implemented, skipping"
    return 0
  fi

  if [ "$FORCE" = true ]; then
    destroy_flags="--force"
  fi

  if [ "$DRY_RUN" = true ]; then
    print_info "Would destroy $stack_id (cdk dir: $cdk_dir)"
    return 0
  fi

  (
    set -e
    cd "$WORKSPACE_ROOT/$cdk_dir"
    USE_NPX_LATEST_CDK=false
    safe_npm_install
    # shellcheck disable=SC2086
    if [ "${USE_NPX_LATEST_CDK:-false}" = true ]; then
      npx --yes cdk@latest destroy $destroy_flags $extra_flags "$stack_id"
    else
      npx cdk destroy $destroy_flags $extra_flags "$stack_id"
    fi
  )
  local ec=$?
  if [ $ec -eq 0 ]; then
    print_success "$stack_id destroyed"
    update_state "$component_key" false "{}"
    rm -f "$WORKSPACE_ROOT/$OUTPUTS_DIR/$outputs_file"
  else
    print_error "$stack_id destroy failed (exit $ec) - attempting DELETE_FAILED auto-heal"
    heal_delete_failed "$stack_id"
    # Re-check: if the stack is gone after the heal, count it as success.
    local still
    still=$(aws cloudformation describe-stacks --region us-east-1 \
      --stack-name "$stack_id" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")
    if [ -z "$still" ]; then
      print_success "$stack_id destroyed after auto-heal"
      update_state "$component_key" false "{}"
      rm -f "$WORKSPACE_ROOT/$OUTPUTS_DIR/$outputs_file"
    else
      print_error "$stack_id still present ($still) after auto-heal"
      if [ "$IGNORE_MISSING" != true ] && [ "$CONTINUE_ON_ERROR" = false ]; then
        exit 1
      fi
      OVERALL_SUCCESS=false
    fi
  fi
}

# Step 1: WebhookStack
if [ "$SKIP_WEBHOOK" = false ]; then
  print_section "Step 1: Destroying WebhookStack (wa-webhook)"
  if [ "$(is_deployed wa-webhook)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "whatsapp-interface/whatsapp-webhook/cdk" \
      "WebhookStack" \
      "wa-webhook.json" \
      "wa-webhook"
  else
    print_info "wa-webhook not deployed; skipping"
  fi
else
  print_warning "Skipping Webhook cleanup"
fi

# Step 2: ChatAgentStack
if [ "$SKIP_RUNTIME_CHAT" = false ]; then
  print_section "Step 2: Destroying ChatAgentStack (wa-runtime-chat)"
  if [ "$(is_deployed wa-runtime-chat)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "whatsapp-interface/whatsapp-chat-agent/cdk" \
      "ChatAgentStack" \
      "wa-runtime-chat.json" \
      "wa-runtime-chat" \
      "--context agentcoreAzs=${AGENTCORE_AZS}"
  else
    print_info "wa-runtime-chat not deployed; skipping"
  fi
else
  print_warning "Skipping Chat runtime cleanup"
fi

# Step 3: VoiceNotesStack
if [ "$SKIP_RUNTIME_VOICENOTES" = false ]; then
  print_section "Step 3: Destroying VoiceNotesStack (wa-runtime-voicenotes)"
  if [ "$(is_deployed wa-runtime-voicenotes)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-runtime-voicenotes/cdk" \
      "VoiceNotesStack" \
      "wa-runtime-voicenotes.json" \
      "wa-runtime-voicenotes" \
      "--context agentcoreAzs=${AGENTCORE_AZS}"
  else
    print_info "wa-runtime-voicenotes not deployed; skipping"
  fi
else
  print_warning "Skipping VoiceNotes runtime cleanup"
fi

# Step 4: VoiceWebrtcStack (Call runtime)
if [ "$SKIP_RUNTIME_CALL" = false ]; then
  print_section "Step 4: Destroying VoiceWebrtcStack (wa-runtime-call)"
  if [ "$(is_deployed wa-runtime-call)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-runtime-voice-webrtc/cdk" \
      "VoiceWebrtcStack" \
      "wa-runtime-call.json" \
      "wa-runtime-call" \
      "--context agentcoreAzs=${AGENTCORE_AZS}"
  else
    print_info "wa-runtime-call not deployed; skipping"
  fi
else
  print_warning "Skipping Call runtime cleanup"
fi

# Step 5: MemoryStack
if [ "$SKIP_MEMORY" = false ]; then
  print_section "Step 5: Destroying MemoryStack (wa-memory)"
  if [ "$(is_deployed wa-memory)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-memory" \
      "MemoryStack" \
      "wa-memory.json" \
      "wa-memory"
  else
    print_info "wa-memory not deployed; skipping"
  fi
else
  print_warning "Skipping Memory cleanup"
fi

# Step 6: AgentCoreGatewayStack (must go before the REST API it fronts)
if [ "$SKIP_GATEWAY" = false ]; then
  print_section "Step 6: Destroying AgentCoreGatewayStack (wa-gateway)"
  if [ "$(is_deployed wa-gateway)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-gateway/cdk" \
      "AgentCoreGatewayStack" \
      "wa-gateway.json" \
      "wa-gateway"
  else
    print_info "wa-gateway not deployed; skipping"
  fi
else
  print_warning "Skipping AgentCoreGateway cleanup"
fi

# Step 7: ApiGatewayStack
if [ "$SKIP_APIGW" = false ]; then
  print_section "Step 7: Destroying ApiGatewayStack (wa-apigw)"
  if [ "$(is_deployed wa-apigw)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "ApiGatewayStack" \
      "wa-apigw.json" \
      "wa-apigw"
  else
    print_info "wa-apigw not deployed; skipping"
  fi
else
  print_warning "Skipping ApiGateway cleanup"
fi

# Step 8: LambdaStack
if [ "$SKIP_LAMBDAS" = false ]; then
  print_section "Step 8: Destroying LambdaStack (wa-lambdas)"
  if [ "$(is_deployed wa-lambdas)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "LambdaStack" \
      "wa-lambdas.json" \
      "wa-lambdas"
  else
    print_info "wa-lambdas not deployed; skipping"
  fi
else
  print_warning "Skipping Lambda cleanup"
fi

# Step 9: LocationStack
if [ "$SKIP_LOCATION" = false ]; then
  print_section "Step 9: Destroying LocationStack (wa-location)"
  if [ "$(is_deployed wa-location)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "LocationStack" \
      "wa-location.json" \
      "wa-location"
  else
    print_info "wa-location not deployed; skipping"
  fi
else
  print_warning "Skipping Location cleanup"
fi

# Step 10: DynamoDBStack
if [ "$SKIP_DDB" = false ]; then
  print_section "Step 10: Destroying DynamoDBStack (wa-ddb)"
  if [ "$(is_deployed wa-ddb)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "DynamoDBStack" \
      "wa-ddb.json" \
      "wa-ddb"
  else
    print_info "wa-ddb not deployed; skipping"
  fi
else
  print_warning "Skipping DynamoDB cleanup"
fi

# Step 11: NetworkStack (last - everything in a VPC depends on it)
if [ "$SKIP_NETWORK" = false ]; then
  print_section "Step 11: Destroying NetworkStack (wa-network)"
  if [ "$(is_deployed wa-network)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/network" \
      "NetworkStack" \
      "wa-network.json" \
      "wa-network" \
      "--context agentcoreAzs=${AGENTCORE_AZS}"
  else
    print_info "wa-network not deployed; skipping"
  fi
else
  print_warning "Skipping Network cleanup"
fi

print_section "Cleanup Complete!"

if [ "$DRY_RUN" = false ] && [ "$OVERALL_SUCCESS" = true ] && [ -f "$STATE_FILE_ABS" ]; then
  rm -f "$STATE_FILE_ABS"
  print_info "Removed deployment state file"
elif [ "$DRY_RUN" = false ] && [ "$OVERALL_SUCCESS" = false ]; then
  print_warning "State file preserved - re-run cleanup to finish remaining components"
fi

if [ -d "$WORKSPACE_ROOT/$OUTPUTS_DIR" ]; then
  if [ -z "$(ls -A "$WORKSPACE_ROOT/$OUTPUTS_DIR" 2>/dev/null)" ]; then
    if [ "$DRY_RUN" = false ]; then
      rmdir "$WORKSPACE_ROOT/$OUTPUTS_DIR" 2>/dev/null || true
      print_info "Removed empty outputs directory"
    fi
  fi
fi

if [ "$DRY_RUN" = true ]; then
  print_warning "DRY RUN completed - no resources were deleted"
  echo ""
  print_info "Run without --dry-run to actually delete resources"
elif [ "$OVERALL_SUCCESS" = true ]; then
  print_success "All WhatsApp Restaurant AI Host stacks cleaned up"
else
  print_warning "Some stacks may not have been cleaned up. Check the errors above."
  echo ""
  print_info "Re-run ./scripts/cleanup-all.sh to resume - already-cleaned components will be skipped."
  exit 1
fi
