import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MemoryStack } from '../lib/memory-stack';

/**
 * Synth/config guard for the shared AgentCore Memory stack.
 *
 * This is a SINGLE-EXECUTION synth/config assertion (NOT a randomized
 * property run): we synthesize MemoryStack once and assert that the
 * generated CloudFormation template pins the short-term event expiry to 30
 * days and declares exactly the two expected long-term strategy namespaces.
 *
 * The stack declares a `DeploymentPrefix` CfnParameter. A `Template.fromStack`
 * synth does not require supplying that parameter value: the prefix only feeds
 * physical NAMES (via Fn::Sub tokens), while the literals under assertion
 * (`EventExpiryDuration: 30` and the `{actorId}`-templated namespaces) are
 * emitted verbatim regardless of the prefix. So we synth without a parameter
 * value and assert on those literals directly.
 */
describe('MemoryStack synth/config guard', () => {
  function synth(): Template {
    const app = new cdk.App();
    const stack = new MemoryStack(app, 'MemoryStack', {
      env: { region: 'us-east-1' },
    });
    return Template.fromStack(stack);
  }

  test('Property 23: Short-term memory event expiry is 30 days', () => {
    // Feature: whatsapp-restaurant-ai-host, Property 23: Short-term memory event expiry is 30 days
    // **Validates: Requirements 5.1, 5.4, 18.1, 18.2, 18.3, 18.4**
    const template = synth();

    // Exactly one shared memory resource, and its short-term event expiry is 30.
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      EventExpiryDuration: 30,
    });

    // Pull the resource out to assert the precise value (=== 30, not just
    // "matches"), guarding against a future edit to e.g. 7 or 365.
    const memories = template.findResources('AWS::BedrockAgentCore::Memory');
    const memory = Object.values(memories)[0] as {
      Properties: { EventExpiryDuration: number; MemoryStrategies: unknown[] };
    };
    expect(memory.Properties.EventExpiryDuration).toBe(30);
  });

  test('Property 23: exactly the two expected long-term strategy namespaces are present', () => {
    // Feature: whatsapp-restaurant-ai-host, Property 23: Short-term memory event expiry is 30 days
    // **Validates: Requirements 5.1, 5.4, 18.1, 18.2, 18.3, 18.4**
    const template = synth();

    // The two long-term strategies, each namespaced by {actorId}: a semantic
    // insights strategy and a user-preference strategy.
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: Match.arrayWith([
        Match.objectLike({
          SemanticMemoryStrategy: Match.objectLike({
            Namespaces: ['/insights/{actorId}/'],
          }),
        }),
        Match.objectLike({
          UserPreferenceMemoryStrategy: Match.objectLike({
            Namespaces: ['/preferences/{actorId}/'],
          }),
        }),
      ]),
    });

    // Assert EXACTLY two strategies and EXACTLY the two expected namespaces -
    // no extra strategy, no renamed/typo'd namespace slips through.
    const memories = template.findResources('AWS::BedrockAgentCore::Memory');
    const memory = Object.values(memories)[0] as {
      Properties: { MemoryStrategies: Array<Record<string, { Namespaces: string[] }>> };
    };
    const strategies = memory.Properties.MemoryStrategies;
    expect(strategies).toHaveLength(2);

    const namespaces = strategies
      .flatMap((s) => Object.values(s))
      .flatMap((v) => v.Namespaces)
      .sort();
    expect(namespaces).toEqual(['/insights/{actorId}/', '/preferences/{actorId}/']);
  });
});
