#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ChatAgentStack } from '../lib/chat-agent-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'ChatAgentStack'; the CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-ChatAgentStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) and the upstream
// identifiers are passed at that time via --parameters - not via context.
new ChatAgentStack(app, 'ChatAgentStack', {
  env: { region: 'us-east-1' },
  description:
    'WhatsApp Chat Runtime - ECR + ARM64 CodeBuild + AgentCore Runtime (Strands + Converse + Nova Pro), shared AgentCore Memory consumer (R4, R17, R18)',
});

// Apply cdk-nag AwsSolutions checks. All findings are either satisfied by
// configuration or suppressed with a written justification at the
// construct/stack level in lib/chat-agent-stack.ts.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
