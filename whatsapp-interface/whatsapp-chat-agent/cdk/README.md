# whatsapp-chat-agent (CDK)

Single-stack CDK app for the **WhatsApp Chat Runtime** (multimodal text + image
+ file ordering on Amazon Bedrock AgentCore Runtime). Built for Task 7.1.

The stack `ChatAgentStack` (`lib/chat-agent-stack.ts`) provisions, in one stack:

1. an **ECR repository** for the ARM64 Chat Runtime image;
2. an **S3 source bucket** + `BucketDeployment` of the sibling `../agent/` tree;
3. an **ARM64 CodeBuild project** (`docker buildx --platform=linux/arm64`) that
   pushes `:latest` to ECR (AgentCore Runtime requires ARM64);
4. a **build waiter** custom resource that blocks until the image push
   succeeds, so the image exists before the runtime is created;
5. the **AgentCore Runtime** (`AWS::BedrockAgentCore::Runtime`) hosting the Chat
   Runtime in the default/managed (PUBLIC) network mode.

## Network mode

The Chat Runtime is a request/response text runtime, so it uses the
default/managed **PUBLIC** network mode. It does **not** use the VPC-only mode
(that mode exists for the Call Runtime's outbound UDP -> TURN media need). Its
only outbound traffic is HTTPS to AWS service APIs (Bedrock Converse, the
AgentCore Gateway, the shared AgentCore Memory, CloudWatch).

## Inputs (CfnParameters)

| Parameter | Purpose |
|---|---|
| `DeploymentPrefix` | Prefix on every physical resource + IAM ARN (R17.1). |
| `AgentCoreGatewayUrl` | AgentCore Gateway MCP URL (gateway-only tool access, R4.7). |
| `SharedMemoryArn` | Shared AgentCore Memory ARN; runtime role read/write is scoped to exactly this ARN (R18.1). |
| `AgentCoreAzIds` | Shared AZ-resolution contract (default `use1-az1,use1-az2,use1-az4`); echoed as an output, not bound to a subnet in PUBLIC mode. |

## Outputs (CfnOutputs, no exportName)

| Output | Consumer |
|---|---|
| `ChatRuntimeArn` | Webhook stack `ChatRuntimeArn` CfnParameter. |
| `ChatAgentEcrRepoUri` | Observability / deploy-all threading. |
| `ChatAgentCodeBuildProjectName` | Observability. |
| `ChatAgentSourceBucketName` | Observability. |
| `AgentCoreAzContract` | Echo of the AZ contract. |

## Local verification (no deploy)

```bash
npm install
npx tsc --noEmit
npx cdk synth --quiet      # zero unsuppressed cdk-nag findings
npm test                   # synth/config guard
```

The agent application logic (`agent/chat_agent.py`, multimodal Converse + Nova
Pro + shared memory) is implemented in **Task 7.2**; this app ships a minimal
placeholder `agent/` so the CodeBuild/Docker source asset resolves and synth
succeeds.
