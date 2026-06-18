// Property + unit tests for the Node.js webhook handler pure logic.
//
// Feature: whatsapp-restaurant-ai-host. Property-based tests use fast-check at a
// minimum of 100 runs (these cover the handler-resident properties that moved
// from Hypothesis to fast-check when the Lambda became Node.js):
//   Property 1: Webhook verification handler decision
//   Property 2: Webhook signature gate
//   Property 3: Customer_Id derivation determinism and format
//   Property 4: Agent input-gate and routing
//   Property 7: 24-hour window routing and state (the pure window predicate)
// Plus unit checks for dispatch parsing/routing and the runtime session id.

import { createHmac } from 'node:crypto';
import * as fc from 'fast-check';

import { verifySubscription, verifySignature } from '../lambda/webhook-handler/index';
import { deriveCustomerId, normalizeE164, CUSTOMER_ID_LEN, PhoneNormalizationError } from '../lambda/webhook-handler/lib/customerId';
import { parseMessages, iterRawEvents, normalizeMessage, parseCallEvent, routeOf, ROUTE_CHAT, ROUTE_VOICENOTE, ROUTE_IGNORE } from '../lambda/webhook-handler/lib/dispatch';
import { textWithinBounds, novaFormatFor, shouldInvoke } from '../lambda/webhook-handler/lib/textHandler';
import { isWindowOpen, WINDOW_SECONDS } from '../lambda/webhook-handler/lib/windowTable';
import { runtimeSessionId } from '../lambda/webhook-handler/lib/runtimeClient';
import {
  decideRoute,
  isRetryableStatus,
  sendWithRetry,
  sendText,
  sendTypingIndicator,
  BACKOFFS_MS,
  MAX_ATTEMPTS,
  type AttemptResult,
} from '../lambda/webhook-handler/lib/whatsappClient';
import {
  renderConfirmation,
  formatReadiness,
  sendOrderConfirmation,
  isOrderStatus,
  ORDER_STATUSES,
  type OrderConfirmation,
} from '../lambda/webhook-handler/lib/orderConfirmation';
import { chooseVoiceReply, COULD_NOT_UNDERSTAND, COULD_NOT_DOWNLOAD } from '../lambda/webhook-handler/lib/audioHandler';
import { callSessionId, type CallAnswer } from '../lambda/webhook-handler/lib/runtimeClient';
import { handleCallEvent, type CallDeps } from '../lambda/webhook-handler/lib/callsSignaling';
import type { CallEvent } from '../lambda/webhook-handler/lib/dispatch';
import type { CallMapping } from '../lambda/webhook-handler/lib/callMap';

const RUNS = { numRuns: 100 };

describe('Property 1: Webhook verification handler decision', () => {
  test('200+challenge iff subscribe + present + token match; else 403/400, no challenge', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }), // verify token
        fc.string({ minLength: 1, maxLength: 40 }), // candidate token
        fc.string({ minLength: 1, maxLength: 64 }), // challenge
        fc.constantFrom('subscribe', 'unsubscribe', 'x', ''),
        (verifyToken, candidate, challenge, mode) => {
          const params = { 'hub.mode': mode, 'hub.verify_token': candidate, 'hub.challenge': challenge };
          const [status, body] = verifySubscription(params, verifyToken);
          if (mode === 'subscribe' && candidate === verifyToken) {
            expect(status).toBe(200);
            expect(body).toBe(challenge);
          } else {
            expect([400, 403]).toContain(status);
            expect(body).toBe('');
          }
        },
      ),
      RUNS,
    );
  });

  test('missing/empty params -> 400 with no challenge (R1.3)', () => {
    fc.assert(
      fc.property(fc.constantFrom('hub.mode', 'hub.verify_token', 'hub.challenge'), (drop) => {
        const params: Record<string, string> = {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'tok',
          'hub.challenge': 'c',
        };
        delete params[drop];
        const [status, body] = verifySubscription(params, 'tok');
        expect(status).toBe(400);
        expect(body).toBe('');
      }),
      RUNS,
    );
  });
});

describe('Property 2: Webhook signature gate', () => {
  test('proceeds iff header is sha256=+constant-time HMAC of the raw body', () => {
    fc.assert(
      fc.property(fc.uint8Array(), fc.string({ minLength: 1, maxLength: 32 }), (bodyArr, secret) => {
        const body = Buffer.from(bodyArr);
        const appSecret = Buffer.from(secret, 'utf8');
        const good = `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
        expect(verifySignature(body, good, appSecret)).toBe(true);
        // Tamper: wrong secret never validates.
        expect(verifySignature(body, good, Buffer.from(secret + 'x', 'utf8'))).toBe(false);
      }),
      RUNS,
    );
  });

  test('malformed / missing headers are rejected (R2.3/R2.4)', () => {
    const body = Buffer.from('hi');
    const secret = Buffer.from('s');
    for (const h of [undefined, '', 'sha256=', 'sha256=zz', 'sha1=' + 'a'.repeat(64), 'a'.repeat(64), `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`]) {
      expect(verifySignature(body, h as any, secret)).toBe(false);
    }
  });
});

describe('Property 3: Customer_Id derivation determinism and format', () => {
  const e164 = fc
    .tuple(fc.integer({ min: 1, max: 9 }), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 13 }))
    .map(([d, rest]) => `+${d}${rest.join('')}`);

  test('deterministic, exactly 19 chars, wa- + 16 hex', () => {
    fc.assert(
      fc.property(e164, fc.uint8Array({ minLength: 0, maxLength: 64 }), (num, pepArr) => {
        const pepper = Buffer.from(pepArr);
        const id1 = deriveCustomerId(num, pepper);
        const id2 = deriveCustomerId(num, pepper);
        expect(id1).toBe(id2);
        expect(id1.length).toBe(CUSTOMER_ID_LEN);
        expect(id1).toMatch(/^wa-[0-9a-f]{16}$/);
      }),
      RUNS,
    );
  });

  test('non-normalizable input throws, derives nothing (R3.5)', () => {
    for (const bad of ['', '   ', 'not-a-number', '+0123', '012345', '+1-202-555-0100']) {
      expect(() => normalizeE164(bad)).toThrow(PhoneNormalizationError);
    }
  });
});

describe('Property 4: Agent input-gate and routing', () => {
  test('textWithinBounds: >=1 non-whitespace and <=4096', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (s) => {
        const expected = s.trim().length > 0 && s.length <= 4096;
        expect(textWithinBounds(s)).toBe(expected);
      }),
      RUNS,
    );
  });

  test('supported attachment counts as content; unsupported/over-long do not', () => {
    expect(shouldInvoke(normalizeMessage({ type: 'text', from: 's', text: { body: 'hi' } }))).toBe(true);
    expect(shouldInvoke(normalizeMessage({ type: 'text', from: 's', text: { body: '  ' } }))).toBe(false);
    expect(shouldInvoke(normalizeMessage({ type: 'image', from: 's', image: { id: 'm', mime_type: 'image/png' } }))).toBe(true);
    expect(shouldInvoke(normalizeMessage({ type: 'image', from: 's', image: { id: 'm', mime_type: 'image/tiff' } }))).toBe(false);
    expect(novaFormatFor('image', 'image/jpeg')).toBe('jpeg');
    expect(novaFormatFor('image', 'image/jpg')).toBe('jpeg');
    expect(novaFormatFor('document', 'application/pdf')).toBe('pdf');
    expect(novaFormatFor('document', 'application/zip')).toBeNull();
    expect(novaFormatFor('image', 'image/jpeg; codecs=foo')).toBe('jpeg');
  });
});

describe('Property 7: 24-hour window routing and state (pure predicate)', () => {
  test('open iff prior inbound exists and now-ts in [0, 86400)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 200000 }), (ts, delta) => {
        const open = isWindowOpen(ts, ts + delta);
        expect(open).toBe(delta < WINDOW_SECONDS);
      }),
      RUNS,
    );
  });
  test('never-opened window is closed', () => {
    expect(isWindowOpen(null, 12345)).toBe(false);
  });
});

describe('dispatch parsing + routing (unit)', () => {
  test('parses and routes a mixed body', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { from: '15551234567', id: 'a', timestamp: '1', type: 'text', text: { body: 'hi' } },
                  { from: '15551234567', id: 'b', timestamp: '2', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'c' } },
                  { from: '15551234567', id: 'c', timestamp: '3', type: 'document', document: { id: 'm2', mime_type: 'application/pdf', filename: 'o.pdf' } },
                  { from: '15551234567', id: 'd', timestamp: '4', type: 'audio', audio: { id: 'm3', mime_type: 'audio/ogg' } },
                  { from: '15551234567', id: 'e', type: 'reaction' },
                ],
              },
            },
            { field: 'statuses', value: { statuses: [{ id: 'x' }] } },
          ],
        },
      ],
    };
    const msgs = parseMessages(body);
    expect(msgs.map(routeOf)).toEqual([ROUTE_CHAT, ROUTE_CHAT, ROUTE_CHAT, ROUTE_VOICENOTE, ROUTE_IGNORE]);
    expect(msgs[1].text).toBe('c');
    expect(msgs[2].filename).toBe('o.pdf');
  });

  test('ingest splits messages AND calls into tagged envelopes', () => {
    const body = {
      entry: [
        {
          changes: [
            { field: 'messages', value: { messages: [{ from: 's', id: 'm1', type: 'text', text: { body: 'hi' } }] } },
            { field: 'calls', value: { calls: [{ id: 'c1', from: 's', event: 'connect', session: { sdp_type: 'offer', sdp: '...' } }] } },
            { field: 'statuses', value: { statuses: [{ id: 'x' }] } },
          ],
        },
      ],
    };
    const events = iterRawEvents(body);
    expect(events.map((e) => e.kind)).toEqual(['message', 'call']); // statuses ignored
    expect(events[0].data.type).toBe('text');
    expect(events[1].data.event).toBe('connect');
  });

  test('parseCallEvent projects the connect offer and a terminate status', () => {
    const connect = parseCallEvent({
      id: 'wacid.ABC',
      event: 'connect',
      from: '15551230000',
      to: '15557890000',
      session: { sdp_type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' },
    });
    expect(connect).toMatchObject({
      id: 'wacid.ABC',
      event: 'connect',
      sdpType: 'offer',
    });
    expect(connect.sdp).toContain('v=0');

    const terminate = parseCallEvent({ id: 'wacid.ABC', event: 'terminate', status: 'COMPLETED' });
    expect(terminate).toMatchObject({ event: 'terminate', status: 'COMPLETED', sdp: '', sdpType: '' });

    // Missing/empty object never throws and yields empty fields.
    expect(parseCallEvent(undefined)).toMatchObject({ id: '', event: '', sdp: '' });
  });
});

describe('runtime session id', () => {
  test('>= 33 chars and deterministic', () => {
    const sid = runtimeSessionId('wa-1f0c3a9b2e4d6f80');
    expect(sid.length).toBeGreaterThanOrEqual(33);
    expect(sid).toBe(runtimeSessionId('wa-1f0c3a9b2e4d6f80'));
  });
});

describe('Property 13: Reply delivery retry and backoff bounds', () => {
  const noSleep = async () => {};

  test('concrete cases: stop on 2xx, retry 429/5xx/timeout, no retry on 4xx', async () => {
    // All 500 -> 4 attempts, backoffs [1000,2000,4000], not ok.
    let r = await sendWithRetry(async () => ({ status: 500 }), noSleep);
    expect(r.attempts).toBe(4);
    expect(r.ok).toBe(false);
    expect(r.backoffs).toEqual(BACKOFFS_MS);

    // 2xx first -> 1 attempt, no backoff.
    r = await sendWithRetry(async () => ({ status: 200 }), noSleep);
    expect(r).toMatchObject({ ok: true, attempts: 1, backoffs: [] });

    // Non-retryable 404 -> 1 attempt, no retry.
    r = await sendWithRetry(async () => ({ status: 404 }), noSleep);
    expect(r).toMatchObject({ ok: false, attempts: 1, backoffs: [] });

    // 500,500,200 -> 3 attempts, ok, backoffs [1000,2000].
    const seq = [500, 500, 200];
    r = await sendWithRetry(async (i) => ({ status: seq[Math.min(i, seq.length - 1)] }), noSleep);
    expect(r).toMatchObject({ ok: true, attempts: 3, backoffs: [1000, 2000] });

    // timeout then 200 -> 2 attempts.
    const seq2: AttemptResult[] = [{ status: 0, timedOut: true }, { status: 200 }];
    r = await sendWithRetry(async (i) => seq2[Math.min(i, seq2.length - 1)], noSleep);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  test('invariants over random status sequences (fast-check)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(200, 201, 429, 500, 503, 400, 404), { minLength: 1, maxLength: 8 }),
        async (statuses) => {
          const r = await sendWithRetry(
            async (i) => ({ status: statuses[Math.min(i, statuses.length - 1)] }),
            noSleep,
          );
          expect(r.attempts).toBeGreaterThanOrEqual(1);
          expect(r.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS); // at most 4
          // backoffs are always a prefix of [1s,2s,4s] and never exceed attempts-1.
          expect(r.backoffs).toEqual(BACKOFFS_MS.slice(0, r.backoffs.length));
          expect(r.backoffs.length).toBeLessThanOrEqual(r.attempts - 1);
          // ok iff the final observed status is 2xx.
          expect(r.ok).toBe(r.last.status >= 200 && r.last.status < 300);
        },
      ),
      RUNS,
    );
  });

  test('isRetryableStatus: 429 + 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('Property 7 (routing) + token-unavailable', () => {
  test('decideRoute: free-form iff window open, else Utility template', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 200000 }), (ts, delta) => {
        const route = decideRoute(ts, ts + delta);
        expect(route).toBe(delta < WINDOW_SECONDS ? 'freeform' : 'template');
      }),
      RUNS,
    );
    expect(decideRoute(null, 12345)).toBe('template'); // never-opened window
  });

  test('sendText with no token / PHONE_NUMBER_ID does not send and returns false (R12.6)', async () => {
    const prev = process.env.PHONE_NUMBER_ID;
    delete process.env.PHONE_NUMBER_ID;
    const ok = await sendText('15551234567', 'hello', '', 'wa-1f0c3a9b2e4d6f80');
    expect(ok).toBe(false);
    if (prev !== undefined) process.env.PHONE_NUMBER_ID = prev;
  });

  test('sendTypingIndicator no-ops (no fetch) when config/message id is missing', async () => {
    const prevId = process.env.PHONE_NUMBER_ID;
    const prevFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      // Missing PHONE_NUMBER_ID -> no call.
      delete process.env.PHONE_NUMBER_ID;
      await sendTypingIndicator('wamid.ABC', 'tok');
      // Config present but no message id / no token -> still no call.
      process.env.PHONE_NUMBER_ID = '123456';
      await sendTypingIndicator('', 'tok');
      await sendTypingIndicator('wamid.ABC', '');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevId !== undefined) process.env.PHONE_NUMBER_ID = prevId;
      else delete process.env.PHONE_NUMBER_ID;
    }
  });

  test('sendTypingIndicator posts a read + text typing_indicator for the inbound message', async () => {
    const prevId = process.env.PHONE_NUMBER_ID;
    const prevFetch = globalThis.fetch;
    let captured: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      process.env.PHONE_NUMBER_ID = '123456';
      await sendTypingIndicator('wamid.XYZ', 'tok');
      expect(captured).not.toBeNull();
      expect(captured!.url).toContain('/123456/messages');
      expect(captured!.body).toMatchObject({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.XYZ',
        typing_indicator: { type: 'text' },
      });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevId !== undefined) process.env.PHONE_NUMBER_ID = prevId;
      else delete process.env.PHONE_NUMBER_ID;
    }
  });

  test('sendTypingIndicator never throws even when fetch rejects', async () => {
    const prevId = process.env.PHONE_NUMBER_ID;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      process.env.PHONE_NUMBER_ID = '123456';
      await expect(sendTypingIndicator('wamid.XYZ', 'tok')).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevId !== undefined) process.env.PHONE_NUMBER_ID = prevId;
      else delete process.env.PHONE_NUMBER_ID;
    }
  });
});

describe('Property 14: Order-confirmation rendering', () => {
  test('always includes the order ref + a system-defined status; readiness is an absolute local timestamp with tz', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /\S/.test(s)),
        fc.constantFrom(...ORDER_STATUSES),
        fc.option(fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }), { nil: undefined }),
        (orderRef, status, readyMs) => {
          const order: OrderConfirmation = { orderRef, status, estimatedReadyAtMs: readyMs };
          const text = renderConfirmation(order, 'America/New_York');
          expect(text).toContain(orderRef); // order reference id present (R14.4)
          expect(text).toContain(status); // status from the system-defined set (R14.4)
          if (readyMs !== undefined) {
            const formatted = formatReadiness(readyMs, 'America/New_York');
            expect(text).toContain(formatted);
            // The readiness string always carries a timezone token (R14.5).
            expect(formatted).toMatch(/[A-Z]{2,5}|GMT|UTC/);
          }
        },
      ),
      RUNS,
    );
  });

  test('isOrderStatus validates the system-defined set', () => {
    for (const s of ORDER_STATUSES) expect(isOrderStatus(s)).toBe(true);
    expect(isOrderStatus('frozen')).toBe(false);
    expect(isOrderStatus('')).toBe(false);
  });

  test('on a failed send the order record is preserved unmodified (R14.7)', async () => {
    const prev = process.env.PHONE_NUMBER_ID;
    delete process.env.PHONE_NUMBER_ID; // force configError -> false, no network
    const order: OrderConfirmation = { orderRef: 'A1B2C3', status: 'received', estimatedReadyAtMs: 1_800_000_000_000 };
    const snapshot = JSON.parse(JSON.stringify(order));
    const ok = await sendOrderConfirmation('15551234567', order, '', 'wa-1f0c3a9b2e4d6f80');
    expect(ok).toBe(false);
    expect(order).toEqual(snapshot); // unmodified
    if (prev !== undefined) process.env.PHONE_NUMBER_ID = prev;
  });
});

// VoiceNotes reply selection (Task 12.5 / 12.7, R7.6 / R7.7 / R7.8). The pure
// decision that routes the voice-note path to an audio reply or a text
// fallback. The live download / invoke / send and the Sonic round-trip are
// covered by the agent's Hypothesis Property 22 and the Task 12.8 integration
// test; here we lock the routing invariant.
describe('VoiceNotes reply selection (R7.6/R7.7/R7.8)', () => {
  test('missing media -> could-not-download text (R7.7/R7.8)', () => {
    const r = chooseVoiceReply({ hasMedia: false, downloaded: false, invoke: null });
    expect(r).toEqual({ kind: 'text', text: COULD_NOT_DOWNLOAD, reason: 'no_media' });
  });

  test('download failed -> could-not-download text (R7.7/R7.8)', () => {
    const r = chooseVoiceReply({ hasMedia: true, downloaded: false, invoke: null });
    expect(r).toEqual({ kind: 'text', text: COULD_NOT_DOWNLOAD, reason: 'download_failed' });
  });

  test('no audio from runtime -> could-not-understand text (R7.6)', () => {
    const r = chooseVoiceReply({ hasMedia: true, downloaded: true, invoke: {} });
    expect(r).toEqual({ kind: 'text', text: COULD_NOT_UNDERSTAND, reason: 'no_audio' });
  });

  test('runtime fallback_text is preferred over the default (R7.6)', () => {
    const r = chooseVoiceReply({
      hasMedia: true,
      downloaded: true,
      invoke: { fallback_text: 'please repeat that' },
    });
    expect(r).toEqual({ kind: 'text', text: 'please repeat that', reason: 'no_audio' });
  });

  test('runtime audio -> audio reply (R7.5), never text', () => {
    const r = chooseVoiceReply({
      hasMedia: true,
      downloaded: true,
      invoke: { audio_b64: 'T2dnUw==' },
    });
    expect(r).toEqual({ kind: 'audio', oggB64: 'T2dnUw==' });
  });

  test('Property: audio reply iff downloaded AND runtime returned audio_b64', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
        (hasMedia, downloaded, audioB64, fallbackText) => {
          const invoke =
            audioB64 === undefined && fallbackText === undefined
              ? null
              : { audio_b64: audioB64, fallback_text: fallbackText };
          const r = chooseVoiceReply({ hasMedia, downloaded, invoke });
          const shouldBeAudio = hasMedia && downloaded && audioB64 !== undefined;
          if (shouldBeAudio) {
            expect(r.kind).toBe('audio');
          } else {
            expect(r.kind).toBe('text');
          }
        },
      ),
      RUNS,
    );
  });
});


// --- Task 17: calls signaling proxy (Property 10 + units) ------------------

function connectEvent(id: string): CallEvent {
  return { id, event: 'connect', from: '15551230000', to: '15559990000', sdpType: 'offer', sdp: 'v=0\r\noffer\r\n', status: '' };
}
function terminateEvent(id: string): CallEvent {
  return { id, event: 'terminate', from: '15551230000', to: '15559990000', sdpType: '', sdp: '', status: 'COMPLETED' };
}

interface FakeBundle {
  deps: CallDeps;
  store: Map<string, CallMapping>;
  offers: Array<{ sessionId: string; callId: string }>;
  disconnects: Array<{ sessionId: string; pcId: string }>;
  actions: Array<{ callId: string; action: string }>;
}

function makeFakeDeps(overrides: Partial<CallDeps> = {}): FakeBundle {
  const store = new Map<string, CallMapping>();
  const offers: FakeBundle['offers'] = [];
  const disconnects: FakeBundle['disconnects'] = [];
  const actions: FakeBundle['actions'] = [];
  const deps: CallDeps = {
    invokeCallOffer: async (sessionId, callId, _sdp): Promise<CallAnswer | null> => {
      offers.push({ sessionId, callId });
      return { call_id: callId, pc_id: `pc-${callId}`, type: 'answer', sdp: 'v=0\r\nANSWER\r\n' };
    },
    invokeCallDisconnect: async (sessionId, pcId): Promise<void> => {
      disconnects.push({ sessionId, pcId });
    },
    sendCallAction: async (callId, action): Promise<boolean> => {
      actions.push({ callId, action });
      return true;
    },
    putMapping: async (callId, m): Promise<boolean> => {
      store.set(callId, m);
      return true;
    },
    getMapping: async (callId): Promise<CallMapping | null> => store.get(callId) ?? null,
    deleteMapping: async (callId): Promise<void> => {
      store.delete(callId);
    },
    deriveCustomerId: async (_from): Promise<string> => 'wa-0123456789abcdef',
    ...overrides,
  };
  return { deps, store, offers, disconnects, actions };
}

describe('callSessionId (pure)', () => {
  test('deterministic, formatted, >= 33 chars', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }), (id) => {
        const s = callSessionId(id);
        expect(s).toBe(callSessionId(id)); // deterministic
        expect(s.length).toBeGreaterThanOrEqual(33);
        expect(/^wa-call-[0-9a-f]{32}$/.test(s)).toBe(true);
      }),
      RUNS,
    );
  });

  test('distinct call ids map to distinct session ids', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), { minLength: 2, maxLength: 12 }),
        (ids) => {
          const sids = new Set(ids.map(callSessionId));
          expect(sids.size).toBe(ids.length);
        },
      ),
      RUNS,
    );
  });
});

describe('Property 10: calls signaling mapping integrity', () => {
  test('each connect creates exactly one mapping; terminate disconnects the matching session; no two active calls share a session-id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 8 }),
        async (callIds) => {
          const fb = makeFakeDeps();
          // Connect every call.
          for (const id of callIds) {
            await handleCallEvent(connectEvent(id), 'tok', fb.deps);
          }
          // Exactly one mapping per call, keyed by call-id.
          expect(fb.store.size).toBe(callIds.length);
          // Exactly one offer per call; session id == callSessionId(callId).
          expect(fb.offers.length).toBe(callIds.length);
          for (const id of callIds) {
            const m = fb.store.get(id)!;
            expect(m).toBeDefined();
            expect(m.sessionId).toBe(callSessionId(id));
            expect(m.pcId).toBe(`pc-${id}`);
          }
          // No two active calls share a session-id.
          const sids = new Set([...fb.store.values()].map((m) => m.sessionId));
          expect(sids.size).toBe(callIds.length);
          // Each connect issued exactly one accept (pre_accept is skipped).
          for (const id of callIds) {
            const a = fb.actions.filter((x) => x.callId === id).map((x) => x.action);
            expect(a).toEqual(['accept']);
          }

          // Terminate every call: disconnect routed to the matching session/pc.
          for (const id of callIds) {
            await handleCallEvent(terminateEvent(id), 'tok', fb.deps);
          }
          expect(fb.store.size).toBe(0);
          expect(fb.disconnects.length).toBe(callIds.length);
          for (const id of callIds) {
            const d = fb.disconnects.find((x) => x.pcId === `pc-${id}`);
            expect(d).toBeDefined();
            expect(d!.sessionId).toBe(callSessionId(id));
          }
        },
      ),
      RUNS,
    );
  });
});

describe('calls signaling (units)', () => {
  test('connect with no offer SDP: no mapping, no accept', async () => {
    const fb = makeFakeDeps();
    const ev = { ...connectEvent('c1'), sdpType: '', sdp: '' };
    await handleCallEvent(ev, 'tok', fb.deps);
    expect(fb.store.size).toBe(0);
    expect(fb.offers.length).toBe(0);
    expect(fb.actions.length).toBe(0);
  });

  test('runtime returns an error: terminate sent to Meta, no mapping', async () => {
    const fb = makeFakeDeps({
      invokeCallOffer: async () => ({ error: 'turn_fetch_failed' }) as CallAnswer,
    });
    await handleCallEvent(connectEvent('c2'), 'tok', fb.deps);
    expect(fb.store.size).toBe(0);
    expect(fb.actions).toEqual([{ callId: 'c2', action: 'terminate' }]);
  });

  test('accept fails: runtime pc is disconnected and mapping deleted', async () => {
    const fb = makeFakeDeps({
      sendCallAction: async (_callId, action) => action !== 'accept',
    });
    // Re-record actions/disconnects via the overridden + default deps. The
    // override replaces sendCallAction; disconnect uses the default recorder.
    await handleCallEvent(connectEvent('c3'), 'tok', fb.deps);
    expect(fb.store.has('c3')).toBe(false);
    expect(fb.disconnects).toEqual([{ sessionId: callSessionId('c3'), pcId: 'pc-c3' }]);
  });

  test('terminate with no mapping: no disconnect', async () => {
    const fb = makeFakeDeps();
    await handleCallEvent(terminateEvent('ghost'), 'tok', fb.deps);
    expect(fb.disconnects.length).toBe(0);
  });

  test('connect tolerates customer_id derivation failure', async () => {
    const fb = makeFakeDeps({
      deriveCustomerId: async () => {
        throw new Error('pepper unavailable');
      },
    });
    await handleCallEvent(connectEvent('c4'), 'tok', fb.deps);
    // Still maps + accepts; customerId recorded as empty.
    expect(fb.store.get('c4')?.customerId).toBe('');
    expect(fb.actions.filter((x) => x.callId === 'c4').map((x) => x.action)).toEqual(['accept']);
  });
});
