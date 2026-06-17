import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VoiceWebrtcStack } from '../lib/voice-webrtc-stack';

/**
 * Synth/config guard for the WhatsApp Call Runtime stack (Tasks 15.1, 16.1).
 *
 * Single-execution synth assertions (NOT randomized property runs): we
 * synthesize VoiceWebrtcStack once and assert the generated CloudFormation
 * template holds the structural invariants the tasks require:
 *  - the ECR repository exists (prefixed name);
 *  - the CodeBuild project targets ARM64 (ARM_CONTAINER);
 *  - the AgentCore Runtime L1 resource is present in VPC network mode, bound to
 *    the PrivateSubnetIds list + AgentSecurityGroupId (WebRTC requirement);
 *  - a KVS SINGLE_MASTER signaling channel is provisioned (managed-TURN source);
 *  - the KVS IAM statement is scoped to the channel ARN (not `*`);
 *  - the runtime ARN CfnOutput is named AgentRuntimeArn with no Export
 *    (deploy-all contract + isolated-app rule, R17.2);
 *  - the shared-memory IAM statement is scoped to the MemoryArn parameter;
 *  - the Bedrock statement grants the Nova 2 Sonic bidirectional stream;
 *  - deployment-prefix discipline holds on physical names.
 *
 * The stack declares CfnParameters without defaults. Template.fromStack does
 * not require supplying their values: the literals under assertion are emitted
 * as Fn::Sub tokens / Refs regardless.
 */
describe('VoiceWebrtcStack synth/config guard', () => {
  function synth(): Template {
    const app = new cdk.App();
    const stack = new VoiceWebrtcStack(app, 'VoiceWebrtcStack', {
      env: { region: 'us-east-1' },
    });
    return Template.fromStack(stack);
  }

  type Statement = { Sid?: string; Action?: unknown; Resource?: unknown };

  function allStatements(template: Template): Statement[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const out: Statement[] = [];
    for (const policy of Object.values(policies) as Array<{
      Properties: { PolicyDocument: { Statement: Statement[] } };
    }>) {
      out.push(...policy.Properties.PolicyDocument.Statement);
    }
    return out;
  }

  test('ECR repository exists with the deployment-prefixed name', () => {
    const template = synth();
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: {
        'Fn::Sub': ['${P}-wa-call-agent', { P: { Ref: 'DeploymentPrefix' } }],
      },
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('CodeBuild project builds an ARM64 container image', () => {
    const template = synth();
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        Type: 'ARM_CONTAINER',
        PrivilegedMode: true,
      }),
    });
    const projects = template.findResources('AWS::CodeBuild::Project');
    const project = Object.values(projects)[0] as {
      Properties: { Environment: { Image: string; Type: string } };
    };
    expect(project.Properties.Environment.Type).toBe('ARM_CONTAINER');
    expect(project.Properties.Environment.Image).toContain('aarch64');
  });

  test('AgentCore Runtime is in VPC network mode bound to subnets + SG (WebRTC requirement)', () => {
    const template = synth();
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'whatsapp_call_runtime',
      ProtocolConfiguration: 'HTTP',
      NetworkConfiguration: {
        NetworkMode: 'VPC',
        NetworkModeConfig: {
          // PrivateSubnetIds is a CommaDelimitedList parameter -> Ref renders
          // the whole list for the subnets array.
          Subnets: { Ref: 'PrivateSubnetIds' },
          SecurityGroups: [{ Ref: 'AgentSecurityGroupId' }],
        },
      },
    });
  });

  test('KVS SINGLE_MASTER signaling channel is provisioned (managed-TURN source)', () => {
    const template = synth();
    template.resourceCountIs('AWS::KinesisVideo::SignalingChannel', 1);
    template.hasResourceProperties('AWS::KinesisVideo::SignalingChannel', {
      Type: 'SINGLE_MASTER',
      Name: { 'Fn::Sub': ['${P}-wa-voice-call', { P: { Ref: 'DeploymentPrefix' } }] },
    });
  });

  test('KVS managed-TURN IAM is scoped to the channel ARN (not a wildcard service)', () => {
    const template = synth();
    const kvs = allStatements(template).filter((s) => s.Sid === 'KvsManagedTurn');
    expect(kvs).toHaveLength(1);
    const actions = kvs[0].Action as string[];
    expect(actions).toEqual(
      expect.arrayContaining([
        'kinesisvideo:DescribeSignalingChannel',
        'kinesisvideo:GetSignalingChannelEndpoint',
        'kinesisvideo:GetIceServerConfig',
      ]),
    );
    // Resource is the channel ARN pattern (Fn::Sub over the channel name), not '*'.
    expect(kvs[0].Resource).not.toBe('*');
    expect(JSON.stringify(kvs[0].Resource)).toContain('channel/');
  });

  test('Call Runtime ARN is a CfnOutput named AgentRuntimeArn with NO Export', () => {
    const template = synth();
    const outputs = template.findOutputs('AgentRuntimeArn');
    expect(Object.keys(outputs)).toHaveLength(1);
    const output = Object.values(outputs)[0] as { Export?: unknown };
    expect(output.Export).toBeUndefined();
  });

  test('shared-memory IAM is scoped to the MemoryArn parameter (no wildcard)', () => {
    const template = synth();
    const memoryStatements = allStatements(template).filter(
      (s) => s.Sid === 'SharedMemoryReadWrite',
    );
    expect(memoryStatements).toHaveLength(1);
    const stmt = memoryStatements[0];
    expect(stmt.Resource).toEqual({ Ref: 'MemoryArn' });
    expect(stmt.Resource).not.toBe('*');
    const actions = stmt.Action as string[];
    expect(actions).toEqual(expect.arrayContaining(['bedrock-agentcore:CreateEvent']));
    expect(actions).toEqual(
      expect.arrayContaining(['bedrock-agentcore:RetrieveMemoryRecords']),
    );
  });

  test('Bedrock invoke grants the Nova 2 Sonic bidirectional stream plus InvokeModel', () => {
    const template = synth();
    const bedrock = allStatements(template).filter((s) => s.Sid === 'BedrockInvokeNovaSonic');
    expect(bedrock).toHaveLength(1);
    const raw = bedrock[0].Action as string | string[];
    const actions = Array.isArray(raw) ? raw : [raw];
    expect(actions).toEqual(
      expect.arrayContaining([
        'bedrock:InvokeModelWithBidirectionalStream',
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ]),
    );
    expect(actions).not.toContain('bedrock:Converse');
  });

  test('deployment-prefix discipline holds on the runtime IAM role name', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: {
        'Fn::Sub': ['${P}-wa-call-runtime-role', { P: { Ref: 'DeploymentPrefix' } }],
      },
    });
  });
});
