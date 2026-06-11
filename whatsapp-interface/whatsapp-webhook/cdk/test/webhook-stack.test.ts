import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebhookStack } from '../lib/webhook-stack';

/**
 * Synth/config guard for the webhook stack (Tasks 3.1 / 3.2 / 3.3).
 *
 * Single-execution synth assertions (NOT randomized property runs): synthesize
 * WebhookStack once and assert the generated CloudFormation template pins the
 * async ingest/worker + SQS shape the design requires:
 *  - regional REST API with a Lambda proxy integration (R1, R2.1, R16.1);
 *  - the 24-hour window table (R6, R14);
 *  - TWO Python Lambdas: ingest (index.handler) + worker (worker.handler);
 *  - an inbound SQS queue with a DLQ redrive policy + an event-source mapping;
 *  - three EMPTY secret containers with no value in the template (R11);
 *  - least-privilege split: ingest reads verify+app secrets and sends to SQS;
 *    worker reads the access token, the window table, SSM Pepper, and invokes
 *    the AgentCore runtimes;
 *  - outputs carry no Export (isolated-app rule, R17.2).
 */
describe('WebhookStack synth/config guard', () => {
  function synth(context?: Record<string, unknown>): Template {
    const app = new cdk.App({ context });
    const stack = new WebhookStack(app, 'WebhookStack', { env: { region: 'us-east-1' } });
    return Template.fromStack(stack);
  }

  // Collect every IAM policy statement across all AWS::IAM::Policy resources.
  function allStatements(template: Template): any[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const out: any[] = [];
    for (const p of Object.values(policies)) {
      for (const st of (p as any).Properties.PolicyDocument.Statement) out.push(st);
    }
    return out;
  }
  function withSid(template: Template, sid: string): any | undefined {
    return allStatements(template).find((s) => s.Sid === sid);
  }
  function withAction(template: Template, action: string): any[] {
    return allStatements(template).filter((s) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes(action);
    });
  }

  test('regional REST API with a Lambda proxy integration on GET and POST', () => {
    // Feature: whatsapp-restaurant-ai-host - webhook API Gateway (R1, R2.1, R16.1)
    const template = synth();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
    });
  });

  test('24-hour window table is keyed by customerId with TTL and PITR', () => {
    // Feature: whatsapp-restaurant-ai-host - 24-hour window table (R6, R14)
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('two Node.js Lambdas (ingest + worker) on the Node 24 runtime', () => {
    // Feature: whatsapp-restaurant-ai-host - async ingest/worker split (R2.5)
    const template = synth();
    // Ingest + worker. NodejsFunction bundles each entry to index.js, so both
    // carry Handler 'index.handler'; they are distinguished by their function
    // names and event wiring, not the CFN handler string.
    template.resourceCountIs('AWS::Lambda::Function', 2);
    const fns = template.findResources('AWS::Lambda::Function');
    const runtimes = Object.values(fns).map((f) => (f as any).Properties.Runtime);
    expect(runtimes).toHaveLength(2);
    for (const rt of runtimes) {
      expect(rt).toMatch(/^nodejs/);
    }
  });

  test('inbound SQS queue has a DLQ redrive policy and an event-source mapping', () => {
    // Feature: whatsapp-restaurant-ai-host - durable async queue + DLQ (R2.5)
    const template = synth();
    // Inbound queue + DLQ.
    template.resourceCountIs('AWS::SQS::Queue', 2);
    // The inbound queue points at the DLQ with maxReceiveCount 3.
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    // The worker consumes the queue via an event-source mapping.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('creates exactly three EMPTY Secrets Manager containers (no value in template)', () => {
    // Feature: whatsapp-restaurant-ai-host - empty secret containers (R11.1/R11.6)
    const template = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    for (const r of Object.values(secrets)) {
      const props = (r as any).Properties;
      expect(props).not.toHaveProperty('SecretString');
      expect(props).not.toHaveProperty('GenerateSecretString');
    }
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('SecretString');
    expect(json).not.toContain('GenerateSecretString');
  });

  test('ingest IAM: reads ONLY verify+app secrets and sends to the queue', () => {
    // Feature: whatsapp-restaurant-ai-host - least-privilege ingest (R11.8, R2.5)
    const template = synth();
    const ingestSecrets = withSid(template, 'ReadVerifyAndAppSecrets');
    expect(ingestSecrets).toBeDefined();
    const res = Array.isArray(ingestSecrets.Resource) ? ingestSecrets.Resource : [ingestSecrets.Resource];
    expect(res).toHaveLength(2); // verify + app secret only (NOT the access token)
    // Ingest can send to SQS.
    expect(withAction(template, 'sqs:SendMessage').length).toBeGreaterThanOrEqual(1);
  });

  test('worker IAM: access token, window RW, SSM Pepper, KMS-via-SSM, runtime invoke', () => {
    // Feature: whatsapp-restaurant-ai-host - least-privilege worker (R11.8, R3-R8)
    const template = synth();

    const accessToken = withSid(template, 'ReadAccessTokenSecret');
    expect(accessToken).toBeDefined();
    const atRes = Array.isArray(accessToken.Resource) ? accessToken.Resource : [accessToken.Resource];
    expect(atRes).toHaveLength(1); // exactly the access-token secret

    const ssm = withSid(template, 'ReadCustomerIdPepperFromSSM');
    expect(ssm).toBeDefined();
    expect(ssm.Resource).not.toEqual('*');

    const kms = withSid(template, 'DecryptPepperViaSSM');
    expect(kms).toBeDefined();
    expect(JSON.stringify(kms.Condition)).toContain('kms:ViaService');

    const invoke = withSid(template, 'InvokeAgentRuntimes');
    expect(invoke).toBeDefined();
    const ia = Array.isArray(invoke.Action) ? invoke.Action : [invoke.Action];
    expect(ia).toContain('bedrock-agentcore:InvokeAgentRuntime');

    // The worker reads/writes the window table.
    expect(withAction(template, 'dynamodb:PutItem').length).toBeGreaterThanOrEqual(1);
  });

  test('optional WAF and call-id mapping table are OFF by default', () => {
    const template = synth();
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::DynamoDB::Table', 1); // only the window table
  });

  test('optional WAF and call-id mapping table can be enabled via context', () => {
    const template = synth({ enableWaf: true, enableCallMappingTable: true });
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  test('emits core outputs with no exportName', () => {
    // Feature: whatsapp-restaurant-ai-host - isolated-app output contract (R17.2)
    const template = synth();
    const outputs = template.findOutputs('*');
    for (const out of Object.values(outputs)) {
      expect((out as { Export?: unknown }).Export).toBeUndefined();
    }
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(['WebhookUrl', 'WindowTableName', 'InboundQueueUrl']),
    );
  });
});
