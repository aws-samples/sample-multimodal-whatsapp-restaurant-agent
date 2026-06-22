import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * {prefix}-WebhookStack - the WhatsApp webhook ingress (async ingest/worker).
 *
 * ASYNC MODEL (Task 3.3, R2.5): Meta requires an HTTP 200 acknowledgement
 * within ~5 s or it re-delivers the event, but the per-message work (media
 * download, runtime inference, reply send) can take longer. So the webhook is
 * split into TWO Lambdas connected by an Amazon SQS queue:
 *
 *   API Gateway -> Ingest Lambda (index.handler): verify (R1) + signature gate
 *     (R2) + enqueue to SQS, then return 200 immediately (R2.5). No slow work.
 *   Inbound SQS queue + DLQ -> Worker Lambda (worker.handler): dispatch (R4/R7),
 *     Customer_Id (R3), 24h window (R6.3), runtime invoke, reply (R12). On an
 *     unhandled error it raises so SQS redelivers; after maxReceiveCount the
 *     message lands in the DLQ.
 *
 * Core resources (design: "Webhook API Gateway", "Webhook Handler Lambdas
 * (async)", "24-hour window table", "Deployment isolation"):
 *  - Regional REST API on Amazon API Gateway (HTTPS, TLS 1.2+, AWS-managed
 *    `execute-api` certificate, no custom domain) with a Lambda PROXY
 *    integration that passes the raw body verbatim (R1, R2.1, R16.1, R16.6).
 *  - The Ingest Lambda (Python) with GET + POST on the webhook path.
 *  - The inbound SQS queue + dead-letter queue (DLQ).
 *  - The Worker Lambda (Python), triggered by the inbound queue.
 *  - The 24-hour window DynamoDB table keyed by `customerId` (R6, R14).
 *  - OPTIONAL: AWS WAF in front of the API and an OPTIONAL call-id mapping
 *    table, both gated behind cdk.json context flags (off by default).
 *
 * Least-privilege split: the Ingest Lambda gets ONLY verify/app-secret read +
 * sqs:SendMessage; the Worker Lambda gets the heavier grants (access-token
 * read, window RW, SSM Pepper + KMS decrypt, AgentCore runtime invoke).
 *
 * Secrets (R11): this stack CREATES three EMPTY Secrets Manager containers with
 * deterministic deployment-prefixed names; the operator populates the values
 * out-of-band (the deploy-all.sh / setup-CLI pattern). No secret VALUE is ever
 * a CfnParameter, a CfnOutput, or a synthesized-template env var.
 *
 * ASCII-only in every CloudFormation-bound string (working agreement #7).
 */
export class WebhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ----------------- CfnParameter: DeploymentPrefix -----------------
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
      description:
        'Deployment prefix applied to every physical resource and IAM ARN in this stack (R17.1).',
    });
    const prefix = deploymentPrefix.valueAsString;

    // ----------------- CfnParameters: upstream identifiers -----------------
    const agentCoreGatewayUrl = new cdk.CfnParameter(this, 'AgentCoreGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'AgentCore Gateway MCP URL (from the gateway stack output). Carried to the Worker Lambda as an environment identifier.',
    });

    const pepperParameterName = new cdk.CfnParameter(this, 'PepperParameterName', {
      type: 'String',
      minLength: 1,
      description:
        'SSM Parameter Store name of the shared Pepper SecureString (the NAME only, never the value). Worker read access is scoped to this one parameter.',
    });

    const chatRuntimeArn = new cdk.CfnParameter(this, 'ChatRuntimeArn', {
      type: 'String',
      minLength: 1,
      description:
        'AgentCore Runtime ARN of the WhatsApp Chat Runtime (from the chat-agent stack output).',
    });

    // VoiceNotes + Call runtime ARNs are OPTIONAL (default empty) so the text
    // channel can deploy in Phase 1 before those runtimes exist. The worker only
    // logs audio/calls events until Tasks 12/17 wire those runtimes in; an empty
    // ARN simply means that branch is not yet invokable.
    const voiceNotesRuntimeArn = new cdk.CfnParameter(this, 'VoiceNotesRuntimeArn', {
      type: 'String',
      default: '',
      description:
        'AgentCore Runtime ARN of the WhatsApp VoiceNotes Runtime (from the voicenotes stack output). Empty until Task 12.',
    });

    const callRuntimeArn = new cdk.CfnParameter(this, 'CallRuntimeArn', {
      type: 'String',
      default: '',
      description:
        'AgentCore Runtime ARN of the WhatsApp Call Runtime (from the voice-webrtc stack output). Empty until Tasks 15-19.',
    });

    const sharedMemoryArn = new cdk.CfnParameter(this, 'SharedMemoryArn', {
      type: 'String',
      minLength: 1,
      description:
        'Shared AgentCore Memory ARN (from the agentcore-memory stack output), consumed by all three runtimes (R18.1).',
    });

    // The bare memory id (data-plane calls use the id, not the ARN). Threaded so
    // the runtimes resolve WA_MEMORY_ID without parsing the ARN. Defaulted empty
    // so the stack synthesizes before the memory stack output is wired.
    const sharedMemoryId = new cdk.CfnParameter(this, 'SharedMemoryId', {
      type: 'String',
      default: '',
      description:
        'Shared AgentCore Memory id (from the agentcore-memory stack output). The id (not the ARN) is what the data-plane create_event / retrieve_memory_records calls use.',
    });

    // The Meta Phone Number ID (non-secret config). Used to address
    // POST /<PHONE_NUMBER_ID>/messages for replies and /calls actions. Threaded
    // by deploy-all.sh via --phone-number-id. Defaulted empty so synth succeeds
    // before the operator supplies it.
    const phoneNumberId = new cdk.CfnParameter(this, 'PhoneNumberId', {
      type: 'String',
      default: '',
      description:
        'Meta WhatsApp Phone Number ID (non-secret). Used by the Worker Lambda to send replies via the Messages API.',
    });

    // Prefixed physical names (rendered at deploy time via Fn::Sub).
    const windowTableName = cdk.Fn.sub('${P}-wa-window', { P: prefix });
    const callMapTableName = cdk.Fn.sub('${P}-wa-call-map', { P: prefix });
    const ingestFunctionName = cdk.Fn.sub('${P}-wa-webhook-ingest', { P: prefix });
    const ingestRoleName = cdk.Fn.sub('${P}-wa-webhook-ingest-role', { P: prefix });
    const workerFunctionName = cdk.Fn.sub('${P}-wa-webhook-worker', { P: prefix });
    const workerRoleName = cdk.Fn.sub('${P}-wa-webhook-worker-role', { P: prefix });
    // Sender Lambda (Option C): the AgentCore runtimes invoke this by a
    // DETERMINISTIC name so their IAM grant + SENDER_LAMBDA_ARN env can be
    // constructed from the shared DeploymentPrefix with NO cross-stack import
    // (the webhook stack deploys after the runtimes; a deterministic name keeps
    // the dependency one-way and ordering-agnostic).
    const senderFunctionName = cdk.Fn.sub('${P}-wa-sender', { P: prefix });
    const senderRoleName = cdk.Fn.sub('${P}-wa-sender-role', { P: prefix });
    const apiName = cdk.Fn.sub('${P}-wa-webhook-api', { P: prefix });
    const queueName = cdk.Fn.sub('${P}-wa-inbound', { P: prefix });
    const dlqName = cdk.Fn.sub('${P}-wa-inbound-dlq', { P: prefix });

    // Secrets Manager container NAMES (NOT values).
    const accessTokenSecretName = cdk.Fn.sub('${P}-wa-access-token', { P: prefix });
    const appSecretSecretName = cdk.Fn.sub('${P}-wa-app-secret', { P: prefix });
    const verifyTokenSecretName = cdk.Fn.sub('${P}-wa-verify-token', { P: prefix });

    // ----------------- 24-hour window table (R6, R14) -----------------
    const windowTable = new dynamodb.Table(this, 'WindowTable', {
      tableName: windowTableName,
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ----------------- OPTIONAL call-id mapping table -----------------
    const enableCallMappingTable =
      this.node.tryGetContext('enableCallMappingTable') === true ||
      this.node.tryGetContext('enableCallMappingTable') === 'true';

    let callMapTable: dynamodb.Table | undefined;
    if (enableCallMappingTable) {
      callMapTable = new dynamodb.Table(this, 'CallMapTable', {
        tableName: callMapTableName,
        partitionKey: { name: 'metaCallId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl',
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // ----------------- Secrets Manager containers (R11.1, R11.3) -----------
    const accessTokenSecret = new secretsmanager.CfnSecret(this, 'AccessTokenSecret', {
      name: accessTokenSecretName,
      description:
        'Meta WhatsApp Access_Token (Messages API send + Media API Bearer). Empty container; operator sets the value out-of-band (R11.1).',
    });
    const appSecretSecret = new secretsmanager.CfnSecret(this, 'AppSecretSecret', {
      name: appSecretSecretName,
      description:
        'Meta App_Secret used for the HMAC-SHA256 webhook signature gate (R2). Empty container; operator sets the value out-of-band (R11.3).',
    });
    const verifyTokenSecret = new secretsmanager.CfnSecret(this, 'VerifyTokenSecret', {
      name: verifyTokenSecretName,
      description:
        'Meta Verify_Token used for the webhook subscription handshake (R1). Empty container; operator sets the value out-of-band (R11.3).',
    });

    // The Ingest Lambda reads verify + app secret; the Worker reads the access
    // token. Scoped to exact ARNs (CfnSecret.ref resolves to the secret ARN).
    const ingestSecretArns = [verifyTokenSecret.ref, appSecretSecret.ref];
    const workerSecretArns = [accessTokenSecret.ref];

    // ----------------- Inbound SQS queue + DLQ (R2.5) -----------------
    // The DLQ isolates poison messages after maxReceiveCount redeliveries. SSE
    // with the SQS-managed key; TLS enforced on both queues. The worker's SQS
    // event-source visibility timeout must be >= the worker function timeout.
    const WORKER_TIMEOUT_SECONDS = 60;
    const dlq = new sqs.Queue(this, 'InboundDlq', {
      queueName: dlqName,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const inboundQueue = new sqs.Queue(this, 'InboundQueue', {
      queueName: queueName,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(WORKER_TIMEOUT_SECONDS * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ----------------- Ingest Lambda (API Gateway proxy) -----------------
    const ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${FN}', { FN: ingestFunctionName }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ingestRole = new iam.Role(this, 'IngestRole', {
      roleName: ingestRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the WhatsApp Webhook Ingest Lambda (verify + signature gate + enqueue).',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    const ingestFunction = new NodejsFunction(this, 'IngestFunction', {
      entry: path.join(__dirname, '../lambda/webhook-handler/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: ingestFunctionName,
      role: ingestRole,
      logGroup: ingestLogGroup,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description:
        'WhatsApp Webhook Ingest - verify (R1), signature gate (R2), enqueue to SQS, fast 200 (R2.5).',
      bundling: {
        format: OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // provided by the Node 24 Lambda runtime
      },
      environment: {
        VERIFY_TOKEN_SECRET_NAME: verifyTokenSecretName,
        APP_SECRET_SECRET_NAME: appSecretSecretName,
        INBOUND_QUEUE_URL: inboundQueue.queueUrl,
      },
    });
    // Ingest IAM: read ONLY verify + app secret; send to the inbound queue.
    ingestRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadVerifyAndAppSecrets',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: ingestSecretArns,
      }),
    );
    inboundQueue.grantSendMessages(ingestFunction);

    // ----------------- Worker Lambda (SQS-triggered) -----------------
    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${FN}', { FN: workerFunctionName }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const workerRole = new iam.Role(this, 'WorkerRole', {
      roleName: workerRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the WhatsApp Webhook Worker Lambda (dispatch, Customer_Id, window, runtime invoke, reply).',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    const workerFunction = new NodejsFunction(this, 'WorkerFunction', {
      entry: path.join(__dirname, '../lambda/webhook-handler/worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: workerFunctionName,
      role: workerRole,
      logGroup: workerLogGroup,
      timeout: cdk.Duration.seconds(WORKER_TIMEOUT_SECONDS),
      memorySize: 512,
      description:
        'WhatsApp Webhook Worker - SQS-triggered dispatch, Customer_Id, window, runtime invoke, reply (R3-R8, R12).',
      bundling: {
        format: OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // provided by the Node 24 Lambda runtime
      },
      environment: {
        // Identifiers only - never secret values (R11.6).
        WINDOW_TABLE_NAME: windowTable.tableName,
        AGENTCORE_GATEWAY_URL: agentCoreGatewayUrl.valueAsString,
        CHAT_RUNTIME_ARN: chatRuntimeArn.valueAsString,
        VOICENOTES_RUNTIME_ARN: voiceNotesRuntimeArn.valueAsString,
        CALL_RUNTIME_ARN: callRuntimeArn.valueAsString,
        SHARED_MEMORY_ARN: sharedMemoryArn.valueAsString,
        WA_MEMORY_ID: sharedMemoryId.valueAsString,
        PEPPER_PARAM_NAME: pepperParameterName.valueAsString,
        ACCESS_TOKEN_SECRET_NAME: accessTokenSecretName,
        PHONE_NUMBER_ID: phoneNumberId.valueAsString,
        ...(callMapTable ? { CALL_MAPPING_TABLE_NAME: callMapTable.tableName } : {}),
      },
    });
    workerFunction.addEventSource(
      new SqsEventSource(inboundQueue, { batchSize: 1, reportBatchItemFailures: true }),
    );

    // Worker IAM: window RW, access-token read, SSM Pepper read + KMS decrypt,
    // AgentCore runtime invoke (scoped to the three runtime ARNs).
    windowTable.grantReadWriteData(workerFunction);
    if (callMapTable) {
      callMapTable.grantReadWriteData(workerFunction);
    }
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadAccessTokenSecret',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: workerSecretArns,
      }),
    );
    const pepperParameterArn = cdk.Fn.sub(
      'arn:${Partition}:ssm:${Region}:${Account}:parameter${Name}',
      {
        Partition: cdk.Aws.PARTITION,
        Region: cdk.Aws.REGION,
        Account: cdk.Aws.ACCOUNT_ID,
        Name: pepperParameterName.valueAsString,
      },
    );
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCustomerIdPepperFromSSM',
        actions: ['ssm:GetParameter'],
        resources: [pepperParameterArn],
      }),
    );
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptPepperViaSSM',
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': cdk.Fn.sub('ssm.${R}.amazonaws.com', { R: cdk.Aws.REGION }),
          },
        },
      }),
    );
    // AgentCore runtime invoke. Scoped to AgentCore runtimes in THIS
    // account/region. A `runtime/*` wildcard (rather than the three exact ARNs)
    // is used because the VoiceNotes/Call runtime ARNs are optional/empty in a
    // Phase 1 text-only deploy - enumerating empty ARNs would be an invalid IAM
    // resource. The scope is still account+region bounded (documented IAM5).
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeAgentRuntimes',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          cdk.Fn.sub('arn:${Partition}:bedrock-agentcore:${R}:${A}:runtime/*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // ----------------- Sender Lambda (Option C, runtime-invoked) -----------
    // The chat / voicenotes runtimes invoke this to send WhatsApp messages as
    // they are produced (interim narration + final answer), resolving the
    // recipient wa_id from the window table and reusing the shared delivery
    // path. This keeps the Access_Token AND the recipient phone (PII) in the
    // Lambda tier - the runtime only ever passes { customer_id, text }.
    const senderLogGroup = new logs.LogGroup(this, 'SenderLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${FN}', { FN: senderFunctionName }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const senderRole = new iam.Role(this, 'SenderRole', {
      roleName: senderRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the WhatsApp Sender Lambda (resolve recipient, send reply). Invoked by the AgentCore runtimes.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    const senderFunction = new NodejsFunction(this, 'SenderFunction', {
      entry: path.join(__dirname, '../lambda/webhook-handler/sender.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: senderFunctionName,
      role: senderRole,
      logGroup: senderLogGroup,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'WhatsApp Sender - runtime-invoked message delivery (resolve wa_id from the window table, send via the shared delivery path).',
      bundling: {
        format: OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // provided by the Node 24 Lambda runtime
      },
      environment: {
        // Identifiers only - never secret values (R11.6).
        WINDOW_TABLE_NAME: windowTable.tableName,
        ACCESS_TOKEN_SECRET_NAME: accessTokenSecretName,
        PHONE_NUMBER_ID: phoneNumberId.valueAsString,
      },
    });
    // Sender IAM: window READ (resolve wa_id) + access-token read only. No
    // window write, no runtime invoke, no SSM/pepper - strictly a subset of the
    // worker's grants.
    windowTable.grantReadData(senderFunction);
    senderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadAccessTokenSecret',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: workerSecretArns,
      }),
    );

    // Meta credentials are rotated in the Meta dashboard, not by AWS, so SMG4
    // (automatic rotation) is not applicable to these empty containers.
    NagSuppressions.addResourceSuppressions(
      [accessTokenSecret, appSecretSecret, verifyTokenSecret],
      [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'These secrets hold Meta-issued credentials rotated in the Meta App dashboard, not by AWS. Automatic rotation is not applicable: no rotation Lambda can mint a new Meta credential. Containers are created empty and the operator sets the value out-of-band via put-secret-value (R11.1, R11.3).',
        },
      ],
    );

    // The DLQ is itself a dead-letter target, so it has no further DLQ.
    NagSuppressions.addResourceSuppressions(dlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason:
          'This queue IS the dead-letter queue for the inbound queue; a DLQ does not itself require a further DLQ.',
      },
    ]);

    // ----------------- Regional REST API (HTTPS, TLS 1.2+) -----------------
    const accessLogGroup = new logs.LogGroup(this, 'WebhookApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: apiName,
      description:
        'WhatsApp webhook ingress - GET verification and POST events. Public endpoint locked by HMAC signature, not by IP (R16).',
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      cloudWatchRole: true,
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
    });

    // Lambda PROXY integration so the raw body reaches the Ingest Lambda
    // verbatim - the HMAC is computed over the exact bytes Meta signed (R2.1).
    const proxyIntegration = new apigateway.LambdaIntegration(ingestFunction, { proxy: true });
    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod('GET', proxyIntegration);
    webhookResource.addMethod('POST', proxyIntegration);

    // ----------------- OPTIONAL AWS WAF -----------------
    const enableWaf =
      this.node.tryGetContext('enableWaf') === true ||
      this.node.tryGetContext('enableWaf') === 'true';

    if (enableWaf) {
      const webAcl = new wafv2.CfnWebACL(this, 'WebhookWebAcl', {
        name: cdk.Fn.sub('${P}-wa-webhook-waf', { P: prefix }),
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        description:
          'WAF for the WhatsApp webhook API - rate limiting and AWS managed common rules (defense in depth).',
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: cdk.Fn.sub('${P}-wa-webhook-waf', { P: prefix }),
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'RateLimit',
            priority: 0,
            action: { block: {} },
            statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'RateLimit',
              sampledRequestsEnabled: true,
            },
          },
          {
            name: 'CommonRuleSet',
            priority: 1,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'CommonRuleSet',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      new wafv2.CfnWebACLAssociation(this, 'WebhookWebAclAssociation', {
        resourceArn: cdk.Fn.sub(
          'arn:${Partition}:apigateway:${Region}::/restapis/${ApiId}/stages/${Stage}',
          {
            Partition: cdk.Aws.PARTITION,
            Region: cdk.Aws.REGION,
            ApiId: api.restApiId,
            Stage: api.deploymentStage.stageName,
          },
        ),
        webAclArn: webAcl.attrArn,
      });
    }

    // ----------------- cdk-nag per-construct suppressions -----------------
    NagSuppressions.addResourceSuppressions(
      api,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'The WhatsApp webhook is a public endpoint that Meta calls directly; Meta does not present IAM or Cognito credentials. Authentication is application-layer: the HMAC-SHA256 signature gate (R2) rejects anything not signed by Meta before any side effect (R16.3). The GET verification handshake is the Meta-required bootstrap.',
        },
        {
          id: 'AwsSolutions-COG4',
          reason:
            'No Cognito user pool is applicable to a Meta-originated webhook. Trust is the HMAC signature gate over the raw body (R2, R16.3), not a user pool authorizer.',
        },
        {
          id: 'AwsSolutions-APIG2',
          reason:
            'Request validation is intentionally not applied: the Lambda proxy integration must pass the raw body verbatim so the Ingest Lambda computes the HMAC over the exact bytes Meta signed (R2.1).',
        },
      ],
      true,
    );

    if (!enableWaf) {
      NagSuppressions.addResourceSuppressions(
        api,
        [
          {
            id: 'AwsSolutions-APIG3',
            reason:
              'AWS WAF is optional defense in depth for this webhook. The primary control is the HMAC-SHA256 signature gate over the raw body (R2, R16.3). Enable per deployment with `-c enableWaf=true`.',
          },
        ],
        true,
      );
    }

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole (ingest + worker roles) and AmazonAPIGatewayPushToCloudWatchLogs (the CDK-created API Gateway account CloudWatch role) grant only CloudWatch Logs write - minimal-privilege AWS-managed policies that are not user-modifiable.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Scoped, documented wildcards on the worker role: (1) the 24-hour window table read/write resolves to the table ARN plus the DynamoDB-required `table/index/*` suffix, scoped to a table this stack owns; (2) kms:Decrypt uses `*` because the AWS-managed `aws/ssm` key ARN is unknown at synth time, narrowed by a `kms:ViaService = ssm.<region>.amazonaws.com` condition; (3) bedrock-agentcore:InvokeAgentRuntime is scoped to `runtime/*` in this account+region (the three runtime ARNs are threaded as CfnParameters and the VoiceNotes/Call ones are optional/empty in a Phase 1 deploy, so an exact-ARN list would risk an invalid empty resource). Secret and ssm:GetParameter statements use exact ARNs. The CDK SqsEventSource grants the worker scoped sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes on the one inbound queue.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Both Lambdas pin Runtime.NODEJS_24_X, the latest GA Node.js runtime (NodejsFunction / esbuild bundling, @aws-sdk external as it is provided by the runtime). cdk-nag bundles a runtime table that lags new GA releases; the repo posture is to pin the latest runtime and suppress this transient finding.',
      },
    ]);

    // ----------------- Outputs (NO exportName per the isolated-app rule) ----
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: api.urlForPath('/webhook'),
      description:
        'WhatsApp webhook invoke URL (configure this as the Meta callback URL). No exportName per the isolated-app rule.',
    });
    new cdk.CfnOutput(this, 'WebhookApiId', {
      value: api.restApiId,
      description: 'Webhook REST API id.',
    });
    new cdk.CfnOutput(this, 'WindowTableName', {
      value: windowTable.tableName,
      description: 'Name of the 24-hour window DynamoDB table.',
    });
    new cdk.CfnOutput(this, 'InboundQueueUrl', {
      value: inboundQueue.queueUrl,
      description: 'URL of the inbound SQS queue between ingest and worker.',
    });
    new cdk.CfnOutput(this, 'InboundDlqUrl', {
      value: dlq.queueUrl,
      description: 'URL of the inbound dead-letter queue (poison messages).',
    });
    new cdk.CfnOutput(this, 'IngestFunctionName', {
      value: ingestFunction.functionName,
      description: 'Name of the Webhook Ingest Lambda function.',
    });
    new cdk.CfnOutput(this, 'WorkerFunctionName', {
      value: workerFunction.functionName,
      description: 'Name of the Webhook Worker Lambda function.',
    });
    new cdk.CfnOutput(this, 'SenderFunctionName', {
      value: senderFunction.functionName,
      description:
        'Name of the WhatsApp Sender Lambda (runtime-invoked delivery). The runtimes construct this ARN from the shared DeploymentPrefix.',
    });
    if (callMapTable) {
      new cdk.CfnOutput(this, 'CallMapTableName', {
        value: callMapTable.tableName,
        description: 'Name of the optional call-id mapping DynamoDB table.',
      });
    }

    cdk.Tags.of(this).add('DeploymentPrefix', prefix);
    cdk.Tags.of(this).add('Feature', 'whatsapp-restaurant-ai-host');
  }
}
