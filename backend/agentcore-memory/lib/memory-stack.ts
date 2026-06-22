import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * {prefix}-MemoryStack - the ONE shared Amazon Bedrock AgentCore Memory
 * resource for the WhatsApp variant (design: "Shared AgentCore Memory").
 *
 * All three runtimes (Call, VoiceNotes, Chat) read/write this single memory,
 * keyed by the pseudonymous customer_id used as the AgentCore `actorId`. Cross-
 * channel recall comes from the long-term consolidation tier, whose namespaces
 * are templated by `{actorId}` so a customer is the same person across text,
 * voice notes, and calls (R18).
 *
 * Two tiers (R18.4, R18.5):
 *  - Short-term: raw within-session conversation events, EventExpiryDuration =
 *    30 days (confirmed; service allows 7-365 in the API model, 3-365 in CFN).
 *  - Long-term: extraction/consolidation strategies (semantic insights +
 *    user preferences) namespaced by `{actorId}`, retrieved via semantic search.
 *
 * Provisioning path: the native L1 CloudFormation resource
 * `AWS::BedrockAgentCore::Memory`. It is created here via `cdk.CfnResource`
 * (the escape hatch) rather than a typed L2/L1 construct, so the stack does not
 * depend on a specific aws-cdk-lib minor shipping the generated construct -
 * AgentCore is recently GA and the typed surface may lag. The property shape
 * matches the CFN Template Reference for AWS::BedrockAgentCore::Memory.
 *
 * Wiring (r4 isolated-app pattern):
 *  - INPUT:  `DeploymentPrefix` CfnParameter (threaded by scripts/deploy-all.sh).
 *  - OUTPUT: `MemoryId` and `MemoryArn` as CfnOutput WITHOUT `exportName`.
 *    scripts/deploy-all.sh reads them from cdk-outputs/wa-memory.json via
 *    json_val and passes them as --parameters to the three runtime stacks and
 *    the webhook stack (R18.1).
 *
 * ASCII-only in every CloudFormation-bound string (working agreement #7).
 */
export class MemoryStack extends cdk.Stack {
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
    });
    const prefix = deploymentPrefix.valueAsString;

    // Physical memory name. AgentCore appends a 10-char suffix to form the id
    // (Name-XXXXXXXXXX). The Name property pattern is STRICT:
    // ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ - underscores allowed but NOT hyphens, max
    // 48 chars. The deployment prefix arrives as a CfnParameter (a token) that
    // may contain hyphens (default "qsr-wa"), and a token cannot be
    // sanitized at synth time, so the prefix CANNOT be interpolated into this
    // name. We therefore use a FIXED underscore name - the same approach the
    // runtime stacks use for AgentRuntimeName (also no-hyphen). The deployment
    // prefix still scopes every OTHER resource (the execution role, the stack
    // name) and is applied as a tag below for tenant observability; the unique
    // memory id (Name + service suffix) keeps deploys from colliding on the id.
    const memoryName = 'whatsapp_shared_memory';


    // ----------------- Memory execution role -----------------
    // The role AgentCore Memory assumes to run the async extraction/
    // consolidation jobs that build the long-term tier. It needs to invoke the
    // strategy model and write memory records back. Scoped to Bedrock model
    // invoke; the service writes records into this same memory resource.
    const memoryExecutionRole = new iam.Role(this, 'MemoryExecutionRole', {
      roleName: cdk.Fn.sub('${P}-wa-memory-exec', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description:
        'Role AgentCore Memory assumes for async long-term extraction and consolidation',
    });
    // Allow invoking the consolidation/extraction model(s). Nova models in this
    // region; scoped to the Bedrock service in this account/region.
    memoryExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConsolidationModels',
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // ----------------- AWS::BedrockAgentCore::Memory (L1 via escape hatch) ---
    // Two long-term strategies, both namespaced by {actorId} = customer_id:
    //   - SemanticMemoryStrategy   -> /insights/{actorId}/      (facts, context)
    //   - UserPreferenceMemoryStrategy -> /preferences/{actorId}/ (prefs, diet)
    // Short-term retention: EventExpiryDuration = 30 days.
    const memory = new cdk.CfnResource(this, 'SharedMemory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: memoryName,
        Description:
          'Shared WhatsApp AgentCore Memory keyed by customer_id (actorId) - read/written by the Call, VoiceNotes, and Chat runtimes for cross-channel recall',
        EventExpiryDuration: 30,
        MemoryExecutionRoleArn: memoryExecutionRole.roleArn,
        MemoryStrategies: [
          {
            SemanticMemoryStrategy: {
              Name: 'Insights',
              Description:
                'Consolidated semantic insights (facts, order context) per customer',
              Namespaces: ['/insights/{actorId}/'],
            },
          },
          {
            UserPreferenceMemoryStrategy: {
              Name: 'Preferences',
              Description:
                'Learned customer preferences (usual order, dietary notes) per customer',
              Namespaces: ['/preferences/{actorId}/'],
            },
          },
        ],
        Tags: {
          'auto-delete': 'no',
          Feature: 'whatsapp-restaurant-ai-host',
        },
      },
    });

    // ----------------- Outputs (NO exportName per the isolated-app rule) -----
    // Ref returns the memory ARN; GetAtt MemoryId returns the runtime id.
    new cdk.CfnOutput(this, 'MemoryArn', {
      value: memory.ref,
      description:
        'Shared AgentCore Memory ARN - consumed by the three runtime stacks for IAM scoping (CfnParameter)',
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      value: memory.getAtt('MemoryId').toString(),
      description:
        'Shared AgentCore Memory id - consumed by the three runtime stacks for data-plane CreateEvent/RetrieveMemoryRecords (CfnParameter)',
    });
  }
}
