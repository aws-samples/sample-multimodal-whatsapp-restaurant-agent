// Unit tests for the WhatsApp Sender Lambda orchestration (Option C, extended
// for async reply delivery).
//
// Exercises the pure-with-injection `deliver()` core with stubbed deps so no
// AWS or network is touched. The real delivery path (window routing, retry,
// template fallback, metrics) is covered by the whatsappClient tests; here we
// lock the sender's contract: route by `kind` (text | audio | typing) ->
// validate -> resolve recipient (where needed) -> send.

import { deliver, type SenderDeps } from '../lambda/webhook-handler/sender';

interface SendCapture {
  recipient: string;
  text: string;
  token: string;
  customerId: string;
  channel: string;
}

interface AudioCapture {
  recipient: string;
  bytes: number;
  token: string;
  customerId: string;
  channel: string;
}

interface TypingCapture {
  messageId: string;
  token: string;
}

function makeDeps(overrides: Partial<SenderDeps> = {}): {
  deps: SenderDeps;
  sends: SendCapture[];
  audios: AudioCapture[];
  typings: TypingCapture[];
} {
  const sends: SendCapture[] = [];
  const audios: AudioCapture[] = [];
  const typings: TypingCapture[] = [];
  const deps: SenderDeps = {
    loadToken: async () => 'tok',
    resolveRecipient: async () => '15551230000',
    send: async (recipient, text, token, customerId, channel) => {
      sends.push({ recipient, text, token, customerId, channel });
      return true;
    },
    sendAudio: async (recipient, ogg, token, customerId, channel) => {
      audios.push({ recipient, bytes: ogg.length, token, customerId, channel });
      return true;
    },
    sendTyping: async (messageId, token) => {
      typings.push({ messageId, token });
    },
    ...overrides,
  };
  return { deps, sends, audios, typings };
}

describe('sender deliver() - text (default kind)', () => {
  test('happy path: resolves recipient and sends, returns ok', async () => {
    const { deps, sends } = makeDeps();
    const res = await deliver({ customer_id: 'wa-1f0c3a9b2e4d6f80', text: 'hello' }, deps);
    expect(res).toEqual({ ok: true });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      recipient: '15551230000',
      text: 'hello',
      token: 'tok',
      customerId: 'wa-1f0c3a9b2e4d6f80',
      channel: 'chat',
    });
  });

  test('explicit kind:text behaves identically to the default', async () => {
    const { deps, sends } = makeDeps();
    const res = await deliver({ kind: 'text', customer_id: 'wa-x', text: 'hi' }, deps);
    expect(res).toEqual({ ok: true });
    expect(sends).toHaveLength(1);
  });

  test('channel is passed through for metrics attribution', async () => {
    const { deps, sends } = makeDeps();
    await deliver({ customer_id: 'wa-x', text: 'hi', channel: 'voicenote' }, deps);
    expect(sends[0].channel).toBe('voicenote');
  });

  test('text is trimmed before sending', async () => {
    const { deps, sends } = makeDeps();
    await deliver({ customer_id: 'wa-x', text: '  hi there  ' }, deps);
    expect(sends[0].text).toBe('hi there');
  });

  test('missing customer_id -> ok:false, no send', async () => {
    const { deps, sends } = makeDeps();
    const res = await deliver({ text: 'hi' }, deps);
    expect(res).toEqual({ ok: false, reason: 'missing_customer_id' });
    expect(sends).toHaveLength(0);
  });

  test('empty / whitespace-only text -> ok:false, no send', async () => {
    const { deps, sends } = makeDeps();
    const res = await deliver({ customer_id: 'wa-x', text: '   ' }, deps);
    expect(res).toEqual({ ok: false, reason: 'empty_text' });
    expect(sends).toHaveLength(0);
  });

  test('token unavailable -> ok:false, recipient never resolved', async () => {
    let resolved = 0;
    const { deps } = makeDeps({
      loadToken: async () => '',
      resolveRecipient: async () => {
        resolved += 1;
        return '15551230000';
      },
    });
    const res = await deliver({ customer_id: 'wa-x', text: 'hi' }, deps);
    expect(res).toEqual({ ok: false, reason: 'token_unavailable' });
    expect(resolved).toBe(0);
  });

  test('no recipient recorded -> ok:false no_recipient, no send', async () => {
    const { deps, sends } = makeDeps({ resolveRecipient: async () => null });
    const res = await deliver({ customer_id: 'wa-x', text: 'hi' }, deps);
    expect(res).toEqual({ ok: false, reason: 'no_recipient' });
    expect(sends).toHaveLength(0);
  });

  test('delivery failure surfaces as ok:false delivery_failed', async () => {
    const { deps } = makeDeps({ send: async () => false });
    const res = await deliver({ customer_id: 'wa-x', text: 'hi' }, deps);
    expect(res).toEqual({ ok: false, reason: 'delivery_failed' });
  });
});

describe('sender deliver() - audio', () => {
  const oggB64 = Buffer.from('fake-ogg-opus-bytes').toString('base64');

  test('happy path: decodes audio, resolves recipient, sends audio', async () => {
    const { deps, audios, sends } = makeDeps();
    const res = await deliver(
      { kind: 'audio', customer_id: 'wa-x', audio_b64: oggB64 },
      deps,
    );
    expect(res).toEqual({ ok: true });
    expect(sends).toHaveLength(0);
    expect(audios).toHaveLength(1);
    expect(audios[0]).toMatchObject({
      recipient: '15551230000',
      bytes: Buffer.from('fake-ogg-opus-bytes').length,
      token: 'tok',
      customerId: 'wa-x',
      channel: 'voicenote',
    });
  });

  test('channel override is honored', async () => {
    const { deps, audios } = makeDeps();
    await deliver({ kind: 'audio', customer_id: 'wa-x', audio_b64: oggB64, channel: 'vn2' }, deps);
    expect(audios[0].channel).toBe('vn2');
  });

  test('missing customer_id -> ok:false, no send', async () => {
    const { deps, audios } = makeDeps();
    const res = await deliver({ kind: 'audio', audio_b64: oggB64 }, deps);
    expect(res).toEqual({ ok: false, reason: 'missing_customer_id' });
    expect(audios).toHaveLength(0);
  });

  test('empty audio_b64 -> ok:false empty_audio', async () => {
    const { deps, audios } = makeDeps();
    const res = await deliver({ kind: 'audio', customer_id: 'wa-x', audio_b64: '' }, deps);
    expect(res).toEqual({ ok: false, reason: 'empty_audio' });
    expect(audios).toHaveLength(0);
  });

  test('token unavailable -> ok:false, recipient never resolved', async () => {
    let resolved = 0;
    const { deps } = makeDeps({
      loadToken: async () => '',
      resolveRecipient: async () => {
        resolved += 1;
        return '15551230000';
      },
    });
    const res = await deliver({ kind: 'audio', customer_id: 'wa-x', audio_b64: oggB64 }, deps);
    expect(res).toEqual({ ok: false, reason: 'token_unavailable' });
    expect(resolved).toBe(0);
  });

  test('no recipient -> ok:false no_recipient, no send', async () => {
    const { deps, audios } = makeDeps({ resolveRecipient: async () => null });
    const res = await deliver({ kind: 'audio', customer_id: 'wa-x', audio_b64: oggB64 }, deps);
    expect(res).toEqual({ ok: false, reason: 'no_recipient' });
    expect(audios).toHaveLength(0);
  });

  test('audio delivery failure -> ok:false delivery_failed', async () => {
    const { deps } = makeDeps({ sendAudio: async () => false });
    const res = await deliver({ kind: 'audio', customer_id: 'wa-x', audio_b64: oggB64 }, deps);
    expect(res).toEqual({ ok: false, reason: 'delivery_failed' });
  });
});

describe('sender deliver() - typing', () => {
  test('happy path: relays the indicator with only a message id', async () => {
    const { deps, typings, sends, audios } = makeDeps();
    const res = await deliver({ kind: 'typing', message_id: 'wamid.ABC' }, deps);
    expect(res).toEqual({ ok: true });
    expect(typings).toEqual([{ messageId: 'wamid.ABC', token: 'tok' }]);
    expect(sends).toHaveLength(0);
    expect(audios).toHaveLength(0);
  });

  test('missing message_id -> ok:false missing_message_id, no relay', async () => {
    const { deps, typings } = makeDeps();
    const res = await deliver({ kind: 'typing' }, deps);
    expect(res).toEqual({ ok: false, reason: 'missing_message_id' });
    expect(typings).toHaveLength(0);
  });

  test('token unavailable -> ok:false, no relay', async () => {
    const { deps, typings } = makeDeps({ loadToken: async () => '' });
    const res = await deliver({ kind: 'typing', message_id: 'wamid.ABC' }, deps);
    expect(res).toEqual({ ok: false, reason: 'token_unavailable' });
    expect(typings).toHaveLength(0);
  });
});

describe('sender deliver() - unknown kind', () => {
  test('an unrecognized kind -> ok:false unknown_kind', async () => {
    const { deps } = makeDeps();
    // deliberately bypass the type to simulate a malformed payload
    const res = await deliver({ kind: 'bogus' as never, customer_id: 'wa-x', text: 'hi' }, deps);
    expect(res).toEqual({ ok: false, reason: 'unknown_kind' });
  });
});
