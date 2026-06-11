#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { MemoryStack } from '../lib/memory-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'MemoryStack'; the CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-MemoryStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) is passed at that
// time via --parameters - not via context.
const stack = new MemoryStack(app, 'MemoryStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks (R16.5).
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ----------------- cdk-nag suppressions (with written justification) --------
//
// AwsSolutions-IAM5 - the memory execution role needs InvokeModel on the
// foundation-model and inference-profile wildcard because the consolidation
// strategy model id is account/region resolved at deploy time and AgentCore
// may consolidate with more than one model. Scoped to Bedrock model-invoke in
// this region only; no data-plane or admin actions are granted by the wildcard.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Memory execution role InvokeModel is scoped to Bedrock foundation-model and inference-profile ARNs in this region only. The specific consolidation model id is resolved by AgentCore at runtime, so a model-level wildcard is required; no broader actions are granted.',
  },
]);
