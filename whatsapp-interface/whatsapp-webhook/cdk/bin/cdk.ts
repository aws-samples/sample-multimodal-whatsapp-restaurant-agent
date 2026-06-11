#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'WebhookStack'; the CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-WebhookStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) and the upstream
// identifiers are passed at that time via --parameters - not via context.
new WebhookStack(app, 'WebhookStack', {
  env: { region: 'us-east-1' },
  description:
    'WhatsApp webhook ingress - regional API Gateway + Webhook Handler Lambda + 24-hour window table (R1, R2, R6, R16)',
});

// Apply cdk-nag AwsSolutions checks (R16.5). All findings are either satisfied
// by configuration (access + execution logging, PITR, TLS via execute-api) or
// suppressed with a written justification at the construct/stack level in
// lib/webhook-stack.ts (public webhook authorization, request validation,
// optional WAF, AWS-managed log policies, DynamoDB index wildcard).
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
