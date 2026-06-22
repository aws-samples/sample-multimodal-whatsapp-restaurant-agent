// Unit tests for the WhatsApp Sender Lambda orchestration (Option C).
//
// Exercises the pure-with-injection `deliver()` core with stubbed deps so no
// AWS or network is touched. The real delivery path (window routing, retry,
// template fallback, metrics) is covered by the whatsappClient tests; here we
// lock the sender's contract: validate -> resolve recipient -> send.

import { deliver, type SenderDeps } from '../lambda/webhook-handler/sender';

interface SendCapture {
  recipient: string;
  text: string;
  token: string;
  customerId: string;
  channel: string;
}

function makeDeps(overrides: Partial<SenderDeps> = {}): {
  deps: SenderDeps;
  sends: SendCapture[];
} {
  const sends: SendCapture[] = [];
  const deps: SenderDeps = {
    loadToken: async () => 'tok',
    resolveRecipient: async () => '15551230000',
    send: async (recipient, text, token, customerId, channel) => {
      sends.push({ recipient, text, token, customerId, channel });
      return true;
    },
    ...overrides,
  };
  return { deps, sends };
}

describe('sender deliver()', () => {
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
