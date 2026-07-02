// Worker SQS orchestration for async reply delivery (Task 5): the dedup guard
// wraps dispatch so at-least-once is safe. The window table, handlers, calls
// signaling, and Secrets Manager are mocked so we exercise the claim ->
// dispatch -> (release on failure) flow and the SQS partial-batch response
// without AWS.

const mockClaim = jest.fn();
const mockRelease = jest.fn();
const mockHandleChat = jest.fn();
const mockHandleVoice = jest.fn();
const mockHandleCall = jest.fn();
const mockSecretsSend = jest.fn();

jest.mock('../lambda/webhook-handler/lib/windowTable', () => ({
  claimMessage: (...a: any[]) => mockClaim(...a),
  releaseMessage: (...a: any[]) => mockRelease(...a),
}));
jest.mock('../lambda/webhook-handler/lib/textHandler', () => ({
  handleChatMessage: (...a: any[]) => mockHandleChat(...a),
}));
jest.mock('../lambda/webhook-handler/lib/audioHandler', () => ({
  handleVoiceNote: (...a: any[]) => mockHandleVoice(...a),
}));
jest.mock('../lambda/webhook-handler/lib/callsSignaling', () => ({
  handleCallEvent: (...a: any[]) => mockHandleCall(...a),
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send(cmd: unknown) {
      return mockSecretsSend(cmd);
    }
  },
  GetSecretValueCommand: class {
    input: unknown;
    constructor(i: unknown) {
      this.input = i;
    }
  },
}));

import { handler, resetAccessTokenForTests } from '../lambda/webhook-handler/worker';

function sqsEvent(rawMessage: object, messageId = 'sqs-1') {
  return {
    Records: [{ messageId, body: JSON.stringify({ kind: 'message', data: rawMessage }) }],
  };
}

const textMessage = {
  type: 'text',
  from: '15551230000',
  id: 'wamid.TEXT1',
  timestamp: '1700000000',
  text: { body: 'hello' },
};

beforeEach(() => {
  jest.clearAllMocks();
  resetAccessTokenForTests();
  process.env.ACCESS_TOKEN_SECRET_NAME = 'test-access-token';
  mockSecretsSend.mockResolvedValue({ SecretString: 'tok' });
  mockClaim.mockResolvedValue('claimed');
  mockRelease.mockResolvedValue(undefined);
  mockHandleChat.mockResolvedValue({ status: 'accepted' });
  mockHandleVoice.mockResolvedValue({ status: 'accepted' });
});

test('claimed message -> dispatched, no release, no batch failures', async () => {
  const res = await handler(sqsEvent(textMessage));
  expect(mockClaim).toHaveBeenCalledWith('wamid.TEXT1');
  expect(mockHandleChat).toHaveBeenCalledTimes(1);
  expect(mockRelease).not.toHaveBeenCalled();
  expect(res.batchItemFailures).toEqual([]);
});

test('duplicate delivery -> NOT dispatched, no batch failure (message removed)', async () => {
  mockClaim.mockResolvedValue('duplicate');
  const res = await handler(sqsEvent(textMessage));
  expect(mockHandleChat).not.toHaveBeenCalled();
  expect(res.batchItemFailures).toEqual([]);
});

test('dispatch failure -> release claim + report the SQS item as failed (retry/DLQ)', async () => {
  mockHandleChat.mockRejectedValue(new Error('Chat Runtime dispatch failed'));
  const res = await handler(sqsEvent(textMessage, 'sqs-99'));
  expect(mockRelease).toHaveBeenCalledWith('wamid.TEXT1');
  expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-99' }]);
});

test('claim itself failing -> reported as a batch failure (worker retries)', async () => {
  mockClaim.mockRejectedValue(new Error('throttled'));
  const res = await handler(sqsEvent(textMessage, 'sqs-7'));
  expect(mockHandleChat).not.toHaveBeenCalled();
  expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-7' }]);
});
