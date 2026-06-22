#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { OrderNotifierStack } from '../lib/order-notifier-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the absence
// of this tag as implicit consent to delete. Applied to every CDK app in this
// workspace - see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'OrderNotifierStack'; the CloudFormation stack name +
// CfnParameters (Orders table/stream, window table, access-token secret name,
// phone number id) are passed at deploy time by scripts/deploy-all.sh via
// --parameters - not via context.
const stack = new OrderNotifierStack(app, 'OrderNotifierStack', {
  env: { region: 'us-east-1' },
  description:
    'WhatsApp Order Notifier (Task 27) - DynamoDB-Streams-triggered proactive order-status updates + an optional demo kitchen simulator. Reuses the webhook Reply Delivery core.',
});

// Apply cdk-nag AwsSolutions checks (R16.5).
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ----------------- cdk-nag suppressions (with written justification) --------
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Scoped, documented wildcards: (1) the GetSecretValue statement targets the Access Token secret ARN with the AWS-mandated 6-char random suffix wildcard (secret:<name>-*), scoped to exactly that one secret; (2) DynamoDB read grants on the imported window table and the imported Orders table (stream read + the kitchen-sim read/write) resolve to the table ARN plus the DynamoDB-required table/index/stream/* suffix, scoped to tables owned by upstream stacks in this account+region. No broader actions are granted.',
  },
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'The Lambda execution roles use the AWS-managed AWSLambdaBasicExecutionRole for CloudWatch Logs only; all data-plane permissions (DynamoDB, Secrets Manager) are scoped customer-managed statements.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Both Lambdas pin Runtime.NODEJS_24_X, the latest GA Node.js runtime (NodejsFunction / esbuild bundling, @aws-sdk external as it is provided by the runtime). cdk-nag bundles a runtime table that lags new GA releases; the repo posture is to pin the latest runtime and suppress this transient finding.',
  },
]);
