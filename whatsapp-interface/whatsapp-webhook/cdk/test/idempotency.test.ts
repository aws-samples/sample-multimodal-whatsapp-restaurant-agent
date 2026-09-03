// Unit tests for the inbound idempotency guard (async-reply-delivery R6).
//
// claimMessage / releaseMessage make SQS at-least-once safe. The DynamoDB SDK is
// mocked so we assert the conditional-write contract without AWS: first claim
// succeeds, a duplicate maps the ConditionalCheckFailedException to 'duplicate',
// an unexpected error rethrows (so the worker retries rather than double-process),
// and release issues a delete for the namespaced dedup key.

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send(cmd: unknown) {
      return mockSend(cmd);
    }
  },
  PutItemCommand: class {
    input: unknown;
    constructor(i: unknown) {
      this.input = i;
    }
  },
  DeleteItemCommand: class {
    input: unknown;
    constructor(i: unknown) {
      this.input = i;
    }
  },
  GetItemCommand: class {
    input: unknown;
    constructor(i: unknown) {
      this.input = i;
    }
  },
}));

import { claimMessage, releaseMessage } from '../lambda/webhook-handler/lib/windowTable';

const OLD = process.env.WINDOW_TABLE_NAME;
beforeAll(() => {
  process.env.WINDOW_TABLE_NAME = 'test-window';
});
afterAll(() => {
  process.env.WINDOW_TABLE_NAME = OLD;
});
beforeEach(() => mockSend.mockReset());

describe('claimMessage', () => {
  test('first delivery -> claimed, conditional put with namespaced key + ttl', async () => {
    mockSend.mockResolvedValue({});
    const r = await claimMessage('wamid.ABC');
    expect(r).toBe('claimed');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as { input: any };
    expect(cmd.input.TableName).toBe('test-window');
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(customerId)');
    expect(cmd.input.Item.customerId.S).toBe('dedup#wamid.ABC');
    expect(cmd.input.Item.ttl).toBeDefined();
  });

  test('ConditionalCheckFailedException -> duplicate', async () => {
    const err = Object.assign(new Error('already claimed'), {
      name: 'ConditionalCheckFailedException',
    });
    mockSend.mockRejectedValue(err);
    expect(await claimMessage('wamid.ABC')).toBe('duplicate');
  });

  test('unexpected error -> rethrows (worker retries, no double-process)', async () => {
    mockSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    await expect(claimMessage('wamid.ABC')).rejects.toThrow(/ProvisionedThroughput/);
  });

  test('no message id -> claimed, no store call (best-effort)', async () => {
    expect(await claimMessage('')).toBe('claimed');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('releaseMessage', () => {
  test('issues a delete for the namespaced dedup key', async () => {
    mockSend.mockResolvedValue({});
    await releaseMessage('wamid.ABC');
    const cmd = mockSend.mock.calls[0][0] as { input: any };
    expect(cmd.input.TableName).toBe('test-window');
    expect(cmd.input.Key.customerId.S).toBe('dedup#wamid.ABC');
  });

  test('swallows delete errors (TTL is the backstop)', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(releaseMessage('wamid.ABC')).resolves.toBeUndefined();
  });
});
