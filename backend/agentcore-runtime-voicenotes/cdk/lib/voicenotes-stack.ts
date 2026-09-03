import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { buildspec } from './buildspec';

/**
 * {prefix}-VoiceNotesStack - the WhatsApp VoiceNotes Runtime (Task 12.1).
 *
 * One self-contained CDK app that provisions, in a single stack, the complete
 * build-and-host pipeline for the bounded speech-to-speech VoiceNotes Runtime:
 *
 *   1. ECR repository      `{prefix}-wa-voicenotes-agent` - holds the ARM64 image.
 *   2. S3 source bucket    + BucketDeployment of the sibling `agent/` dir.
 *   3. CodeBuild project   `{prefix}-wa-vn-agent-build` - ARM64 Docker build
 *      (`docker buildx --platform=linux/arm64`), push to ECR. AgentCore Runtime
 *      requires ARM64 images.
 *   4. Build waiter        - a Provider-backed custom resource that StartBuilds
 *      the project on deploy and blocks until SUCCEEDED, so the image exists in
 *      ECR before the AgentCore Runtime resource is created.
 *   5. AgentCore Runtime   `AWS::BedrockAgentCore::Runtime` (the WhatsApp
 *      VoiceNotes Runtime), default/managed (PUBLIC) network mode.
 *
 * Structure mirrors the Chat Runtime stack (whatsapp-chat-agent) - the same
 * single-stack ECR + ARM64 CodeBuild + build-waiter + AgentCore Runtime
 * pipeline. The TWO meaningful differences are:
 *
 *   1. MODEL ACCESS: the VoiceNotes Runtime runs a bounded Amazon Nova 2 Sonic
 *      speech-to-speech session per voice note, so its runtime role is granted
 *      `bedrock:InvokeModelWithBidirectionalStream` scoped to the
 *      `amazon.nova-2-sonic*` model family - NOT the Converse InvokeModel*
 *      actions the Chat Runtime uses. (Task 12.1.)
 *
 *   2. (No other difference.) Network mode is the SAME default/managed (PUBLIC)
 *      mode as the Chat Runtime.
 *
 * Network mode (design "Architecture - target-architecture diagram"): the
 * VoiceNotes Runtime sits in the messaging plane ALONGSIDE the Chat Runtime,
 * NOT in the VPC-only voice/media plane. The VPC network mode exists solely for
 * the Call Runtime's outbound-UDP-to-TURN media need (design: "VPC network
 * mode, outbound UDP only"). The VoiceNotes Runtime has no UDP / TURN / WebRTC
 * path: it is a request/response runtime (Ogg Opus bytes in, Ogg Opus bytes
 * out) whose Nova 2 Sonic bidirectional stream is HTTPS/HTTP2 to Bedrock, not
 * UDP. So managed (PUBLIC) mode is correct and avoids provisioning a VPC/NAT it
 * would never use. Its only outbound traffic is HTTPS to AWS service APIs
 * (Bedrock bidirectional stream, CloudWatch, the AgentCore Gateway, the shared
 * AgentCore Memory).
 *
 * Wiring (isolated-app pattern, R17.2): no CloudFormation Exports / ImportValue.
 *  - INPUT  CfnParameters: DeploymentPrefix, AgentCoreGatewayUrl, SharedMemoryArn,
 *    and AgentCoreAzIds (the shared AZ-resolution contract - see below).
 *  - OUTPUT CfnOutputs (NO exportName): VoiceNotesRuntimeArn (consumed by the
 *    webhook stack as VoiceNotesRuntimeArn), VoiceNotesAgentEcrRepoUri, plus
 *    build/AZ observability.
 *
 * ASCII-only in every CloudFormation-bound string (working agreement #7): use
 * `->` rather than an em-dash, no smart quotes, no non-breaking spaces.
 */
export class VoiceNotesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ----------------- CfnParameter: DeploymentPrefix -----------------
    // Regex/constraint duplicated per stack so each CDK app is independently
    // deployable without a shared helper module (isolated-app pattern).
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
    // Threaded by scripts/deploy-all.sh from the upstream cdk-outputs files.
    const agentCoreGatewayUrl = new cdk.CfnParameter(this, 'AgentCoreGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'AgentCore Gateway MCP URL (from the gateway stack output). The VoiceNotes Runtime reaches every backend tool through this gateway only (R7.x); passed into the container as an environment identifier.',
    });

    const sharedMemoryArn = new cdk.CfnParameter(this, 'SharedMemoryArn', {
      type: 'String',
      minLength: 1,
      description:
        'Shared AgentCore Memory ARN (from the agentcore-memory stack output). The runtime role gets read/write SCOPED to exactly this ARN (R18.1); passed into the container as an environment identifier.',
    });

    // ----------------- CfnParameter: AZ-resolution contract -----------------
    // Bedrock AgentCore Runtime supports only a subset of AZ IDs in us-east-1
    // (use1-az1, use1-az2, use1-az4), and the AZ-ID-to-letter mapping is
    // randomized per account, resolved at deploy time (design "Region and AZ
    // constraints"). The VoiceNotes Runtime uses the default/managed (PUBLIC)
    // network mode (see the class doc), so it does NOT bind a subnet: the
    // contract is accepted for cross-runtime uniformity (one deploy-all.sh
    // threading shape for all three runtimes) and echoed as an output for
    // operator observability. If this runtime is ever switched to VPC mode,
    // this is the single input that already carries the AZ contract.
    const agentCoreAzIds = new cdk.CfnParameter(this, 'AgentCoreAzIds', {
      type: 'String',
      default: 'use1-az1,use1-az2,use1-az4',
      allowedPattern: '^[a-z0-9-]+(,[a-z0-9-]+)*$',
      constraintDescription:
        'must be a comma-delimited list of AZ IDs, e.g. use1-az1,use1-az2,use1-az4',
      description:
        'Shared AZ-resolution contract: comma-delimited Bedrock AgentCore-supported AZ IDs in us-east-1. The VoiceNotes Runtime runs in managed (PUBLIC) network mode and does not bind a subnet, so this is accepted for cross-runtime uniformity and echoed as an output (not wired into a network configuration).',
    });

    // ----------------- Prefixed physical names (Fn::Sub at deploy time) -----
    const ecrRepoName = cdk.Fn.sub('${P}-wa-voicenotes-agent', { P: prefix });
    const buildProjectName = cdk.Fn.sub('${P}-wa-vn-agent-build', { P: prefix });
    const buildRoleName = cdk.Fn.sub('${P}-wa-vn-build-role', { P: prefix });
    const runtimeRoleName = cdk.Fn.sub('${P}-wa-vn-runtime-role', { P: prefix });

    // ----------------- ECR repository -----------------
    // Removal policy DESTROY + emptyOnDelete so a failed CodeBuild push does
    // not leave an orphaned repo that blocks retries with "repository already
    // exists" (matches the Chat Runtime posture; flip to RETAIN +
    // emptyOnDelete:false for production image-history retention).
    const repo = new ecr.Repository(this, 'VoiceNotesAgentRepo', {
      repositoryName: ecrRepoName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE, // `:latest` overwritten each build
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: 'Retain only the 10 most recent images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    // ----------------- Source S3 bucket + agent/ deployment -----------------
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: cdk.Fn.sub('${P}-wa-vn-src-${A}-${R}', {
        P: prefix,
        A: cdk.Aws.ACCOUNT_ID,
        R: cdk.Aws.REGION,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Pack and upload the sibling `agent/` tree. From cdk/lib/ that is
    // ../../agent (cdk/lib -> cdk -> agentcore-runtime-voicenotes -> agent).
    const deployment = new s3deploy.BucketDeployment(this, 'VoiceNotesAgentSourceDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../agent'))],
      destinationBucket: sourceBucket,
      destinationKeyPrefix: 'agent-source',
      retainOnDelete: false,
      memoryLimit: 512,
    });

    // ----------------- CodeBuild project role (scoped) -----------------
    const buildRole = new iam.Role(this, 'BuildRole', {
      roleName: buildRoleName,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        'Role assumed by the CodeBuild project that builds the WhatsApp VoiceNotes Runtime ARM64 image.',
    });

    // CloudWatch Logs - CodeBuild writes to /aws/codebuild/<projectName>.
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BuildLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          cdk.Fn.sub('arn:${Partition}:logs:${R}:${A}:log-group:/aws/codebuild/*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // ECR login (account-scoped API; service does not support resource IAM).
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuthToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // ECR push, scoped to THIS stack's repo ARN.
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPushToVoiceNotesRepo',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: [repo.repositoryArn],
      }),
    );

    // Source bucket read - scoped to the uploaded source prefix only.
    sourceBucket.grantRead(buildRole, 'agent-source/*');

    // ----------------- CodeBuild project (ARM64) -----------------
    const project = new codebuild.Project(this, 'VoiceNotesAgentBuild', {
      projectName: buildProjectName,
      role: buildRole,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'agent-source/', // BucketDeployment writes a zip here.
      }),
      environment: {
        // ARM64 build image - AgentCore Runtime requires ARM64 container images.
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true, // Docker-in-Docker for `docker buildx`.
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: { value: repo.repositoryUri },
          AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject(buildspec),
      timeout: cdk.Duration.minutes(45),
      logging: {
        cloudWatch: {
          enabled: true,
          logGroup: new logs.LogGroup(this, 'BuildLogGroup', {
            logGroupName: cdk.Fn.sub('/aws/codebuild/${P}-wa-vn-agent-build', { P: prefix }),
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    // Source must be staged before the first build.
    project.node.addDependency(deployment);

    // ----------------- Build waiter custom resource -----------------
    // One bundled Lambda serves both onEvent (StartBuild) and isComplete
    // (BatchGetBuilds poll). The Provider framework drives the 30s polling.
    const waiterHandlerEntry = path.join(
      __dirname,
      '..',
      'lambda',
      'build-waiter',
      'handler.ts',
    );

    const waiterLogGroup = new logs.LogGroup(this, 'BuildWaiterLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-wa-vn-build-waiter', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const waiterIsCompleteLogGroup = new logs.LogGroup(this, 'BuildWaiterIsCompleteLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-wa-vn-build-waiter-check', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // No explicit logGroupName for the Provider framework log group: an
    // explicit `/aws/lambda/<name>` collides with Lambda's last-invocation
    // lazy-create during stack destroy and orphans a group that blocks the
    // next deploy (Chat Runtime build-stack rationale).
    const providerFrameworkLogGroup = new logs.LogGroup(this, 'BuildWaiterProviderFrameworkLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const waiterFn = new NodejsFunction(this, 'BuildWaiterFn', {
      functionName: cdk.Fn.sub('${P}-wa-vn-build-waiter', { P: prefix }),
      entry: waiterHandlerEntry,
      handler: 'onEvent',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: waiterLogGroup,
    });

    const waiterIsCompleteFn = new NodejsFunction(this, 'BuildWaiterIsCompleteFn', {
      functionName: cdk.Fn.sub('${P}-wa-vn-build-waiter-check', { P: prefix }),
      entry: waiterHandlerEntry,
      handler: 'isComplete',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: waiterIsCompleteLogGroup,
    });

    // Waiter Lambda(s): start + describe THIS project only.
    const projectPolicy = new iam.PolicyStatement({
      sid: 'StartAndPollVoiceNotesBuild',
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [project.projectArn],
    });
    waiterFn.addToRolePolicy(projectPolicy);
    waiterIsCompleteFn.addToRolePolicy(projectPolicy);

    const provider = new cr.Provider(this, 'BuildWaiterProvider', {
      onEventHandler: waiterFn,
      isCompleteHandler: waiterIsCompleteFn,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(60),
      logGroup: providerFrameworkLogGroup,
    });

    const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: project.projectName,
        // Cache-buster: re-invoke onEvent whenever the agent source changes.
        TriggerHash: cdk.Fn.join(',', deployment.objectKeys),
      },
    });
    buildTrigger.node.addDependency(project);
    buildTrigger.node.addDependency(deployment);

    // ----------------- AgentCore Runtime IAM role (least privilege, R18.1) --
    const runtimeRole = new iam.Role(this, 'VoiceNotesRuntimeRole', {
      roleName: runtimeRoleName,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description:
        'Role assumed by the WhatsApp VoiceNotes Runtime to pull its image, log, run a bounded Nova 2 Sonic bidirectional speech-to-speech stream, reach the AgentCore Gateway, and read/write the shared AgentCore Memory.',
    });

    // Sid 1 - ECR auth token (account-scoped; no resource-level IAM).
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuthToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // Sid 2 - ECR image pull, scoped to this stack's repo.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPullVoiceNotesImage',
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [repo.repositoryArn],
      }),
    );

    // Sid 3 - Logs. DescribeLogGroups is a list API that IAM validates against
    // log-group:* (constraining it breaks the in-container log sink); the
    // create/write paths are scoped to the AgentCore runtime log-group prefix.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsDescribeGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [
          cdk.Fn.sub('arn:${Partition}:logs:${R}:${A}:log-group:*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsGroupLifecycle',
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [
          cdk.Fn.sub(
            'arn:${Partition}:logs:${R}:${A}:log-group:/aws/bedrock-agentcore/runtimes/*',
            { Partition: cdk.Aws.PARTITION, R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID },
          ),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsStreamWrite',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          cdk.Fn.sub(
            'arn:${Partition}:logs:${R}:${A}:log-group:/aws/bedrock-agentcore/runtimes/*',
            { Partition: cdk.Aws.PARTITION, R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID },
          ),
        ],
      }),
    );

    // Sid 4 - Metrics (namespace-scoped by condition to bedrock-agentcore).
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': ['bedrock-agentcore'] },
        },
      }),
    );

    // Sid 5 - X-Ray (account-scoped service actions).
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'XRay',
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    // Sid 6 - Bedrock invoke for the Amazon Nova 2 Sonic bounded speech-to-speech
    // session. The VoiceNotes Runtime uses the BIDIRECTIONAL stream
    // (`amazon.nova-2-sonic-v1:0`). Nova 2 Sonic's bidirectional invoke requires
    // `bedrock:InvokeModel` IN ADDITION to InvokeModelWithBidirectionalStream -
    // without InvokeModel the stream opens and accepts audio but the model returns
    // AccessDeniedException when it tries to generate (the bug this fixes).
    // InvokeModelWithResponseStream is granted for parity with the telephony
    // runtime (the proven Nova Sonic reference). All three are scoped to the
    // amazon.nova-2-sonic* model family (this region and any region a cross-region
    // inference profile routes to) plus account/region inference profiles.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeNovaSonic',
        actions: [
          'bedrock:InvokeModelWithBidirectionalStream',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: [
          // Nova 2 Sonic foundation model family in this region.
          cdk.Fn.sub('arn:${Partition}:bedrock:${R}::foundation-model/amazon.nova-2-sonic*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
          }),
          // Nova 2 Sonic foundation model in any region the inference profile
          // routes to (cross-region inference profiles fan out to peer regions).
          cdk.Fn.sub('arn:${Partition}:bedrock:*::foundation-model/amazon.nova-2-sonic*', {
            Partition: cdk.Aws.PARTITION,
          }),
          // Inference profiles owned by this account/region.
          cdk.Fn.sub('arn:${Partition}:bedrock:${R}:${A}:inference-profile/*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // Sid 7 - AgentCore Gateway invoke (MCP tools). Gateways in this
    // account/region; the runtime reaches every backend tool through the
    // gateway only (R7.x).
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GatewayInvoke',
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [
          cdk.Fn.sub('arn:${Partition}:bedrock-agentcore:${R}:${A}:gateway/*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // Sid 8 - Shared AgentCore Memory read/write, SCOPED to the single shared
    // memory ARN passed in (R18.1). Read = retrieve long-term insights at
    // session start; write = append conversation events at session end. No
    // wildcard resource: the resource is exactly the SharedMemoryArn parameter.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SharedMemoryReadWrite',
        actions: [
          // Write (events appended at session end).
          'bedrock-agentcore:CreateEvent',
          // Read (long-term consolidated insights + raw events at start).
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
        ],
        resources: [sharedMemoryArn.valueAsString],
      }),
    );

    // Sid 9 - Invoke the WhatsApp Sender Lambda (async reply delivery). The
    // VoiceNotes Runtime no longer returns the audio to the worker; it delivers
    // its Ogg Opus reply out-of-band by invoking this Lambda (kind:'audio'),
    // which holds the Meta Access_Token and resolves the recipient wa_id from
    // the window table (the runtime carries neither the secret nor the PII).
    // Addressed by a DETERMINISTIC name so there is NO cross-stack import and no
    // dependency cycle: the webhook stack creates `<prefix>-wa-sender`, and we
    // construct the identical ARN here from the shared DeploymentPrefix. Exact
    // ARN, no wildcard. Mirrors the Chat Runtime stack's Sid 9.
    const senderLambdaArn = cdk.Fn.sub(
      'arn:${Partition}:lambda:${R}:${A}:function:${P}-wa-sender',
      {
        Partition: cdk.Aws.PARTITION,
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        P: prefix,
      },
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeSenderLambda',
        actions: ['lambda:InvokeFunction'],
        resources: [senderLambdaArn],
      }),
    );

    // ----------------- AgentCore Runtime (AWS::BedrockAgentCore::Runtime) ----
    // AgentRuntimeName must match `[a-zA-Z][a-zA-Z0-9_]{0,47}` (no hyphens), so
    // the hyphenated deployment prefix cannot be interpolated; a fixed name is
    // used and AgentCore appends a unique ARN suffix. Every other resource in
    // this stack carries the prefix.
    const voiceNotesRuntime = new bedrockagentcore.CfnRuntime(this, 'VoiceNotesRuntime', {
      agentRuntimeName: 'whatsapp_voicenotes_runtime',
      description:
        'WhatsApp VoiceNotes Runtime - bounded Nova 2 Sonic speech-to-speech (Ogg Opus in / Ogg Opus out), ARM64, managed (PUBLIC) network mode',
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: cdk.Fn.sub('${U}:latest', { U: repo.repositoryUri }),
        },
      },
      // Default/managed network mode (PUBLIC): the VoiceNotes Runtime is a
      // request/response speech-to-speech runtime with no outbound UDP / TURN /
      // WebRTC need, so it does NOT use the VPC-only mode (that is the Call
      // Runtime's requirement). AgentCore manages placement across its
      // supported AZs.
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      protocolConfiguration: 'HTTP',
      // Lifecycle (testing value): recycle an idle microVM after 5 minutes so a
      // redeployed image propagates quickly and a stale image cannot linger for
      // the 8 h default. idleRuntimeSessionTimeout resets on each invoke, so a
      // back-to-back voice-note exchange still reuses the warm microVM; it only
      // recycles once the customer goes quiet for 5 min. maxLifetime caps any
      // single microVM at 15 min. TUNE FOR PRODUCTION (e.g. idle 600-900s).
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 300, // 5 minutes
        maxLifetime: 900, // 15 minutes hard cap
      },
      environmentVariables: {
        LOG_LEVEL: 'INFO',
        DEPLOYMENT_PREFIX: prefix,
        AGENTCORE_GATEWAY_URL: agentCoreGatewayUrl.valueAsString,
        SHARED_MEMORY_ARN: sharedMemoryArn.valueAsString,
        // The Sender Lambda the runtime invokes to deliver the voice-note reply
        // (audio) and refresh the typing indicator out-of-band (async reply
        // delivery). Deterministic ARN built from the shared prefix - no
        // cross-stack import (see Sid 9).
        SENDER_LAMBDA_ARN: senderLambdaArn,
        // Tie the runtime resource to the agent source hash so a rebuilt image
        // forces a runtime UPDATE -> new version -> AgentCore re-resolves :latest
        // and pulls the freshly built image. (Without this, an unchanged
        // containerUri string makes CFN see no diff and skip the re-pull.)
        AGENT_SOURCE_VERSION: cdk.Fn.join(',', deployment.objectKeys),
      },
    });

    cdk.Tags.of(voiceNotesRuntime).add('DeploymentPrefix', prefix);
    cdk.Tags.of(voiceNotesRuntime).add('Feature', 'whatsapp-restaurant-ai-host');

    // The image must be pushed (build waiter SUCCEEDED) before CFN creates the
    // runtime that references `<repoUri>:latest`.
    voiceNotesRuntime.node.addDependency(buildTrigger);

    // ----------------- Outputs (NO exportName per the isolated-app rule) ----
    new cdk.CfnOutput(this, 'VoiceNotesRuntimeArn', {
      value: voiceNotesRuntime.attrAgentRuntimeArn,
      description:
        'WhatsApp VoiceNotes Runtime ARN - consumed by the webhook stack as VoiceNotesRuntimeArn (CfnParameter). No exportName per the isolated-app rule.',
    });

    new cdk.CfnOutput(this, 'VoiceNotesAgentEcrRepoUri', {
      value: repo.repositoryUri,
      description:
        'ECR repo URI for the VoiceNotes Runtime image - observability and deploy-all threading.',
    });

    new cdk.CfnOutput(this, 'VoiceNotesAgentCodeBuildProjectName', {
      value: project.projectName,
      description: 'CodeBuild project name that builds the ARM64 VoiceNotes Runtime image (observability).',
    });

    new cdk.CfnOutput(this, 'VoiceNotesAgentSourceBucketName', {
      value: sourceBucket.bucketName,
      description: 'S3 bucket holding the zipped agent/ source tree (observability).',
    });

    new cdk.CfnOutput(this, 'AgentCoreAzContract', {
      value: agentCoreAzIds.valueAsString,
      description:
        'Echo of the shared AZ-resolution contract (Bedrock-supported AZ IDs). The VoiceNotes Runtime uses managed (PUBLIC) network mode so it is not bound to a subnet; emitted for cross-runtime uniformity and operator observability.',
    });

    // Tag the whole stack with the deployment prefix + feature for tenant
    // observability, mirroring the other CDK apps in this repo.
    cdk.Tags.of(this).add('DeploymentPrefix', prefix);
    cdk.Tags.of(this).add('Feature', 'whatsapp-restaurant-ai-host');

    // ----------------- cdk-nag suppressions (written justification) ---------
    // Runtime role residual wildcards - each scoped or service-mandated.
    NagSuppressions.addResourceSuppressions(
      runtimeRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Runtime role residual wildcards, all scoped or service-mandated: (a) ecr:GetAuthorizationToken is account-scoped by AWS (no resource-level IAM); (b) xray:* and cloudwatch:PutMetricData are service-scoped, and PutMetricData is further conditioned on cloudwatch:namespace = bedrock-agentcore; (c) logs:DescribeLogGroups requires log-group:* (a list API IAM validates against the wildcard), while the create/write log actions are scoped to /aws/bedrock-agentcore/runtimes/*; (d) bedrock:InvokeModel, InvokeModelWithResponseStream and InvokeModelWithBidirectionalStream are scoped to the amazon.nova-2-sonic* foundation-model family plus account/region inference-profiles (Nova 2 Sonic bidirectional invoke requires InvokeModel in addition to the bidirectional action, and may be reached via a cross-region inference profile); (e) bedrock-agentcore:InvokeGateway is scoped to gateways in this account/region. The shared-memory statement uses the exact SharedMemoryArn parameter with no wildcard. ECR image pull is scoped to this stack repo.',
        },
      ],
      true,
    );

    // CodeBuild project: privileged mode + AWS-managed image.
    NagSuppressions.addResourceSuppressions(
      project,
      [
        {
          id: 'AwsSolutions-CB3',
          reason:
            'CodeBuild privileged mode is required for docker buildx (Docker-in-Docker). AgentCore Runtime mandates ARM64 OCI images and this project is the single path that builds and pushes that image; no non-privileged alternative exists.',
        },
        {
          id: 'AwsSolutions-CB4',
          reason:
            'CodeBuild uses the AWS-managed standard ARM image without a customer-managed KMS key. The build output is a container image layer pushed to a prefix-scoped ECR repo; no sensitive data crosses the build environment, so customer-managed KMS adds key-rotation overhead without a data-at-rest benefit here.',
        },
      ],
      true,
    );

    // Build role: ECR auth-token + CodeBuild log-group wildcards.
    NagSuppressions.addResourceSuppressions(
      buildRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Build role residual wildcards: ecr:GetAuthorizationToken is account-scoped by AWS (no resource-level IAM), and the logs statement targets /aws/codebuild/* log groups (the CodeBuild-managed log path). ECR push is scoped to this stack repo ARN and source read is scoped to the agent-source/* prefix.',
        },
      ],
      true,
    );

    // Source bucket: server access logging disabled.
    NagSuppressions.addResourceSuppressions(sourceBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Source bucket holds a zipped snapshot of the committed agent/ source tree (small, 30-day versioning). Ingestion is traceable via git + the BucketDeployment CloudWatch log stream; access logging adds a second bucket and noise for no audit benefit.',
      },
    ]);

    // Framework-managed findings (Provider + BucketDeployment + NodejsFunction).
    // Stack-level, mirroring the Chat Runtime build/runtime suppressions.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is attached by the CDK Provider framework, the BucketDeployment helper, and NodejsFunction to their framework Lambdas. The policy grants only CloudWatch Logs put/create - minimal privilege, CDK-managed, not user-modifiable.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Residual wildcards on CDK-managed framework constructs: the BucketDeployment internal Lambda needs s3:* on the CDK staging bucket and the source bucket (CDK-managed), and the Provider framework grants lambda:InvokeFunction on its own onEvent/isComplete handlers. None of these leak privileges beyond this stack.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Our NodejsFunctions pin Runtime.NODEJS_24_X (latest AWS Lambda LTS). The BucketDeployment and Provider framework internal Lambda runtimes are CDK-controlled; cdk-nag may flag them transiently as CDK updates the default - they are not user-modifiable.',
      },
      {
        id: 'AwsSolutions-SF1',
        reason:
          'The Provider framework state machine is CDK-managed; its logging level is not user-configurable. It runs only during stack create/update while the CodeBuild build is in flight, then becomes idle.',
      },
      {
        id: 'AwsSolutions-SF2',
        reason:
          'The Provider framework state machine X-Ray setting is CDK-managed; the build waiter is a short-lived deploy-time resource with no steady-state traffic to trace.',
      },
    ]);
  }
}
