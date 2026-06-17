import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesisvideo from 'aws-cdk-lib/aws-kinesisvideo';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { buildspec } from './buildspec';

/**
 * VoiceWebrtcStack - the WhatsApp Call Runtime (Tasks 15.1, 16.1).
 *
 * One self-contained CDK app that provisions, in a single stack, the complete
 * build-and-host pipeline for the WebRTC voice-call answerer:
 *
 *   1. ECR repository      `{prefix}-wa-call-agent` - holds the ARM64 image.
 *   2. S3 source bucket    + BucketDeployment of the sibling `agent/` dir.
 *   3. CodeBuild project   `{prefix}-wa-call-agent-build` - ARM64 Docker build
 *      (`docker buildx --platform=linux/arm64`), push to ECR. AgentCore Runtime
 *      requires ARM64 images.
 *   4. Build waiter        - a Provider-backed custom resource that StartBuilds
 *      the project on deploy and blocks until SUCCEEDED, so the image exists in
 *      ECR before the AgentCore Runtime resource is created.
 *   5. KVS signaling channel `{prefix}-wa-voice-call` (SINGLE_MASTER) - the
 *      managed-TURN credential source the runtime calls GetIceServerConfig on
 *      (Task 15.1). KVS is used ONLY to mint TURN credentials; no media or
 *      signaling flows over the channel (design "Two-plane model").
 *   6. AgentCore Runtime   `AWS::BedrockAgentCore::Runtime` (the WhatsApp Call
 *      Runtime), VPC network mode.
 *
 * Structure mirrors the VoiceNotes Runtime stack (whatsapp-voicenotes) - the
 * same single-stack ECR + ARM64 CodeBuild + build-waiter + AgentCore Runtime
 * pipeline. The meaningful differences are:
 *
 *   1. NETWORK MODE: the Call Runtime runs the aiortc WebRTC answerer IN the
 *      container, which requires VPC network mode with outbound UDP to the TURN
 *      relay (AgentCore Runtime supports WebRTC ONLY in VPC mode):
 *      https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-webrtc.html
 *      The runtime is placed in the shared network stack's private subnets and
 *      bound to its egress-only security group (443/tcp + UDP 1024-65535).
 *   2. KVS SIGNALING CHANNEL + IAM: a SINGLE_MASTER channel is provisioned here
 *      and the runtime role is scoped to DescribeSignalingChannel /
 *      GetSignalingChannelEndpoint / GetIceServerConfig on it (Task 15.1).
 *   3. MODEL ACCESS: like VoiceNotes, the runtime runs Amazon Nova 2 Sonic
 *      bidirectional (Tasks 18/19), so the role is granted Sonic invoke +
 *      Gateway invoke + shared-Memory read/write now (so the role is complete
 *      for that step; Step 2a does not yet exercise the model path).
 *
 * Wiring (isolated-app pattern, R17.2): no CloudFormation Exports / ImportValue.
 *  - INPUT  CfnParameters: DeploymentPrefix, AgentCoreGatewayUrl, MemoryArn,
 *    VpcId, PrivateSubnetIds (CommaDelimitedList), AgentSecurityGroupId.
 *    Threaded by scripts/deploy-all.sh from the network + gateway + memory
 *    cdk-outputs files.
 *  - OUTPUT CfnOutputs (NO exportName): AgentRuntimeArn (consumed by the webhook
 *    stack), CallAgentEcrRepoUri, TurnSignalingChannelName, plus observability.
 *
 * ASCII-only in every CloudFormation-bound string (working agreement #7): use
 * `->` rather than an em-dash, no smart quotes, no non-breaking spaces.
 */
export class VoiceWebrtcStack extends cdk.Stack {
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
    const agentCoreGatewayUrl = new cdk.CfnParameter(this, 'AgentCoreGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'AgentCore Gateway MCP URL (from the gateway stack output). The Call Runtime reaches every backend tool through this gateway only (R7.x); passed into the container as an environment identifier.',
    });

    const memoryArn = new cdk.CfnParameter(this, 'MemoryArn', {
      type: 'String',
      minLength: 1,
      description:
        'Shared AgentCore Memory ARN (from the agentcore-memory stack output). The runtime role gets read/write SCOPED to exactly this ARN (R18.1); passed into the container as an environment identifier.',
    });

    // ----------------- CfnParameters: network (from NetworkStack) -----------
    // The Call Runtime runs in VPC network mode (WebRTC requirement). These come
    // from the shared network stack's outputs via scripts/deploy-all.sh.
    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      minLength: 1,
      description:
        'VPC id of the shared network stack (NetworkStack output VpcId). Carried for traceability and echoed as an output; AgentCore binds to subnets + security groups, which already imply the VPC.',
    });

    const privateSubnetIds = new cdk.CfnParameter(this, 'PrivateSubnetIds', {
      type: 'CommaDelimitedList',
      description:
        'Comma-delimited private-with-egress subnet ids (NetworkStack output PrivateSubnetIds). The Call Runtime ENIs are placed here so media egresses via the NAT gateway to the TURN relay.',
    });

    const agentSecurityGroupId = new cdk.CfnParameter(this, 'AgentSecurityGroupId', {
      type: 'String',
      minLength: 1,
      description:
        'Security group id for the AgentCore Runtime ENIs (NetworkStack output AgentSecurityGroupId): egress 443/tcp (AWS APIs) + UDP 1024-65535 (WebRTC/TURN media), no ingress.',
    });

    // ----------------- Prefixed physical names (Fn::Sub at deploy time) -----
    const ecrRepoName = cdk.Fn.sub('${P}-wa-call-agent', { P: prefix });
    const buildProjectName = cdk.Fn.sub('${P}-wa-call-agent-build', { P: prefix });
    const buildRoleName = cdk.Fn.sub('${P}-wa-call-build-role', { P: prefix });
    const runtimeRoleName = cdk.Fn.sub('${P}-wa-call-runtime-role', { P: prefix });
    // KVS channel name MUST match what the container resolves. handler.py uses
    // KVS_CHANNEL_NAME (set below) verbatim, so this is the single source.
    const channelName = cdk.Fn.sub('${P}-wa-voice-call', { P: prefix });

    // ----------------- KVS signaling channel (Task 15.1) -----------------
    // SINGLE_MASTER channel used ONLY as a managed-TURN credential source
    // (GetIceServerConfig). No media or signaling traverses the channel; the
    // Call Runtime is the WebRTC master and Meta is reached via the invoke API.
    const turnSignalingChannel = new kinesisvideo.CfnSignalingChannel(this, 'TurnSignalingChannel', {
      name: channelName,
      type: 'SINGLE_MASTER',
      tags: [
        { key: 'DeploymentPrefix', value: prefix },
        { key: 'Feature', value: 'whatsapp-restaurant-ai-host' },
      ],
    });
    // ARN pattern for IAM scoping. The channel ARN carries a creation-time
    // suffix, so resource policies scope to the channel name with a trailing
    // wildcard segment.
    const channelArnPattern = cdk.Fn.sub(
      'arn:${Partition}:kinesisvideo:${R}:${A}:channel/${C}/*',
      { Partition: cdk.Aws.PARTITION, R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID, C: channelName },
    );

    // ----------------- ECR repository -----------------
    // Removal policy DESTROY + emptyOnDelete so a failed CodeBuild push does
    // not leave an orphaned repo that blocks retries with "repository already
    // exists" (matches the VoiceNotes posture; flip to RETAIN +
    // emptyOnDelete:false for production image-history retention).
    const repo = new ecr.Repository(this, 'CallAgentRepo', {
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
      bucketName: cdk.Fn.sub('${P}-wa-call-src-${A}-${R}', {
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
    // ../../agent (cdk/lib -> cdk -> agentcore-runtime-voice-webrtc -> agent).
    const deployment = new s3deploy.BucketDeployment(this, 'CallAgentSourceDeployment', {
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
        'Role assumed by the CodeBuild project that builds the WhatsApp Call Runtime ARM64 image.',
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
        sid: 'EcrPushToCallRepo',
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
    const project = new codebuild.Project(this, 'CallAgentBuild', {
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
            logGroupName: cdk.Fn.sub('/aws/codebuild/${P}-wa-call-agent-build', { P: prefix }),
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
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-wa-call-build-waiter', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const waiterIsCompleteLogGroup = new logs.LogGroup(this, 'BuildWaiterIsCompleteLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-wa-call-build-waiter-check', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // No explicit logGroupName for the Provider framework log group: an
    // explicit `/aws/lambda/<name>` collides with Lambda's last-invocation
    // lazy-create during stack destroy and orphans a group that blocks the
    // next deploy (VoiceNotes / Chat build-stack rationale).
    const providerFrameworkLogGroup = new logs.LogGroup(this, 'BuildWaiterProviderFrameworkLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const waiterFn = new NodejsFunction(this, 'BuildWaiterFn', {
      functionName: cdk.Fn.sub('${P}-wa-call-build-waiter', { P: prefix }),
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
      functionName: cdk.Fn.sub('${P}-wa-call-build-waiter-check', { P: prefix }),
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
      sid: 'StartAndPollCallBuild',
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

    // ----------------- AgentCore Runtime IAM role (least privilege) ---------
    const runtimeRole = new iam.Role(this, 'CallRuntimeRole', {
      roleName: runtimeRoleName,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description:
        'Role assumed by the WhatsApp Call Runtime to pull its image, log, fetch KVS managed-TURN credentials, run a Nova 2 Sonic bidirectional stream, reach the AgentCore Gateway, and read/write the shared AgentCore Memory.',
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
        sid: 'EcrPullCallImage',
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

    // Sid 6 - KVS managed TURN (Task 15.1). The runtime calls
    // DescribeSignalingChannel (resolve ARN), GetSignalingChannelEndpoint
    // (HTTPS master endpoint) and GetIceServerConfig (TURN creds), all scoped to
    // the channel provisioned in this stack. No CreateSignalingChannel: the
    // channel is CDK-owned, so the container's describe path always resolves it.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KvsManagedTurn',
        actions: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
        ],
        resources: [channelArnPattern],
      }),
    );

    // Sid 7 - Bedrock invoke for the Amazon Nova 2 Sonic bidirectional
    // speech-to-speech session (Tasks 18/19). Nova 2 Sonic's bidirectional
    // invoke requires `bedrock:InvokeModel` IN ADDITION to
    // InvokeModelWithBidirectionalStream - without InvokeModel the stream opens
    // and accepts audio but the model returns AccessDeniedException when it
    // tries to generate. InvokeModelWithResponseStream is granted for parity
    // with the telephony/VoiceNotes runtimes. All three are scoped to the
    // amazon.nova-2-sonic* model family (this region and any region a
    // cross-region inference profile routes to) plus account/region inference
    // profiles.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeNovaSonic',
        actions: [
          'bedrock:InvokeModelWithBidirectionalStream',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: [
          cdk.Fn.sub('arn:${Partition}:bedrock:${R}::foundation-model/amazon.nova-2-sonic*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
          }),
          cdk.Fn.sub('arn:${Partition}:bedrock:*::foundation-model/amazon.nova-2-sonic*', {
            Partition: cdk.Aws.PARTITION,
          }),
          cdk.Fn.sub('arn:${Partition}:bedrock:${R}:${A}:inference-profile/*', {
            Partition: cdk.Aws.PARTITION,
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // Sid 8 - AgentCore Gateway invoke (MCP tools). Gateways in this
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

    // Sid 9 - Shared AgentCore Memory read/write, SCOPED to the single shared
    // memory ARN passed in (R18.1). Read = retrieve long-term insights at
    // session start; write = append conversation events at session end. No
    // wildcard resource: the resource is exactly the MemoryArn parameter.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SharedMemoryReadWrite',
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
        ],
        resources: [memoryArn.valueAsString],
      }),
    );

    // ----------------- AgentCore Runtime (AWS::BedrockAgentCore::Runtime) ----
    // AgentRuntimeName must match `[a-zA-Z][a-zA-Z0-9_]{0,47}` (no hyphens), so
    // the hyphenated deployment prefix cannot be interpolated; a fixed name is
    // used and AgentCore appends a unique ARN suffix. Every other resource in
    // this stack carries the prefix.
    const callRuntime = new bedrockagentcore.CfnRuntime(this, 'CallRuntime', {
      agentRuntimeName: 'whatsapp_call_runtime',
      description:
        'WhatsApp Call Runtime - aiortc WebRTC answerer over KVS managed TURN, ARM64, VPC network mode (outbound UDP to TURN relay)',
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: cdk.Fn.sub('${U}:latest', { U: repo.repositoryUri }),
        },
      },
      // VPC network mode is REQUIRED for WebRTC on AgentCore Runtime: the
      // container needs outbound UDP to the KVS TURN relay, which PUBLIC/managed
      // mode does not permit. The runtime ENIs are placed in the shared network
      // stack's private subnets and bound to its egress-only security group.
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: {
          subnets: privateSubnetIds.valueAsList,
          securityGroups: [agentSecurityGroupId.valueAsString],
        },
      },
      protocolConfiguration: 'HTTP',
      // Lifecycle: a call holds one microVM for its duration. idle timeout
      // resets on each invoke, so an active call keeps its warm microVM;
      // maxLifetime caps a single microVM. TUNE FOR PRODUCTION.
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 900, // 15 minutes idle before recycle
        maxLifetime: 3600, // 1 hour hard cap per microVM
      },
      environmentVariables: {
        LOG_LEVEL: 'INFO',
        DEPLOYMENT_PREFIX: prefix,
        AGENTCORE_GATEWAY_URL: agentCoreGatewayUrl.valueAsString,
        SHARED_MEMORY_ARN: memoryArn.valueAsString,
        // KVS channel the container fetches TURN credentials from. handler.py
        // reads KVS_CHANNEL_NAME verbatim (env precedence over the prefix
        // default), so this is the single source of the channel name.
        KVS_CHANNEL_NAME: channelName,
        // Tie the runtime resource to the agent source hash so a rebuilt image
        // forces a runtime UPDATE -> new version -> AgentCore re-resolves
        // :latest and pulls the freshly built image.
        AGENT_SOURCE_VERSION: cdk.Fn.join(',', deployment.objectKeys),
      },
    });

    cdk.Tags.of(callRuntime).add('DeploymentPrefix', prefix);
    cdk.Tags.of(callRuntime).add('Feature', 'whatsapp-restaurant-ai-host');

    // The image must be pushed (build waiter SUCCEEDED) before CFN creates the
    // runtime that references `<repoUri>:latest`.
    callRuntime.node.addDependency(buildTrigger);

    // ----------------- Outputs (NO exportName per the isolated-app rule) ----
    // deploy-all.sh reads AgentRuntimeArn from cdk-outputs/wa-runtime-call.json
    // and threads it to the webhook stack as the Call Runtime target.
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: callRuntime.attrAgentRuntimeArn,
      description:
        'WhatsApp Call Runtime ARN - consumed by the webhook stack (CfnParameter). No exportName per the isolated-app rule.',
    });

    new cdk.CfnOutput(this, 'CallAgentEcrRepoUri', {
      value: repo.repositoryUri,
      description:
        'ECR repo URI for the Call Runtime image - observability and deploy-all threading.',
    });

    new cdk.CfnOutput(this, 'TurnSignalingChannelName', {
      value: turnSignalingChannel.ref,
      description:
        'KVS SINGLE_MASTER signaling channel name (managed-TURN credential source). Passed into the container as KVS_CHANNEL_NAME.',
    });

    new cdk.CfnOutput(this, 'CallAgentCodeBuildProjectName', {
      value: project.projectName,
      description: 'CodeBuild project name that builds the ARM64 Call Runtime image (observability).',
    });

    new cdk.CfnOutput(this, 'CallAgentSourceBucketName', {
      value: sourceBucket.bucketName,
      description: 'S3 bucket holding the zipped agent/ source tree (observability).',
    });

    // Echo the VpcId so the parameter is referenced (avoids an unused-parameter
    // lint finding) and the operator can confirm the runtime landed in the
    // expected VPC.
    new cdk.CfnOutput(this, 'CallRuntimeVpcId', {
      value: vpcId.valueAsString,
      description:
        'VPC id the Call Runtime ENIs are placed in (echo of the VpcId parameter from NetworkStack).',
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
            'Runtime role residual wildcards, all scoped or service-mandated: (a) ecr:GetAuthorizationToken is account-scoped by AWS (no resource-level IAM); (b) xray:* and cloudwatch:PutMetricData are service-scoped, and PutMetricData is further conditioned on cloudwatch:namespace = bedrock-agentcore; (c) logs:DescribeLogGroups requires log-group:* (a list API IAM validates against the wildcard), while the create/write log actions are scoped to /aws/bedrock-agentcore/runtimes/*; (d) the KVS actions (DescribeSignalingChannel, GetSignalingChannelEndpoint, GetIceServerConfig) are scoped to this stack channel ARN with a trailing wildcard segment because the KVS channel ARN carries a creation-time suffix; (e) bedrock:InvokeModel, InvokeModelWithResponseStream and InvokeModelWithBidirectionalStream are scoped to the amazon.nova-2-sonic* foundation-model family plus account/region inference-profiles (Nova 2 Sonic bidirectional invoke requires InvokeModel in addition to the bidirectional action, and may be reached via a cross-region inference profile); (f) bedrock-agentcore:InvokeGateway is scoped to gateways in this account/region. The shared-memory statement uses the exact MemoryArn parameter with no wildcard. ECR image pull is scoped to this stack repo.',
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
          'Source bucket holds only the zipped agent/ build context (no customer or request data). Server access logging would add a second bucket and lifecycle overhead with no security benefit for an ephemeral build-input artifact that is overwritten each deploy.',
      },
    ]);

    // Framework-managed findings (Provider + BucketDeployment + NodejsFunction).
    // Stack-level, mirroring the VoiceNotes / Chat Runtime build/runtime
    // suppressions. These cover the CDK-managed helper Lambdas (BucketDeployment,
    // build-waiter service roles) and the Provider framework state machine.
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
