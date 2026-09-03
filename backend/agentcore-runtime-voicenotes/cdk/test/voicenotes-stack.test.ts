import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VoiceNotesStack } from '../lib/voicenotes-stack';

/**
 * Synth/config guard for the WhatsApp VoiceNotes Runtime stack (Task 12.1).
 *
 * Single-execution synth assertions (NOT randomized property runs): we
 * synthesize VoiceNotesStack once and assert the generated CloudFormation
 * template holds the structural invariants the task requires:
 *  - the ECR repository exists (prefixed name);
 *  - the CodeBuild project targets ARM64 (ARM_CONTAINER);
 *  - the AgentCore Runtime L1 resource is present, managed (PUBLIC) network mode;
 *  - the runtime ARN CfnOutput has no Export (isolated-app rule, R17.2);
 *  - the shared-memory IAM statement is scoped to the SharedMemoryArn parameter
 *    with no `*` resource;
 *  - the Bedrock statement grants the Nova 2 Sonic BIDIRECTIONAL stream (the
 *    speech-to-speech path) and NOT the Converse InvokeModel* actions;
 *  - deployment-prefix discipline holds on physical names.
 *
 * The stack declares CfnParameters without defaults (DeploymentPrefix,
 * AgentCoreGatewayUrl, SharedMemoryArn). Template.fromStack does not require
 * supplying their values: the literals under assertion are emitted as Fn::Sub
 * tokens / Refs regardless, so we synth without parameter values.
 */
describe('VoiceNotesStack synth/config guard', () => {
  function synth(): Template {
    const app = new cdk.App();
    const stack = new VoiceNotesStack(app, 'VoiceNotesStack', {
      env: { region: 'us-east-1' },
    });
    return Template.fromStack(stack);
  }

  test('ECR repository exists with the deployment-prefixed name', () => {
    const template = synth();
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: {
        'Fn::Sub': ['${P}-wa-voicenotes-agent', { P: { Ref: 'DeploymentPrefix' } }],
      },
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('CodeBuild project builds an ARM64 container image', () => {
    const template = synth();
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        // LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0 -> ARM_CONTAINER.
        Type: 'ARM_CONTAINER',
        PrivilegedMode: true,
      }),
    });
    // The ARM64 build image is the AWS-managed aarch64 standard image.
    const projects = template.findResources('AWS::CodeBuild::Project');
    const project = Object.values(projects)[0] as {
      Properties: { Environment: { Image: string; Type: string } };
    };
    expect(project.Properties.Environment.Type).toBe('ARM_CONTAINER');
    expect(project.Properties.Environment.Image).toContain('aarch64');
  });

  test('AgentCore Runtime L1 resource is present in managed (PUBLIC) network mode', () => {
    const template = synth();
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'whatsapp_voicenotes_runtime',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      ProtocolConfiguration: 'HTTP',
    });
  });

  test('VoiceNotes Runtime ARN is a CfnOutput with NO Export (isolated-app rule)', () => {
    const template = synth();
    const outputs = template.findOutputs('VoiceNotesRuntimeArn');
    expect(Object.keys(outputs)).toHaveLength(1);
    const output = Object.values(outputs)[0] as { Export?: unknown };
    expect(output.Export).toBeUndefined();
  });

  test('shared-memory IAM is scoped to the SharedMemoryArn parameter (no wildcard)', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');

    // Collect every statement across all policies and find the shared-memory one.
    type Statement = { Sid?: string; Action?: unknown; Resource?: unknown };
    const allStatements: Statement[] = [];
    for (const policy of Object.values(policies) as Array<{
      Properties: { PolicyDocument: { Statement: Statement[] } };
    }>) {
      allStatements.push(...policy.Properties.PolicyDocument.Statement);
    }

    const memoryStatements = allStatements.filter(
      (s) => s.Sid === 'SharedMemoryReadWrite',
    );
    expect(memoryStatements).toHaveLength(1);

    const stmt = memoryStatements[0];
    // Resource must be EXACTLY the SharedMemoryArn parameter Ref - not a `*`.
    expect(stmt.Resource).toEqual({ Ref: 'SharedMemoryArn' });
    expect(stmt.Resource).not.toBe('*');

    // The actions are AgentCore Memory read/write.
    const actions = stmt.Action as string[];
    expect(actions).toEqual(expect.arrayContaining(['bedrock-agentcore:CreateEvent']));
    expect(actions).toEqual(
      expect.arrayContaining(['bedrock-agentcore:RetrieveMemoryRecords']),
    );
  });

  test('Bedrock invoke grants the Nova 2 Sonic bidirectional stream plus InvokeModel', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    type Statement = { Sid?: string; Action?: unknown; Resource?: unknown };
    const allStatements: Statement[] = [];
    for (const policy of Object.values(policies) as Array<{
      Properties: { PolicyDocument: { Statement: Statement[] } };
    }>) {
      allStatements.push(...policy.Properties.PolicyDocument.Statement);
    }
    const bedrock = allStatements.filter((s) => s.Sid === 'BedrockInvokeNovaSonic');
    expect(bedrock).toHaveLength(1);
    // A single-element Action list renders as a scalar string in CFN; normalize.
    const raw = bedrock[0].Action as string | string[];
    const actions = Array.isArray(raw) ? raw : [raw];
    // Nova 2 Sonic bidirectional invoke requires the bidirectional stream action
    // AND bedrock:InvokeModel (without it the model returns AccessDeniedException
    // when generating); InvokeModelWithResponseStream is granted for parity with
    // the telephony reference runtime.
    expect(actions).toEqual(
      expect.arrayContaining([
        'bedrock:InvokeModelWithBidirectionalStream',
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ]),
    );
    // Still NOT the Converse text-path action the Chat Runtime uses.
    expect(actions).not.toContain('bedrock:Converse');
  });

  test('runtime can invoke the Sender Lambda (async audio delivery), scoped to <prefix>-wa-sender', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    type Statement = { Sid?: string; Action?: unknown; Resource?: unknown };
    const allStatements: Statement[] = [];
    for (const policy of Object.values(policies) as Array<{
      Properties: { PolicyDocument: { Statement: Statement[] } };
    }>) {
      allStatements.push(...policy.Properties.PolicyDocument.Statement);
    }
    const senderStmts = allStatements.filter((s) => s.Sid === 'InvokeSenderLambda');
    expect(senderStmts).toHaveLength(1);
    const stmt = senderStmts[0];
    const raw = stmt.Action as string | string[];
    const actions = Array.isArray(raw) ? raw : [raw];
    expect(actions).toEqual(['lambda:InvokeFunction']);
    // Exact deterministic ARN for the sender function - no wildcard.
    const sub = (stmt.Resource as { 'Fn::Sub'?: [string, Record<string, unknown>] })['Fn::Sub'];
    expect(Array.isArray(sub)).toBe(true);
    expect(sub![0]).toBe('arn:${Partition}:lambda:${R}:${A}:function:${P}-wa-sender');
    expect(sub![1].P).toEqual({ Ref: 'DeploymentPrefix' });
    expect(stmt.Resource).not.toBe('*');
  });

  test('runtime carries the SENDER_LAMBDA_ARN environment variable', () => {
    const template = synth();
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        SENDER_LAMBDA_ARN: {
          'Fn::Sub': [
            'arn:${Partition}:lambda:${R}:${A}:function:${P}-wa-sender',
            Match.objectLike({ P: { Ref: 'DeploymentPrefix' } }),
          ],
        },
      }),
    });
  });

  test('deployment-prefix discipline holds on the runtime IAM role name', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: {
        'Fn::Sub': ['${P}-wa-vn-runtime-role', { P: { Ref: 'DeploymentPrefix' } }],
      },
    });
  });
});
