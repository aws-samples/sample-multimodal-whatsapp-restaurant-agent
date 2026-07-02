// Worker dispatch behavior for async reply delivery (Task 4).
//
// The worker is now DISPATCH-ONLY: it hands the turn to the runtime, reads only
// the ack, and delivers nothing. These tests mock the AWS-touching lib modules
// so the orchestration (throw-on-dispatch-failure, no reply delivery,
// message_id threading, accepted-status) is exercised without AWS or network.

const mockInvokeChat = jest.fn();
const mockInvokeVoiceNote = jest.fn();
const mockSendText = jest.fn();
const mockSendTypingIndicator = jest.fn();
const mockUpdateInbound = jest.fn();
const mockDownloadVoiceNote = jest.fn();
const mockDownloadMedia = jest.fn();
const mockDeriveForEvent = jest.fn();

jest.mock('../lambda/webhook-handler/lib/runtimeClient', () => ({
  invokeChat: (...a: any[]) => mockInvokeChat(...a),
  invokeVoiceNote: (...a: any[]) => mockInvokeVoiceNote(...a),
}));
jest.mock('../lambda/webhook-handler/lib/whatsappClient', () => ({
  sendText: (...a: any[]) => mockSendText(...a),
  sendTypingIndicator: (...a: any[]) => mockSendTypingIndicator(...a),
  sendAudio: jest.fn(),
}));
jest.mock('../lambda/webhook-handler/lib/windowTable', () => ({
  updateInbound: (...a: any[]) => mockUpdateInbound(...a),
}));
jest.mock('../lambda/webhook-handler/lib/mediaApi', () => ({
  downloadVoiceNote: (...a: any[]) => mockDownloadVoiceNote(...a),
  downloadMedia: (...a: any[]) => mockDownloadMedia(...a),
}));
jest.mock('../lambda/webhook-handler/lib/customerId', () => {
  class PhoneNormalizationError extends Error {}
  class PepperUnavailableError extends Error {}
  return {
    deriveForEvent: (...a: any[]) => mockDeriveForEvent(...a),
    PhoneNormalizationError,
    PepperUnavailableError,
  };
});

import { handleChatMessage } from '../lambda/webhook-handler/lib/textHandler';
import { handleVoiceNote } from '../lambda/webhook-handler/lib/audioHandler';
import type { InboundMessage } from '../lambda/webhook-handler/lib/dispatch';

function textMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    msgType: 'text',
    sender: '15551230000',
    messageId: 'wamid.TEXT1',
    timestamp: 1_700_000_000,
    text: 'hello there',
    mediaId: '',
    mimeType: '',
    filename: '',
    ...overrides,
  };
}

function audioMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    msgType: 'audio',
    sender: '15551230000',
    messageId: 'wamid.AUDIO1',
    timestamp: 1_700_000_000,
    text: '',
    mediaId: 'media-123',
    mimeType: 'audio/ogg',
    filename: '',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeriveForEvent.mockResolvedValue('wa-1f0c3a9b2e4d6f80');
  mockSendText.mockResolvedValue(true);
  mockSendTypingIndicator.mockResolvedValue(undefined);
  mockUpdateInbound.mockResolvedValue(true);
  mockDownloadVoiceNote.mockResolvedValue(Buffer.from('ogg-bytes'));
  mockDownloadMedia.mockResolvedValue(Buffer.from('img-bytes'));
});

describe('handleChatMessage - dispatch only', () => {
  test('accepted ack -> status accepted, NO reply delivered by the worker', async () => {
    mockInvokeChat.mockResolvedValue({ accepted: true });
    const res = await handleChatMessage(textMsg(), 'tok');
    expect(res.status).toBe('accepted');
    // The worker delivers nothing on the happy path (runtime owns delivery).
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('threads the inbound message_id into the invoke payload', async () => {
    mockInvokeChat.mockResolvedValue({ accepted: true });
    await handleChatMessage(textMsg({ messageId: 'wamid.ABC' }), 'tok');
    expect(mockInvokeChat).toHaveBeenCalledTimes(1);
    expect(mockInvokeChat.mock.calls[0][0]).toMatchObject({ message_id: 'wamid.ABC' });
  });

  test('null ack (transport dispatch failure) -> THROWS (SQS retry/DLQ), no fallback', async () => {
    mockInvokeChat.mockResolvedValue(null);
    await expect(handleChatMessage(textMsg(), 'tok')).rejects.toThrow(/dispatch failed/i);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('permanent reject (accepted:false) -> status rejected, no throw', async () => {
    mockInvokeChat.mockResolvedValue({ accepted: false, error: 'missing_customer_id' });
    const res = await handleChatMessage(textMsg(), 'tok');
    expect(res.status).toBe('rejected');
  });
});

describe('handleVoiceNote - dispatch only', () => {
  test('accepted ack -> status accepted, threads message_id + audio_b64', async () => {
    mockInvokeVoiceNote.mockResolvedValue({ accepted: true });
    const res = await handleVoiceNote(audioMsg({ messageId: 'wamid.V1' }), 'tok');
    expect(res.status).toBe('accepted');
    expect(mockInvokeVoiceNote).toHaveBeenCalledTimes(1);
    const payload = mockInvokeVoiceNote.mock.calls[0][0] as { message_id?: string; audio_b64?: string };
    expect(payload.message_id).toBe('wamid.V1');
    expect(typeof payload.audio_b64).toBe('string');
    expect((payload.audio_b64 as string).length).toBeGreaterThan(0);
  });

  test('download failure still dispatches (empty audio) so the runtime can fall back', async () => {
    mockDownloadVoiceNote.mockResolvedValue(null);
    mockInvokeVoiceNote.mockResolvedValue({ accepted: true });
    const res = await handleVoiceNote(audioMsg(), 'tok');
    expect(res.status).toBe('accepted');
    const payload = mockInvokeVoiceNote.mock.calls[0][0] as { audio_b64?: string };
    expect(payload.audio_b64).toBe('');
  });

  test('null ack (transport dispatch failure) -> THROWS', async () => {
    mockInvokeVoiceNote.mockResolvedValue(null);
    await expect(handleVoiceNote(audioMsg(), 'tok')).rejects.toThrow(/dispatch failed/i);
  });
});
