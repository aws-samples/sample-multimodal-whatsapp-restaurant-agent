#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { VoiceWebrtcStack } from '../lib/voice-webrtc-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'VoiceWebrtcStack'; the CloudFormation stack name is set
// at deploy time by scripts/deploy-all.sh via `cdk deploy VoiceWebrtcStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) and the upstream
// identifiers (gateway URL, memory ARN, VPC/subnets/SG) are passed at that time
// via --parameters - not via context.
new VoiceWebrtcStack(app, 'VoiceWebrtcStack', {
  env: { region: 'us-east-1' },
  description:
    'WhatsApp Call Runtime - ECR + ARM64 CodeBuild + AgentCore Runtime (aiortc WebRTC answerer over KVS managed TURN), VPC network mode, KVS signaling channel, shared AgentCore Memory consumer (R8, R17, R18)',
});

// Apply cdk-nag AwsSolutions checks. All findings are either satisfied by
// configuration or suppressed with a written justification at the
// construct/stack level in lib/voice-webrtc-stack.ts.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
