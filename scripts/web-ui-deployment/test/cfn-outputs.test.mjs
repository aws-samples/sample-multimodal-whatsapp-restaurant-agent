import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputsToObject } from '../lib/cfn-outputs.mjs';

test('transforms describe-stacks Outputs into the cdk outputs-file shape', () => {
  const outs = [
    { OutputKey: 'MenuTableName', OutputValue: 'qsr-wa-menu' },
    { OutputKey: 'OrdersTableName', OutputValue: 'qsr-wa-orders', Description: 'ignored' },
  ];
  assert.deepEqual(outputsToObject('DynamoDBStack', outs), {
    DynamoDBStack: { MenuTableName: 'qsr-wa-menu', OrdersTableName: 'qsr-wa-orders' },
  });
});

test('null or empty Outputs yields an empty stack object', () => {
  assert.deepEqual(outputsToObject('NetworkStack', null), { NetworkStack: {} });
  assert.deepEqual(outputsToObject('NetworkStack', []), { NetworkStack: {} });
});

test('entries without an OutputKey are skipped', () => {
  const outs = [{ OutputValue: 'orphan' }, { OutputKey: 'GatewayUrl', OutputValue: 'https://x' }];
  assert.deepEqual(outputsToObject('AgentCoreGatewayStack', outs), {
    AgentCoreGatewayStack: { GatewayUrl: 'https://x' },
  });
});
