#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { VoiceNotesStack } from '../lib/voicenotes-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'VoiceNotesStack'; the CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-VoiceNotesStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) and the upstream
// identifiers are passed at that time via --parameters - not via context.
new VoiceNotesStack(app, 'VoiceNotesStack', {
  env: { region: 'us-east-1' },
  description:
    'WhatsApp VoiceNotes Runtime - ECR + ARM64 CodeBuild + AgentCore Runtime (bounded Nova 2 Sonic speech-to-speech), shared AgentCore Memory consumer (R7, R17, R18)',
});

// Apply cdk-nag AwsSolutions checks. All findings are either satisfied by
// configuration or suppressed with a written justification at the
// construct/stack level in lib/voicenotes-stack.ts.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
