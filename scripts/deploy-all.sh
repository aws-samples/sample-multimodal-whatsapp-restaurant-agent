#!/usr/bin/env bash

################################################################################
# Idempotent Deploy - WhatsApp Restaurant AI Host
#
# Adapted from the telephony repo's deploy-all.sh. This variant has NO Chime,
# NO SIP, NO PSTN number, and NO synthetic-data layer. It orchestrates the
# eight WhatsApp-variant layers (see the layer map below) and threads the
# shared AgentCore Memory ARN into the three modality-specific runtimes and
# the webhook.
#
# Deploy LAYER ORDER (dependency-aware):
#   1. backend/network                         (wa-network)            VPC, subnets, NAT gateway
#   2. backend/backend-infrastructure          (wa-ddb / wa-location / wa-lambdas / wa-apigw)
#                                               DynamoDB, Location, ordering Lambdas, backend REST API
#                                               NOTE: this single carried-over module keeps the
#                                               telephony 4-stack split verbatim; it is NOT re-architected.
#   3. backend/agentcore-gateway               (wa-gateway)            MCP tools fronting the REST API
#   4. backend/agentcore-memory                (wa-memory)             SHARED AgentCore Memory; emits memory ARN
#                                               MUST deploy before the three runtimes + webhook.
#   5. backend/agentcore-runtime-voice-webrtc  (wa-runtime-call)       Call runtime (gateway URL + memory ARN + network)
#   6. backend/agentcore-runtime-voicenotes    (wa-runtime-voicenotes) VoiceNotes runtime (gateway URL + memory ARN)
#   7. whatsapp-interface/whatsapp-chat-agent  (wa-runtime-chat)       Chat runtime (gateway URL + memory ARN)
#   8. whatsapp-interface/whatsapp-webhook     (wa-webhook)            API GW + webhook Lambda + secrets + window table
#                                               (gateway URL, pepper param, the three runtime ARNs, memory ARN, secret names)
#
# FORWARD-COMPATIBILITY GUARD:
#   Several target modules do NOT EXIST YET - they are implemented by later
#   tasks (memory = Task 2, webhook = Tasks 3-6/9/10, chat = Tasks 7-8,
#   voicenotes = Task 12, call = Tasks 14-19). Every layer is guarded by
#   `module_ready`: if the module directory is missing OR has no synthesizable
#   CDK app (no cdk.json), the script prints a clear
#   "layer not yet implemented, skipping" notice and CONTINUES instead of
#   hard-failing. This lets the script be correct today and light up
#   automatically as each module lands. Upstream outputs that a not-yet-built
#   layer would have produced are read with empty-string defaults so the
#   downstream guards (also not-yet-built) simply skip too.
#
# Cross-stack wiring is by --parameters Stack:Key=value + --outputs-file
# cdk-outputs/<module>.json; no CloudFormation Exports / Fn::ImportValue.
# Each CDK app declares its construct with an UN-prefixed logical id, so
# `cdk deploy <UnprefixedName>` addresses the stack and cdk-outputs/*.json is
# keyed on the same UN-prefixed name. DeploymentPrefix flows in via
# --parameters and is baked into resource names at synth time.
################################################################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source state manager.
# shellcheck source=deployment-state.sh
source "$SCRIPT_DIR/deployment-state.sh"

# Defaults
PROJECT_PREFIX="qsr-wa"
PROJECT_PREFIX_EXPLICIT=false  # set true when --deploymentPrefix is passed
MODE="update"          # update (idempotent) | fresh (clean redeploy)
FORCE_DEPLOY=false
SKIP_PREFLIGHT=false
NO_ROLLBACK=false
ONLY_COMPONENT=""      # empty = deploy all layers; when set, run ONLY that one
LOW_STORAGE_MODE=false # --low-storage-mode: wipe sibling node_modules before each npm install
ASSUME_YES=false       # --yes / --non-interactive: never block on a prompt
OUTPUTS_DIR="cdk-outputs"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploymentPrefix) PROJECT_PREFIX="$2"; PROJECT_PREFIX_EXPLICIT=true; shift 2 ;;
    --mode)             MODE="$2";           shift 2 ;;
    --force-deploy)     FORCE_DEPLOY=true;   shift ;;
    --skip-preflight)   SKIP_PREFLIGHT=true; shift ;;
    --no-rollback)      NO_ROLLBACK=true;    shift ;;
    --only)             ONLY_COMPONENT="$2"; shift 2 ;;
    --low-storage-mode) LOW_STORAGE_MODE=true; shift ;;
    --yes|--non-interactive) ASSUME_YES=true; shift ;;
    --help)
      cat <<'USAGE'
Usage: ./scripts/deploy-all.sh [OPTIONS]

Options:
  --deploymentPrefix <name>   Prefix baked into physical resource names on
                              every new stack. Default: qsr-wa.
                              Must match ^[a-z][a-z0-9-]{1,19}$
                              (1-20 chars, lowercase, start with letter).
                              Threaded via CFN Parameter on every stack.
  --mode <update|fresh>       update (default) = idempotent redeploy.
                              fresh = cleanup-all.sh --force first.
  --force-deploy              Redeploy every layer even if state says done.
  --skip-preflight            Skip scripts/preflight-check.sh.
  --low-storage-mode          Before each `npm install`, wipe the
                              `node_modules/` directory from every OTHER CDK
                              project in this workspace. Keeps disk usage
                              down on constrained environments (e.g.
                              CloudShell's 1 GB home limit) at the cost of
                              re-installing each project's deps on every
                              redeploy. Off by default.
  --no-rollback               Pass `--no-rollback` to every `cdk deploy`.
                              On a failed deploy, resources created so far are
                              KEPT (stack left in UPDATE_FAILED / CREATE_FAILED)
                              instead of being auto-rolled-back. Useful for
                              iterative bring-up debugging. Off by default.
  --only <component>          Deploy ONLY the named component and skip every
                              other layer. Implies --force-deploy for the
                              selected layer. Other layers' outputs are still
                              read from cdk-outputs/*.json to supply upstream
                              CfnParameters. Valid component keys (match
                              .deployment-state.json):
                                wa-network, wa-ddb, wa-location, wa-lambdas,
                                wa-apigw, wa-gateway, wa-memory,
                                wa-runtime-call, wa-runtime-voicenotes,
                                wa-runtime-chat, wa-webhook
                              Example: --only wa-memory
  --yes, --non-interactive    Never block on an interactive prompt. Use in CI
                              or any piped/non-TTY run.
  --help                      Show this help.

Prerequisites:
  - scripts/preflight-check.sh passes (Node >= 24, npm, aws v2, git).
  - AWS credentials and CDK bootstrap in us-east-1.
  - Nova model access granted in Bedrock (preflight probes this).
  - The Meta Business account, WhatsApp Business Account, phone number, and
    Calling API access are a MANUAL prerequisite (Meta + AWS consoles). They
    are required only for live (non-mocked) testing and are NOT checked here.
USAGE
      exit 0 ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      echo "Use --help for usage information." >&2
      exit 1 ;;
  esac
done

print_section() {
  echo ""
  echo -e "${BLUE}===========================================================${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}===========================================================${NC}"
  echo ""
}

print_success() { echo -e "${GREEN}[OK] $1${NC}"; }
print_error()   { echo -e "${RED}[ERROR] $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[INFO] $1${NC}"; }

################################################################################
# Auto-load the operator config written by the WhatsApp setup CLI.
#
# scripts/whatsapp-setup (pre-deploy flow) writes .deploy-tmp/whatsapp-config.env
# with the NON-SECRET Meta identifiers (phone number id, WABA id, app id, prefix).
# The webhook stack needs WHATSAPP_PHONE_NUMBER_ID because replies are sent via
# `POST /{PHONE_NUMBER_ID}/messages`: without it the worker still derives the
# Customer_Id and runs the agent, but it cannot DELIVER the reply (it logs
# "missing PHONE_NUMBER_ID or token"). We source the file here so the operator
# does not have to remember to export it by hand. SECRETS are never in this file
# - the access token / app secret / verify token live only in Secrets Manager
# (also populated by the setup CLI).
################################################################################
WA_CONFIG_ENV="$WORKSPACE_ROOT/.deploy-tmp/whatsapp-config.env"
if [ -f "$WA_CONFIG_ENV" ]; then
  # shellcheck disable=SC1090  # path is runtime-resolved by design
  set -a
  source "$WA_CONFIG_ENV"
  set +a
  print_info "Loaded Meta config from .deploy-tmp/whatsapp-config.env (non-secret identifiers)."
  print_info "  WHATSAPP_PHONE_NUMBER_ID feeds the webhook so the worker can send replies via the Messages API."
  print_info "  (Secrets are NOT here - the access token / app secret / verify token live only in Secrets Manager.)"
fi

################################################################################
# Forward-compatibility guard.
#
# module_ready <relative-dir> - returns 0 when the directory exists AND holds a
# synthesizable CDK app (a cdk.json). Returns 1 otherwise. Modules scheduled
# for later tasks (memory, the three runtimes, the webhook) are absent today;
# this lets each layer skip cleanly with a notice rather than hard-failing.
################################################################################
module_ready() {
  local dir="$WORKSPACE_ROOT/$1"
  [ -d "$dir" ] && [ -f "$dir/cdk.json" ]
}

# notify_not_implemented <component> <relative-dir> <task-hint>
notify_not_implemented() {
  local component="$1" dir="$2" hint="$3"
  print_warning "$component: layer not yet implemented (no CDK app at $dir) - skipping"
  print_info    "This layer lights up automatically when $hint lands its CDK app."
}

################################################################################
# Helper functions (shape carried over from the telephony deploy-all.sh,
# project_dirs list pointed at THIS variant's CDK dirs).
################################################################################

# Run npm install with proper error handling.
safe_npm_install() {
  local current_dir
  current_dir=$(pwd)
  # All CDK app dirs for this variant. Not-yet-built dirs are harmless here:
  # the low-storage sweep only acts on dirs that actually contain node_modules.
  local project_dirs=(
    "backend/network"
    "backend/backend-infrastructure"
    "backend/agentcore-gateway/cdk"
    "backend/agentcore-memory"
    "backend/agentcore-runtime-voice-webrtc/cdk"
    "backend/agentcore-runtime-voicenotes/cdk"
    "whatsapp-interface/whatsapp-chat-agent/cdk"
    "whatsapp-interface/whatsapp-webhook/cdk"
  )

  if [ "$LOW_STORAGE_MODE" = true ]; then
    for dir in "${project_dirs[@]}"; do
      local abs_dir="$WORKSPACE_ROOT/$dir"
      if [ "$abs_dir" != "$current_dir" ] && [ -d "$abs_dir/node_modules" ]; then
        rm -rf "$abs_dir/node_modules"
      fi
    done
  fi

  local output
  local exit_code
  set +e
  output=$(npm install --no-fund --no-audit 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    echo "$output"
    echo ""
    if echo "$output" | grep -q "ENOSPC"; then
      print_error "npm install failed - no disk space left"
      print_info "CloudShell has a 1 GB home directory limit."
      print_info "Re-run with --low-storage-mode to auto-clean sibling node_modules."
      print_info "Or manually: rm -rf ~/*/node_modules ~/.npm/_cacache && npm cache clean --force"
    else
      print_error "npm install failed (exit code $exit_code)"
    fi
    print_info "Directory: $(pwd)"
    exit 1
  fi

  echo "$output" | tail -1

  # Guard against the aws-cdk CLI being too old to read the aws-cdk-lib
  # cloud-assembly schema. Only checks in CDK app dirs (those with aws-cdk-lib).
  assert_cdk_cli_compatible
}

# Fail fast if the locally-resolved aws-cdk CLI cannot read the resolved
# aws-cdk-lib's cloud-assembly schema. aws-cdk (CLI) and aws-cdk-lib use
# DIFFERENT version-number lines, so a naive minor-number compare is
# meaningless. The authoritative signal is the cloud-assembly schema: any real
# command emits "Cloud assembly schema version mismatch" when the CLI is too
# old. We probe with a cheap `cdk ls` and detect that exact error.
assert_cdk_cli_compatible() {
  [ -f node_modules/aws-cdk-lib/package.json ] || return 0   # not a CDK app dir

  local probe
  set +e
  probe=$(npx cdk ls 2>&1)
  set -e
  if echo "$probe" | grep -q "Cloud assembly schema version mismatch"; then
    local lib_ver cli_ver
    lib_ver=$(node -p "require('./node_modules/aws-cdk-lib/package.json').version" 2>/dev/null || echo "?")
    cli_ver=$(npx cdk --version 2>/dev/null | awk '{print $1}' || echo "?")
    print_error "aws-cdk CLI ($cli_ver) cannot read aws-cdk-lib ($lib_ver) cloud-assembly schema in $(pwd)."
    print_error "cdk synth/deploy WILL fail with a schema-version mismatch."
    print_info  "Fix: bump \"aws-cdk\" to track \"aws-cdk-lib\" in this dir's package.json (matching caret"
    print_info  "ranges, e.g. aws-cdk ^2.1125.0 with aws-cdk-lib ^2.257.0), then re-run npm install."
    exit 1
  fi
}

json_val() {
  local file=$1 stack=$2 key=$3 default=${4:-}
  # Missing file - return the default rather than throwing (lets not-yet-built
  # upstream layers leave empty outputs that downstream guards skip on).
  if [ ! -f "$file" ]; then echo "$default"; return; fi
  node -e "const d=JSON.parse(require('fs').readFileSync('$file','utf8')); console.log((d['$stack']||{})['$key']||'$default')"
}

# Helper: extract JSON value from stdin
json_stdin() {
  local key=$1 default=${2:-}
  node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(b)['$key']||'$default')}catch(e){console.log('$default')}})"
}

################################################################################
# Up-front validation
################################################################################

# Auto-heal: if --deploymentPrefix was not passed AND .deployment-state.json
# already records a prefix from a previous run, prefer that prefix over the
# hard-coded "qsr-wa" default. Prevents the operator foot-gun where a bare
# `--only wa-...` run defaults to "qsr-wa" and tries to swap every physical
# resource name on a stack that lives at another prefix.
if [ "$PROJECT_PREFIX_EXPLICIT" = false ] && [ -f "$WORKSPACE_ROOT/.deployment-state.json" ]; then
  STATE_PREFIX=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$WORKSPACE_ROOT/.deployment-state.json', 'utf8'));
      const c = s.components || {};
      for (const k of Object.keys(c)) {
        if (c[k] && c[k].deployed === true && c[k].prefix) { console.log(c[k].prefix); break; }
      }
    } catch { /* state file unreadable - fall through to default */ }
  " 2>/dev/null || true)
  if [ -n "$STATE_PREFIX" ] && [ "$STATE_PREFIX" != "$PROJECT_PREFIX" ]; then
    print_warning "deploymentPrefix not specified; using \"$STATE_PREFIX\" from .deployment-state.json (was default \"$PROJECT_PREFIX\")"
    PROJECT_PREFIX="$STATE_PREFIX"
  fi
fi

# Validate prefix once, up front. Each stack also re-validates via
# CfnParameter.allowedPattern at deploy time.
if ! [[ "$PROJECT_PREFIX" =~ ^[a-z][a-z0-9-]{1,19}$ ]]; then
  print_error "--deploymentPrefix must match ^[a-z][a-z0-9-]{1,19}\$ (1-20 chars, start with letter)"
  exit 2
fi

# Validate --only key against the known component set.
VALID_COMPONENTS="wa-network wa-ddb wa-location wa-lambdas wa-apigw wa-gateway wa-memory wa-runtime-call wa-runtime-voicenotes wa-runtime-chat wa-webhook"
if [ -n "$ONLY_COMPONENT" ]; then
  if ! echo " $VALID_COMPONENTS " | grep -q " $ONLY_COMPONENT "; then
    print_error "--only must be one of: $VALID_COMPONENTS"
    exit 2
  fi
  print_warning "--only $ONLY_COMPONENT - every other layer will be SKIPPED"
  print_info    "Upstream outputs will still be loaded from cdk-outputs/*.json"
fi

# should_deploy <component> - returns 0 when this layer should run, 1 when it
# should be skipped. Encapsulates the three gates:
#   1. --only <X> - run X, skip everything else.
#   2. --force-deploy - re-run every layer that is not skipped by --only.
#   3. Default (idempotent) - skip anything the state file marks as done.
should_deploy() {
  local component="$1"
  if [ -n "$ONLY_COMPONENT" ]; then
    [ "$ONLY_COMPONENT" = "$component" ]
    return
  fi
  if [ "$FORCE_DEPLOY" = true ] || [ "$(is_deployed "$component")" != "true" ]; then
    return 0
  fi
  return 1
}

# Run preflight checks unless skipped.
if [ "$SKIP_PREFLIGHT" = false ]; then
  print_section "Running Preflight Checks"
  "$SCRIPT_DIR/preflight-check.sh" || exit 1
fi

init_state
mkdir -p "$WORKSPACE_ROOT/$OUTPUTS_DIR"

# Handle fresh mode
if [ "$MODE" = "fresh" ]; then
  print_warning "Fresh mode: cleaning up existing deployment"
  "$SCRIPT_DIR/cleanup-all.sh" --force --ignore-missing-resources || true
  rm -f "$STATE_FILE_ABS"
  init_state
fi

print_section "Idempotent Deployment - Mode: $MODE, Prefix: $PROJECT_PREFIX"

# Optional --no-rollback flag threaded into every `cdk deploy` below. Empty
# string when not requested so bash word-splitting drops the argument cleanly.
CDK_ROLLBACK_FLAG=""
if [ "$NO_ROLLBACK" = true ]; then
  CDK_ROLLBACK_FLAG="--no-rollback"
  print_warning "--no-rollback is ON - failed deploys will LEAVE partial resources in place"
  print_info    "Re-run with the same prefix (or run cleanup-all.sh) to clean up"
fi

################################################################################
# Resolve Bedrock AgentCore Runtime-supported AZs (letters) for THIS account.
#
# Bedrock AgentCore Runtime only supports a subset of AZ IDs in each region
# (as of 2026-05 in us-east-1: use1-az1, use1-az2, use1-az4). AZ-ID-to-letter
# mapping is randomized per account. We query the account's AZ mapping, filter
# to the supported IDs, and thread the first two matching zone letters into
# the NetworkStack as the `agentcoreAzs` context value. The three runtimes
# need VPC mode in those AZs (private subnet + NAT gateway for outbound UDP).
#
# If Bedrock expands its AZ support, update BEDROCK_SUPPORTED_AZ_IDS below.
################################################################################
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
  print_error "Could not find 2 Bedrock AgentCore Runtime-supported AZs in us-east-1 for this account."
  print_info  "Expected at least 2 zones mapping to AZ IDs in: $BEDROCK_SUPPORTED_AZ_IDS"
  print_info  "Run: aws ec2 describe-availability-zones --region us-east-1 --query 'AvailabilityZones[].[ZoneName,ZoneId]' --output table"
  print_info  "If Bedrock support has expanded, update BEDROCK_SUPPORTED_AZ_IDS in scripts/deploy-all.sh."
  exit 6
fi

print_info "Bedrock AgentCore-supported AZs in this account: $AGENTCORE_AZS"

################################################################################
# Pre-deploy auto-heal: clear stuck CFN stack states only (working agreement #9).
#
# CFN stacks left in REVIEW_IN_PROGRESS / ROLLBACK_COMPLETE from a prior failed
# CREATE block re-creation - CFN refuses `update-stack` on those statuses, so
# the stack must be deleted first. We do NOT sweep log groups (CDK owns their
# lifecycle with RemovalPolicy.DESTROY on both ends). Not-yet-built stacks are
# simply absent from the account and the describe-stacks probe is a clean no-op.
################################################################################
preflight_stuck_stack_sweep() {
  local stuck_statuses="REVIEW_IN_PROGRESS ROLLBACK_COMPLETE"
  local project_stacks="NetworkStack DynamoDBStack LocationStack LambdaStack \
    ApiGatewayStack AgentCoreGatewayStack MemoryStack VoiceWebrtcStack \
    VoiceNotesStack ChatAgentStack WebhookStack"
  for stack in $project_stacks; do
    local status
    status=$(aws cloudformation describe-stacks --region us-east-1 \
      --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")
    if echo "$stuck_statuses" | grep -qw "$status"; then
      print_warning "Auto-heal: stack '$stack' is in $status, deleting..."
      aws cloudformation delete-stack --region us-east-1 --stack-name "$stack" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name "$stack" 2>/dev/null || true
    fi
  done
}

print_section "Pre-deploy auto-heal sweep"
preflight_stuck_stack_sweep

################################################################################
# Layer 1 - NetworkStack (deployed as ${PROJECT_PREFIX}-NetworkStack resources)
# VPC, public/private subnets, NAT gateway. Independent root layer. The three
# runtimes consume VpcId / PrivateSubnetIds / AgentSecurityGroupId.
################################################################################

print_section "Layer 1: NetworkStack (wa-network)"

if should_deploy wa-network; then
  (
    cd "$WORKSPACE_ROOT/backend/network"
    safe_npm_install
    # shellcheck disable=SC2086  # word-splitting $CDK_ROLLBACK_FLAG is intentional
    npx cdk deploy NetworkStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "agentcoreAzs=${AGENTCORE_AZS}" \
      --parameters "NetworkStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-network.json"
  )
  update_state "wa-network" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-network deployed"
else
  print_info "wa-network already deployed; skipping (use --force-deploy to override)"
fi

VPC_ID=$(json_val         "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-network.json" "NetworkStack" "VpcId")
SUBNETS=$(json_val        "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-network.json" "NetworkStack" "PrivateSubnetIds")
PUBLIC_SUBNETS=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-network.json" "NetworkStack" "PublicSubnetIds")
AGENT_SG=$(json_val       "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-network.json" "NetworkStack" "AgentSecurityGroupId")

if [ -z "$VPC_ID" ] || [ -z "$SUBNETS" ] || [ -z "$AGENT_SG" ]; then
  print_error "Missing VpcId / PrivateSubnetIds / AgentSecurityGroupId from wa-network.json. Aborting."
  exit 5
fi

################################################################################
# Layer 2 - backend-infrastructure (carried over verbatim from telephony).
# This single module keeps its internal 4-stack split: DynamoDBStack ->
# LocationStack -> LambdaStack -> ApiGatewayStack. Tracked as four component
# keys (wa-ddb / wa-location / wa-lambdas / wa-apigw) so each can be
# independently re-deployed with --only.
################################################################################

# ---- Layer 2a: DynamoDBStack ------------------------------------------------
print_section "Layer 2a: DynamoDBStack (wa-ddb)"

if should_deploy wa-ddb; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy DynamoDBStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "DynamoDBStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json"
  )
  update_state "wa-ddb" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-ddb deployed"
else
  print_info "wa-ddb already deployed; skipping (use --force-deploy to override)"
fi

MENU_TABLE=$(json_val      "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json" "DynamoDBStack" "MenuTableName")
CARTS_TABLE=$(json_val     "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json" "DynamoDBStack" "CartsTableName")
ORDERS_TABLE=$(json_val    "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json" "DynamoDBStack" "OrdersTableName")
CUSTOMERS_TABLE=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json" "DynamoDBStack" "CustomersTableName")
LOCATIONS_TABLE=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-ddb.json" "DynamoDBStack" "LocationsTableName")

if [ -z "$MENU_TABLE" ] || [ -z "$CARTS_TABLE" ] || [ -z "$ORDERS_TABLE" ] \
   || [ -z "$CUSTOMERS_TABLE" ] || [ -z "$LOCATIONS_TABLE" ]; then
  print_error "Missing one or more table names from wa-ddb.json. Aborting."
  exit 5
fi

# ---- Layer 2b: LocationStack ------------------------------------------------
print_section "Layer 2b: LocationStack (wa-location)"

if should_deploy wa-location; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy LocationStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "LocationStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-location.json"
  )
  update_state "wa-location" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-location deployed"
else
  print_info "wa-location already deployed; skipping"
fi

PLACE_INDEX=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-location.json" "LocationStack" "PlaceIndexName")
ROUTE_CALC=$(json_val  "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-location.json" "LocationStack" "RouteCalculatorName")

if [ -z "$PLACE_INDEX" ] || [ -z "$ROUTE_CALC" ]; then
  print_error "Missing PlaceIndexName / RouteCalculatorName from wa-location.json. Aborting."
  exit 5
fi

# ---- Layer 2c: LambdaStack --------------------------------------------------
print_section "Layer 2c: LambdaStack (wa-lambdas)"

if should_deploy wa-lambdas; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy LambdaStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "LambdaStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "LambdaStack:MenuTableName=${MENU_TABLE}" \
      --parameters "LambdaStack:CartsTableName=${CARTS_TABLE}" \
      --parameters "LambdaStack:OrdersTableName=${ORDERS_TABLE}" \
      --parameters "LambdaStack:CustomersTableName=${CUSTOMERS_TABLE}" \
      --parameters "LambdaStack:LocationsTableName=${LOCATIONS_TABLE}" \
      --parameters "LambdaStack:PlaceIndexName=${PLACE_INDEX}" \
      --parameters "LambdaStack:RouteCalculatorName=${ROUTE_CALC}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json"
  )
  update_state "wa-lambdas" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-lambdas deployed"
else
  print_info "wa-lambdas already deployed; skipping"
fi

GET_CUSTOMER_PROFILE_ARN=$(json_val      "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GetCustomerProfileLambdaArn")
GET_PREVIOUS_ORDERS_ARN=$(json_val       "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GetPreviousOrdersLambdaArn")
GET_MENU_ARN=$(json_val                  "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GetMenuLambdaArn")
ADD_TO_CART_ARN=$(json_val               "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "AddToCartLambdaArn")
GET_CART_ARN=$(json_val                  "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GetCartLambdaArn")
UPDATE_CART_ARN=$(json_val               "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "UpdateCartLambdaArn")
PLACE_ORDER_ARN=$(json_val               "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "PlaceOrderLambdaArn")
GET_NEAREST_LOCATIONS_ARN=$(json_val     "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GetNearestLocationsLambdaArn")
FIND_LOCATION_ALONG_ROUTE_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "FindLocationAlongRouteLambdaArn")
GEOCODE_ADDRESS_ARN=$(json_val           "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-lambdas.json" "LambdaStack" "GeocodeAddressLambdaArn")

for var_name in GET_CUSTOMER_PROFILE_ARN GET_PREVIOUS_ORDERS_ARN GET_MENU_ARN \
                ADD_TO_CART_ARN GET_CART_ARN UPDATE_CART_ARN PLACE_ORDER_ARN \
                GET_NEAREST_LOCATIONS_ARN FIND_LOCATION_ALONG_ROUTE_ARN \
                GEOCODE_ADDRESS_ARN; do
  if [ -z "${!var_name}" ]; then
    print_error "Missing Lambda ARN $var_name from wa-lambdas.json. Aborting."
    exit 5
  fi
done

# ---- Layer 2d: ApiGatewayStack ----------------------------------------------
print_section "Layer 2d: ApiGatewayStack (wa-apigw)"

if should_deploy wa-apigw; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy ApiGatewayStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "ApiGatewayStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "ApiGatewayStack:GetCustomerProfileLambdaArn=${GET_CUSTOMER_PROFILE_ARN}" \
      --parameters "ApiGatewayStack:GetPreviousOrdersLambdaArn=${GET_PREVIOUS_ORDERS_ARN}" \
      --parameters "ApiGatewayStack:GetMenuLambdaArn=${GET_MENU_ARN}" \
      --parameters "ApiGatewayStack:AddToCartLambdaArn=${ADD_TO_CART_ARN}" \
      --parameters "ApiGatewayStack:GetCartLambdaArn=${GET_CART_ARN}" \
      --parameters "ApiGatewayStack:UpdateCartLambdaArn=${UPDATE_CART_ARN}" \
      --parameters "ApiGatewayStack:PlaceOrderLambdaArn=${PLACE_ORDER_ARN}" \
      --parameters "ApiGatewayStack:GetNearestLocationsLambdaArn=${GET_NEAREST_LOCATIONS_ARN}" \
      --parameters "ApiGatewayStack:FindLocationAlongRouteLambdaArn=${FIND_LOCATION_ALONG_ROUTE_ARN}" \
      --parameters "ApiGatewayStack:GeocodeAddressLambdaArn=${GEOCODE_ADDRESS_ARN}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-apigw.json"
  )
  update_state "wa-apigw" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-apigw deployed"
else
  print_info "wa-apigw already deployed; skipping"
fi

APIGW_ID=$(json_val          "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-apigw.json" "ApiGatewayStack" "ApiGatewayId")
APIGW_URL=$(json_val         "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-apigw.json" "ApiGatewayStack" "ApiGatewayUrl")
APIGW_REST_API_ID=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-apigw.json" "ApiGatewayStack" "ApiGatewayRestApiId")

if [ -z "$APIGW_ID" ] || [ -z "$APIGW_URL" ] || [ -z "$APIGW_REST_API_ID" ]; then
  print_error "Missing ApiGatewayId / ApiGatewayUrl / ApiGatewayRestApiId from wa-apigw.json. Aborting."
  exit 5
fi

################################################################################
# Layer 3 - AgentCoreGatewayStack (wa-gateway). MCP + AWS_IAM gateway fronting
# the backend REST API. GatewayUrl is the PRIMARY handoff into the three
# runtimes downstream.
################################################################################

print_section "Layer 3: AgentCoreGatewayStack (wa-gateway)"

if should_deploy wa-gateway; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-gateway/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy AgentCoreGatewayStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "AgentCoreGatewayStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayId=${APIGW_ID}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayUrl=${APIGW_URL}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayRestApiId=${APIGW_REST_API_ID}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-gateway.json"
  )
  update_state "wa-gateway" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-gateway deployed"
else
  print_info "wa-gateway already deployed; skipping"
fi

GATEWAY_URL=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-gateway.json" "AgentCoreGatewayStack" "GatewayUrl")

if [ -z "$GATEWAY_URL" ]; then
  print_error "Missing GatewayUrl from wa-gateway.json. Aborting."
  exit 5
fi

################################################################################
# Layer 4 - MemoryStack (wa-memory) - SHARED AgentCore Memory. FOUNDATIONAL.
#
# Sequenced EARLY (before the three runtimes + webhook) so its memory ARN
# (CfnOutput, no exportName) threads into every downstream stack as a
# CfnParameter. Implemented by Task 2 - guarded by module_ready until then.
#
# Intended CDK app: backend/agentcore-memory (lib-directly, like network).
# Intended stack id: MemoryStack. Intended output key: MemoryArn.
################################################################################

print_section "Layer 4: MemoryStack (wa-memory)"

if ! module_ready "backend/agentcore-memory"; then
  notify_not_implemented "wa-memory" "backend/agentcore-memory" "Task 2 (shared AgentCore Memory)"
elif should_deploy wa-memory; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-memory"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy MemoryStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "MemoryStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-memory.json"
  )
  update_state "wa-memory" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-memory deployed"
else
  print_info "wa-memory already deployed; skipping"
fi

# Read the shared memory ARN for the three runtimes + webhook. Empty until the
# memory layer exists; the downstream runtime/webhook guards skip when empty.
MEMORY_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-memory.json" "MemoryStack" "MemoryArn")
# The bare memory id (data-plane create_event / retrieve_memory_records use the
# id, not the ARN). Threaded into the webhook worker as SharedMemoryId.
MEMORY_ID=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-memory.json" "MemoryStack" "MemoryId")
if [ -z "$MEMORY_ARN" ]; then
  print_warning "No MemoryArn available yet (wa-memory not deployed). Downstream runtimes/webhook will skip until Task 2 lands."
fi

################################################################################
# Layer 5 - VoiceWebrtcStack (wa-runtime-call) - WhatsApp Call Runtime.
#
# aiortc answerer + PyAV transcode + in-container Nova 2 Sonic, VPC network
# mode. Consumes gateway URL + memory ARN + network (VpcId / PrivateSubnetIds /
# AgentSecurityGroupId). Emits AgentRuntimeArn. Implemented by Tasks 14-19
# (gated on the single-shot ICE spike) - guarded by module_ready until then.
#
# Intended CDK app: backend/agentcore-runtime-voice-webrtc/cdk
# Intended stack id: VoiceWebrtcStack. Intended output key: AgentRuntimeArn.
# NOTE: a later task may split this into ecr/build/runtime sub-apps (as the
# telephony runtime was); when that lands, expand this layer accordingly.
################################################################################

print_section "Layer 5: VoiceWebrtcStack (wa-runtime-call)"

if ! module_ready "backend/agentcore-runtime-voice-webrtc/cdk"; then
  notify_not_implemented "wa-runtime-call" "backend/agentcore-runtime-voice-webrtc/cdk" "Tasks 14-19 (Call runtime)"
elif [ -z "$MEMORY_ARN" ]; then
  print_warning "wa-runtime-call: shared memory ARN not available yet - skipping until wa-memory is deployed"
elif should_deploy wa-runtime-call; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-runtime-voice-webrtc/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy VoiceWebrtcStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "agentcoreAzs=${AGENTCORE_AZS}" \
      --parameters "VoiceWebrtcStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "VoiceWebrtcStack:AgentCoreGatewayUrl=${GATEWAY_URL}" \
      --parameters "VoiceWebrtcStack:MemoryArn=${MEMORY_ARN}" \
      --parameters "VoiceWebrtcStack:VpcId=${VPC_ID}" \
      --parameters "VoiceWebrtcStack:PrivateSubnetIds=${SUBNETS}" \
      --parameters "VoiceWebrtcStack:AgentSecurityGroupId=${AGENT_SG}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-call.json"
  )
  update_state "wa-runtime-call" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-runtime-call deployed"
else
  print_info "wa-runtime-call already deployed; skipping"
fi

CALL_RUNTIME_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-call.json" "VoiceWebrtcStack" "AgentRuntimeArn")

################################################################################
# Layer 6 - VoiceNotesStack (wa-runtime-voicenotes) - WhatsApp VoiceNotes
# Runtime. Bounded Nova 2 Sonic speech-to-speech (OGG Opus in/out). Consumes
# gateway URL + memory ARN + network. Emits AgentRuntimeArn. Implemented by
# Task 12 - guarded by module_ready until then.
#
# Intended CDK app: backend/agentcore-runtime-voicenotes/cdk
# Intended stack id: VoiceNotesStack. Intended output key: AgentRuntimeArn.
################################################################################

print_section "Layer 6: VoiceNotesStack (wa-runtime-voicenotes)"

if ! module_ready "backend/agentcore-runtime-voicenotes/cdk"; then
  notify_not_implemented "wa-runtime-voicenotes" "backend/agentcore-runtime-voicenotes/cdk" "Task 12 (VoiceNotes runtime)"
elif [ -z "$MEMORY_ARN" ]; then
  print_warning "wa-runtime-voicenotes: shared memory ARN not available yet - skipping until wa-memory is deployed"
elif should_deploy wa-runtime-voicenotes; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-runtime-voicenotes/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy VoiceNotesStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "VoiceNotesStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "VoiceNotesStack:AgentCoreGatewayUrl=${GATEWAY_URL}" \
      --parameters "VoiceNotesStack:SharedMemoryArn=${MEMORY_ARN}" \
      --parameters "VoiceNotesStack:AgentCoreAzIds=${AGENTCORE_AZS}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-voicenotes.json"
  )
  update_state "wa-runtime-voicenotes" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-runtime-voicenotes deployed"
else
  print_info "wa-runtime-voicenotes already deployed; skipping"
fi

VOICENOTES_RUNTIME_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-voicenotes.json" "VoiceNotesStack" "VoiceNotesRuntimeArn")

################################################################################
# Layer 7 - ChatAgentStack (wa-runtime-chat) - WhatsApp Chat Runtime.
# Strands + Converse + Nova Pro, multimodal (text + image + file). Consumes
# gateway URL + memory ARN (+ network for VPC mode if configured). Emits
# AgentRuntimeArn. Implemented by Tasks 7-8 - guarded by module_ready.
#
# Intended CDK app: whatsapp-interface/whatsapp-chat-agent/cdk
# Intended stack id: ChatAgentStack. Intended output key: AgentRuntimeArn.
################################################################################

print_section "Layer 7: ChatAgentStack (wa-runtime-chat)"

if ! module_ready "whatsapp-interface/whatsapp-chat-agent/cdk"; then
  notify_not_implemented "wa-runtime-chat" "whatsapp-interface/whatsapp-chat-agent/cdk" "Tasks 7-8 (Chat runtime)"
elif [ -z "$MEMORY_ARN" ]; then
  print_warning "wa-runtime-chat: shared memory ARN not available yet - skipping until wa-memory is deployed"
elif should_deploy wa-runtime-chat; then
  (
    cd "$WORKSPACE_ROOT/whatsapp-interface/whatsapp-chat-agent/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy ChatAgentStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "agentcoreAzs=${AGENTCORE_AZS}" \
      --parameters "ChatAgentStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "ChatAgentStack:AgentCoreGatewayUrl=${GATEWAY_URL}" \
      --parameters "ChatAgentStack:SharedMemoryArn=${MEMORY_ARN}" \
      --parameters "ChatAgentStack:AgentCoreAzIds=${AGENTCORE_AZS}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-chat.json"
  )
  update_state "wa-runtime-chat" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-runtime-chat deployed"
else
  print_info "wa-runtime-chat already deployed; skipping"
fi

CHAT_RUNTIME_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-runtime-chat.json" "ChatAgentStack" "ChatRuntimeArn")

################################################################################
# Layer 8 - WebhookStack (wa-webhook) - WhatsApp ingress + signaling proxy.
# Regional API Gateway (AWS-managed cert) + webhook Lambda + Secrets Manager
# entries + 24-hour window DynamoDB table. Consumes gateway URL, pepper param
# name, the three runtime ARNs, the shared memory ARN, and secret names.
# Emits the webhook URL. Implemented by Tasks 3-6/9/10 - guarded by module_ready.
#
# Intended CDK app: whatsapp-interface/whatsapp-webhook/cdk
# Intended stack id: WebhookStack. Intended output key: WebhookUrl.
################################################################################

# ensure_pepper - create the Customer_Id pepper SSM SecureString once.
#
# No stack creates the pepper: it is owned out-of-band by this script so the
# anonymization key (R8: "wa-" + sha256(E164 || pepper)[:16]) stays STABLE
# across redeploys. We never overwrite an existing value (re-deriving the same
# customer id on every run depends on it). Sets PEPPER_PARAM_NAME on return.
ensure_pepper() {
  local name="/${PROJECT_PREFIX}/customer-id-pepper"
  local existing
  existing=$(aws ssm get-parameter --region us-east-1 --name "$name" \
    --query 'Parameter.Name' --output text 2>/dev/null || echo "")
  if [ -z "$existing" ] || [ "$existing" = "None" ]; then
    local value
    value=$(openssl rand -hex 32)
    aws ssm put-parameter --region us-east-1 \
      --name "$name" \
      --type SecureString \
      --value "$value" \
      --description "Customer_Id pepper for ${PROJECT_PREFIX} WhatsApp webhook (R8 anonymization key)." \
      >/dev/null
    print_success "Created SSM SecureString pepper $name"
  else
    print_info "SSM pepper $name already exists; reusing (value left unchanged)"
  fi
  PEPPER_PARAM_NAME="$name"
}

# populate_meta_secrets - fill the three empty Meta secret containers from env
# vars when present. Idempotent (put-secret-value sets the current version each
# run). A secret whose env var is unset is left empty for out-of-band setup;
# no secret VALUE is ever logged or passed as a CfnParameter.
populate_meta_secrets() {
  local triples=(
    "${PROJECT_PREFIX}-wa-access-token:${WHATSAPP_ACCESS_TOKEN:-}"
    "${PROJECT_PREFIX}-wa-app-secret:${WHATSAPP_APP_SECRET:-}"
    "${PROJECT_PREFIX}-wa-verify-token:${WHATSAPP_VERIFY_TOKEN:-}"
  )
  local triple secret_name secret_value
  for triple in "${triples[@]}"; do
    secret_name="${triple%%:*}"
    secret_value="${triple#*:}"
    if [ -n "$secret_value" ]; then
      if aws secretsmanager put-secret-value --region us-east-1 \
           --secret-id "$secret_name" \
           --secret-string "$secret_value" >/dev/null 2>&1; then
        print_success "Populated secret $secret_name from env var"
      else
        print_warning "Could not populate secret $secret_name (does the stack exist?)"
      fi
    else
      print_info "Secret $secret_name left empty (env var unset); set it out-of-band before live testing"
    fi
  done
}

print_section "Layer 8: WebhookStack (wa-webhook)"

WEBHOOK_URL=""
if ! module_ready "whatsapp-interface/whatsapp-webhook/cdk"; then
  notify_not_implemented "wa-webhook" "whatsapp-interface/whatsapp-webhook/cdk" "Tasks 3-6 (webhook)"
elif [ -z "$MEMORY_ARN" ] || [ -z "$CHAT_RUNTIME_ARN" ]; then
  print_warning "wa-webhook: required upstream identifiers not available yet - skipping"
  print_info    "Needs SharedMemoryArn + ChatRuntimeArn (Phase 1 text channel). The VoiceNotes/Call"
  print_info    "runtime ARNs are optional and stay empty until Tasks 12 / 14-19 land their runtimes."
elif should_deploy wa-webhook; then
  # Ensure the Customer_Id pepper exists and set PEPPER_PARAM_NAME before deploy.
  ensure_pepper
  (
    cd "$WORKSPACE_ROOT/whatsapp-interface/whatsapp-webhook/cdk"
    safe_npm_install
    # Secret containers are created (empty) by this stack; their VALUES are
    # populated below from env vars (or left empty for out-of-band setup). Only
    # logical names flow through CfnParameters - no secret material ever does.
    # VoiceNotes/Call runtime ARNs may be empty in a Phase 1 (text-only) deploy;
    # those CfnParameters default to '' so an empty value synthesizes cleanly.
    # shellcheck disable=SC2086
    npx cdk deploy WebhookStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "enableCallMappingTable=true" \
      --parameters "WebhookStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "WebhookStack:AgentCoreGatewayUrl=${GATEWAY_URL}" \
      --parameters "WebhookStack:PepperParameterName=${PEPPER_PARAM_NAME}" \
      --parameters "WebhookStack:SharedMemoryArn=${MEMORY_ARN}" \
      --parameters "WebhookStack:SharedMemoryId=${MEMORY_ID}" \
      --parameters "WebhookStack:ChatRuntimeArn=${CHAT_RUNTIME_ARN}" \
      --parameters "WebhookStack:VoiceNotesRuntimeArn=${VOICENOTES_RUNTIME_ARN}" \
      --parameters "WebhookStack:CallRuntimeArn=${CALL_RUNTIME_ARN}" \
      --parameters "WebhookStack:PhoneNumberId=${WHATSAPP_PHONE_NUMBER_ID:-}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-webhook.json"
  )
  update_state "wa-webhook" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "wa-webhook deployed"
  # Populate the Meta secret containers from env vars (idempotent; skips unset).
  populate_meta_secrets
else
  print_info "wa-webhook already deployed; skipping"
fi

WEBHOOK_URL=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/wa-webhook.json" "WebhookStack" "WebhookUrl")

################################################################################
# Final status line.
################################################################################

print_section "Deployment summary"

if [ -n "$WEBHOOK_URL" ]; then
  printf 'Your WhatsApp webhook is live at %s - configure it in the Meta App dashboard to test.\n' "$WEBHOOK_URL"
else
  print_info "Backend layers deployed. The webhook endpoint is not live yet because one or more"
  print_info "of the not-yet-implemented layers (memory / runtimes / webhook) was skipped."
  print_info "Re-run this script after the corresponding later tasks land their CDK apps."
fi
