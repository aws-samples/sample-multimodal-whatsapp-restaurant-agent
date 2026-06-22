#!/bin/bash

################################################################################
# Deployment State Manager - WhatsApp Restaurant AI Host
#
# Tracks deployment state for idempotent operations.
# Uses Node.js for JSON manipulation (no Python dependency).
#
# Adapted from the telephony repo's deployment-state.sh. The component keys
# track THIS variant's layers (no Chime, no SIP, no PSTN number):
#
#   wa-network              backend/network                       (VPC, subnets, NAT)
#   wa-ddb                  backend/backend-infrastructure        (DynamoDB tables)
#   wa-location             backend/backend-infrastructure        (Location Service)
#   wa-lambdas              backend/backend-infrastructure        (ordering Lambdas)
#   wa-apigw                backend/backend-infrastructure        (backend REST API)
#   wa-gateway              backend/agentcore-gateway             (MCP tools)
#   wa-memory               backend/agentcore-memory              (shared AgentCore Memory)
#   wa-runtime-call         backend/agentcore-runtime-voice-webrtc (Call runtime)
#   wa-runtime-voicenotes   backend/agentcore-runtime-voicenotes  (VoiceNotes runtime)
#   wa-runtime-chat         whatsapp-interface/whatsapp-chat-agent (Chat runtime)
#   wa-webhook              whatsapp-interface/whatsapp-webhook   (API GW + webhook Lambda)
#
# The four wa-ddb / wa-location / wa-lambdas / wa-apigw keys together make up
# the single carried-over "backend-infrastructure" layer; its internal
# stack split is preserved verbatim from the telephony repo and not
# re-architected here.
################################################################################

STATE_FILE=".deployment-state.json"
# Resolve to absolute path so it works from any subdirectory.
# The workspace root is the parent dir of scripts/ - walk one level up.
STATE_FILE_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/$STATE_FILE"

# Initialize state file if it doesn't exist
init_state() {
  if [ ! -f "$STATE_FILE_ABS" ]; then
    cat > "$STATE_FILE_ABS" <<EOF
{
  "version": "1.0",
  "last_updated": "",
  "components": {
    "wa-network": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-ddb": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-location": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-lambdas": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-apigw": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-gateway": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-memory": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-runtime-call": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-runtime-voicenotes": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-runtime-chat": {
      "deployed": false,
      "timestamp": ""
    },
    "wa-webhook": {
      "deployed": false,
      "timestamp": ""
    }
  }
}
EOF
  fi
}

# Update component state
update_state() {
  local component=$1
  local deployed=$2
  local extra_data=$3

  init_state

  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('$STATE_FILE_ABS', 'utf8'));
state.last_updated = '$timestamp';
if (!state.components['$component']) {
  state.components['$component'] = { deployed: false, timestamp: '' };
}
state.components['$component'].deployed = ('$deployed'.toLowerCase() === 'true');
state.components['$component'].timestamp = '$timestamp';
if ('$extra_data') {
  Object.assign(state.components['$component'], JSON.parse('$extra_data'));
}
fs.writeFileSync('$STATE_FILE_ABS', JSON.stringify(state, null, 2));
"
}

# Check if component is deployed
is_deployed() {
  local component=$1

  if [ ! -f "$STATE_FILE_ABS" ]; then
    echo "false"
    return
  fi

  node -e "
try {
  const state = JSON.parse(require('fs').readFileSync('$STATE_FILE_ABS', 'utf8'));
  const c = state.components['$component'];
  console.log((c && c.deployed) ? 'true' : 'false');
} catch(e) { console.log('false'); }
"
}

# Get component data
get_state_data() {
  local component=$1
  local key=$2

  if [ ! -f "$STATE_FILE_ABS" ]; then
    echo ""
    return
  fi

  node -e "
try {
  const state = JSON.parse(require('fs').readFileSync('$STATE_FILE_ABS', 'utf8'));
  console.log(state.components['$component']['$key'] || '');
} catch(e) { console.log(''); }
"
}

# Check if CloudFormation stack exists
stack_exists() {
  local stack_name=$1
  local region=${2:-us-east-1}

  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$region" \
    --query 'Stacks[0].StackName' \
    --output text 2>/dev/null || echo ""
}

# Export functions
export -f init_state
export -f update_state
export -f is_deployed
export -f get_state_data
export -f stack_exists
