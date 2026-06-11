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
import { parseMessages, iterRawEvents, normalizeMessage, routeOf, ROUTE_CHAT, ROUTE_VOICENOTE, ROUTE_IGNORE } from '../lambda/webhook-handler/lib/dispatch';
import { textWithinBounds, novaFormatFor, shouldInvoke } from '../lambda/webhook-handler/lib/textHandler';
import { isWindowOpen, WINDOW_SECONDS } from '../lambda/webhook-handler/lib/windowTable';
import { runtimeSessionId } from '../lambda/webhook-handler/lib/runtimeClient';
import {
  decideRoute,
  isRetryableStatus,
  sendWithRetry,
  sendText,
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
