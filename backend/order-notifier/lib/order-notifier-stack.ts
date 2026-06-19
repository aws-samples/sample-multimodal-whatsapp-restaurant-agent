import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Order Notifier stack (Task 27) - proactive WhatsApp order-status updates.
 *
 * Two Lambdas, both consuming identifiers from upstream stacks as CfnParameters
 * (no cross-stack reach-in; threaded by scripts/deploy-all.sh):
 *
 *   1. Notifier - triggered by the Orders DynamoDB Stream (DynamoDBStack). On a
 *      status transition into a notify-worthy status (in-preparation, ready) it
 *      sends a free-form WhatsApp update, REUSING the webhook's Reply Delivery
 *      core (imported by the Lambda source). Reads the recipient wa_id from the
 *      webhook's window table. This is the production-realistic piece.
 *
 *   2. Kitchen simulator (DEMO, gated by the `enableKitchenSimulator` context
 *      flag) - a scheduled Lambda standing in for a real kitchen/POS, advancing
 *      order status confirmed -> in-preparation -> ready over ~2 minutes so the
 *      notifier fires end to end. Omit it (flag off) for a real deployment.
 *
 * All CloudFormation-bound strings are ASCII-only and prefixed (P19).
 */
export class OrderNotifierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      default: 'qsr-wa',
      description: 'Prefix applied to every resource/stack name.',
    });
    const prefix = deploymentPrefix.valueAsString;

    const ordersTableName = new cdk.CfnParameter(this, 'OrdersTableName', {
      type: 'String',
      description: 'Orders DynamoDB table name (from DynamoDBStack).',
    });
    const ordersStreamArn = new cdk.CfnParameter(this, 'OrdersStreamArn', {
      type: 'String',
      description: 'Orders DynamoDB Stream ARN (from DynamoDBStack).',
    });
    const windowTableName = new cdk.CfnParameter(this, 'WindowTableName', {
      type: 'String',
      description: 'The 24-hour window table name (from WebhookStack) holding customerId -> waId.',
    });
    const accessTokenSecretName = new cdk.CfnParameter(this, 'AccessTokenSecretName', {
      type: 'String',
      description: 'Secrets Manager secret name holding the WhatsApp Access Token.',
    });
    const phoneNumberId = new cdk.CfnParameter(this, 'PhoneNumberId', {
      type: 'String',
      description: 'WhatsApp Phone Number ID used as the Messages API send path.',
    });

    // Imported Orders table (by name + stream ARN) so the notifier can attach a
    // stream event source. Imported tables are not created/owned by this stack.
    const ordersTable = dynamodb.Table.fromTableAttributes(this, 'OrdersTable', {
      tableName: ordersTableName.valueAsString,
      tableStreamArn: ordersStreamArn.valueAsString,
    });

    // The 24-hour window table (owned by WebhookStack), imported read-only.
    const windowTable = dynamodb.Table.fromTableName(this, 'WindowTable', windowTableName.valueAsString);

    const sharedBundling = {
      format: OutputFormat.ESM,
      externalModules: ['@aws-sdk/*'], // provided by the Node 24 Lambda runtime
      mainFields: ['module', 'main'],
    };

    // Access Token secret ARN (the physical secret has a random 6-char suffix).
    const accessTokenSecretArn = cdk.Arn.format(
      {
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: `${accessTokenSecretName.valueAsString}-*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      this,
    );

    // ----------------- Notifier (stream-triggered) -----------------
    const notifierFn = new NodejsFunction(this, 'NotifierFunction', {
      functionName: cdk.Fn.sub('${P}-wa-order-notifier', { P: prefix }),
      entry: path.join(__dirname, '../lambda/notifier.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: { ...sharedBundling },
      environment: {
        WINDOW_TABLE_NAME: windowTableName.valueAsString,
        ACCESS_TOKEN_SECRET_NAME: accessTokenSecretName.valueAsString,
        PHONE_NUMBER_ID: phoneNumberId.valueAsString,
      },
    });
    // Stream event source: react only to live changes (LATEST), small batches,
    // bounded retries (a notification is not worth poisoning the stream).
    notifierFn.addEventSource(
      new DynamoEventSource(ordersTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
      }),
    );
    windowTable.grantReadData(notifierFn);
    notifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadAccessToken',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [accessTokenSecretArn],
      }),
    );

    // ----------------- Kitchen simulator (DEMO, gated) -----------------
    const enableKitchenSimulator =
      this.node.tryGetContext('enableKitchenSimulator') === true ||
      this.node.tryGetContext('enableKitchenSimulator') === 'true';

    if (enableKitchenSimulator) {
      const kitchenSimFn = new NodejsFunction(this, 'KitchenSimFunction', {
        functionName: cdk.Fn.sub('${P}-wa-kitchen-sim', { P: prefix }),
        entry: path.join(__dirname, '../lambda/kitchen-sim.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        bundling: { ...sharedBundling },
        environment: {
          ORDERS_TABLE_NAME: ordersTableName.valueAsString,
        },
      });
      ordersTable.grantReadWriteData(kitchenSimFn);

      new events.Rule(this, 'KitchenSimSchedule', {
        ruleName: cdk.Fn.sub('${P}-wa-kitchen-sim-schedule', { P: prefix }),
        description: 'Demo kitchen simulator: advance order status every minute (Task 27).',
        schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
        targets: [new targets.LambdaFunction(kitchenSimFn)],
      });

      new cdk.CfnOutput(this, 'KitchenSimFunctionName', {
        value: kitchenSimFn.functionName,
        description: 'Demo kitchen simulator Lambda name',
      });
    }

    new cdk.CfnOutput(this, 'NotifierFunctionName', {
      value: notifierFn.functionName,
      description: 'Order-status notifier Lambda name',
    });
  }
}
