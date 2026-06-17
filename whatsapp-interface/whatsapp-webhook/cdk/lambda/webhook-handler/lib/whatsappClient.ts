// Reply Delivery module - Meta Messages API send (Task 9, R4.5/R6/R12).
//
// Responsibilities:
//   - 24-hour window routing (R6.1/R6.2/R6.5): send a free-form message when the
//     customer's window is open; otherwise send an approved Utility template.
//   - Retry + backoff (R12.1-R12.3): up to 4 attempts total on HTTP 429, 5xx, or
//     a >10 s per-attempt timeout, backing off 1s / 2s / 4s; never retry a
//     non-retryable 4xx (log its code + Meta detail).
//   - Window-closed fallback (R6.4): if a free-form send fails because the window
//     is closed at send time, retry once via the Utility template without
//     discarding the content.
//   - Metrics + logging (R12.4-R12.6): on 2xx emit a success metric; on
//     exhaustion or token-unavailable emit a delivery-failure metric and log
//     keyed by Customer_Id (never the raw phone number).
//
// Pure helpers (decideRoute, isRetryableStatus, BACKOFFS_MS, sendWithRetry) are
// separated so Property 7 (window routing) and Property 13 (retry/backoff
// bounds) can be tested without AWS or the network.

import { emitDeliveryFailure, emitDeliverySuccess } from './metrics.js';
import { isWindowOpen, getLastInboundTs } from './windowTable.js';

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const MAX_ATTEMPTS = 4; // 1 initial + 3 retries (R12.1)
export const BACKOFFS_MS = [1000, 2000, 4000]; // between attempts (R12.2)
const ATTEMPT_TIMEOUT_MS = 10_000; // per-attempt timeout (R12.1)

// Meta error codes that mean "message is outside the 24-hour window" - triggers
// the Utility-template fallback (R6.4).
const WINDOW_CLOSED_CODES = new Set([131047, 131026, 131051]);

// Utility template config (the operator approves a template with one body param).
const UTILITY_TEMPLATE_NAME = process.env.UTILITY_TEMPLATE_NAME || 'order_update';
const UTILITY_TEMPLATE_LANG = process.env.UTILITY_TEMPLATE_LANG || 'en_US';

export type Route = 'freeform' | 'template';

/** Pure (Property 7): free-form iff the window is open, else a Utility template. */
export function decideRoute(lastInboundTs: number | null, now: number): Route {
  return isWindowOpen(lastInboundTs, now) ? 'freeform' : 'template';
}

/** Pure (Property 13): 429 and 5xx are retryable; everything else is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface AttemptResult {
  status: number; // HTTP status; 0 means a timeout / network error
  timedOut?: boolean; // true when the per-attempt timeout fired
  errorCode?: number; // Meta error.code, when present
  errorMessage?: string; // Meta error.message, when present
}

export interface RetryOutcome {
  ok: boolean;
  attempts: number;
  last: AttemptResult;
  backoffs: number[]; // the backoff delays actually applied (for tests)
}

/** Pure-with-injection (Property 13): drive `attempt(i)` up to MAX_ATTEMPTS;
 *  stop on the first 2xx; retry only on 429/5xx/timeout with backoff prefix
 *  [1s,2s,4s]; never retry a non-retryable 4xx. `sleep` is injectable so tests
 *  run instantly and can record the backoff sequence. */
export async function sendWithRetry(
  attempt: (i: number) => Promise<AttemptResult>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RetryOutcome> {
  const backoffs: number[] = [];
  let last: AttemptResult = { status: 0 };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    last = await attempt(i);
    if (last.status >= 200 && last.status < 300) {
      return { ok: true, attempts: i + 1, last, backoffs };
    }
    const retryable = last.timedOut === true || last.status === 0 || isRetryableStatus(last.status);
    if (!retryable) {
      return { ok: false, attempts: i + 1, last, backoffs };
    }
    if (i < MAX_ATTEMPTS - 1) {
      const ms = BACKOFFS_MS[i];
      backoffs.push(ms);
      await sleep(ms);
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, last, backoffs };
}

// One HTTP POST to the Messages API with a 10 s per-attempt timeout. Returns an
// AttemptResult (never throws): a timeout/network error becomes {status:0}.
async function postMessage(phoneNumberId: string, token: string, payload: unknown): Promise<AttemptResult> {
  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (resp.ok) return { status: resp.status };
    let errorCode: number | undefined;
    let errorMessage: string | undefined;
    try {
      const body = (await resp.json()) as { error?: { code?: number; message?: string } };
      errorCode = body?.error?.code;
      errorMessage = body?.error?.message;
    } catch {
      /* no JSON body */
    }
    return { status: resp.status, errorCode, errorMessage };
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'AbortError';
    return { status: 0, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function freeformPayload(recipient: string, text: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: text },
  };
}

function templatePayload(recipient: string, text: string) {
  // The approved Utility template carries a single body parameter {{1}} into
  // which we place the reply text (truncated to a safe length).
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template: {
      name: UTILITY_TEMPLATE_NAME,
      language: { code: UTILITY_TEMPLATE_LANG },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1024) }] },
      ],
    },
  };
}

function wasWindowClosed(result: AttemptResult): boolean {
  return result.errorCode !== undefined && WINDOW_CLOSED_CODES.has(result.errorCode);
}

export interface DeliverResult {
  ok: boolean;
  route: Route;
  outcome: RetryOutcome | null;
  configError?: boolean; // PHONE_NUMBER_ID / token unavailable
}

/** Core delivery: route by the 24-hour window, retry per R12, and fall back to
 *  the Utility template if a free-form send is rejected as out-of-window (R6.4).
 *  Emits NO metrics and never throws - callers (sendText / order confirmations)
 *  attach their own success/failure metrics so each surface can identify itself
 *  (e.g. a confirmation failure names the order reference, R14.7). */
export async function deliverWithRouting(
  recipient: string,
  text: string,
  token: string,
  customerId: string,
): Promise<DeliverResult> {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!phoneNumberId || !token) {
    return { ok: false, route: 'freeform', outcome: null, configError: true };
  }
  const lastTs = customerId ? await getLastInboundTs(customerId) : null;
  let route = decideRoute(lastTs, Math.floor(Date.now() / 1000));

  let outcome = await sendWithRetry(() =>
    postMessage(
      phoneNumberId,
      token,
      route === 'freeform' ? freeformPayload(recipient, text) : templatePayload(recipient, text),
    ),
  );

  // Window-closed fallback (R6.4): a free-form send rejected as out-of-window
  // retries ONCE via the Utility template, preserving the content.
  if (!outcome.ok && route === 'freeform' && wasWindowClosed(outcome.last)) {
    console.warn(`free-form send hit a closed window for ${customerId}; retrying via Utility template`);
    route = 'template';
    outcome = await sendWithRetry(() => postMessage(phoneNumberId, token, templatePayload(recipient, text)));
  }

  return { ok: outcome.ok, route, outcome };
}

/** Send a conversational reply (R4.5/R6/R12). Returns true on a 2xx. Never
 *  throws; logs by Customer_Id (never the recipient). */
export async function sendText(
  recipient: string,
  text: string,
  token: string,
  customerId = '',
  channel = 'chat',
): Promise<boolean> {
  const r = await deliverWithRouting(recipient, text, token, customerId);
  if (r.configError) {
    console.error(`cannot send: missing PHONE_NUMBER_ID or token (customer ${customerId})`);
    emitDeliveryFailure(channel, customerId, 'token_or_config_unavailable');
    return false;
  }
  if (r.ok) {
    emitDeliverySuccess(channel, customerId);
    return true;
  }
  console.warn(
    `reply delivery failed for ${customerId} after ${r.outcome?.attempts} attempt(s): ` +
      `status=${r.outcome?.last.status} code=${r.outcome?.last.errorCode ?? '-'} ` +
      `detail=${r.outcome?.last.errorMessage ?? '-'} route=${r.route}`,
  );
  emitDeliveryFailure(channel, customerId, `status_${r.outcome?.last.status}`);
  return false;
}

/** Show the WhatsApp "typing..." indicator while a reply is being prepared
 *  (best-effort UX). A single POST both marks the inbound message read AND
 *  displays the typing bubble, which Meta auto-dismisses when we send our reply
 *  or after ~25 s. Requires the INBOUND message id.
 *
 *  Fire-and-forget by contract: never throws, never blocks the reply path - any
 *  failure (including a missing PHONE_NUMBER_ID / token / message id) is
 *  swallowed, because the indicator is a nicety and must never delay or break
 *  the actual response. NOTE: the Cloud API only exposes a "text" typing
 *  indicator - there is no "recording audio" variant - so voice-note turns also
 *  surface as "typing...". */
export async function sendTypingIndicator(messageId: string, token: string): Promise<void> {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!phoneNumberId || !token || !messageId) return;
  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort: the typing indicator must never block or fail the reply */
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Voice reply (Task 12.5, R7.5): send the VoiceNotes Runtime's Ogg Opus output
// back to the customer as a WhatsApp AUDIO (voice) message. This is a two-step
// flow: upload the Ogg bytes to the Media API to get a media id, then send a
// `type: audio` message referencing it. A voice note reply is always within the
// 24-hour window (the inbound note just opened it), so there is no Utility
// template fallback - if the audio send fails, the caller falls back to a
// could-not-understand TEXT message (which has its own window routing).
// ---------------------------------------------------------------------------

/** Upload Ogg Opus bytes to the Media API and return the media id, or null on
 *  any failure/timeout. The token is never logged. */
async function uploadAudioMedia(
  phoneNumberId: string,
  token: string,
  ogg: Buffer,
): Promise<string | null> {
  const url = `${GRAPH_BASE}/${phoneNumberId}/media`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'audio/ogg');
    form.append('file', new Blob([ogg], { type: 'audio/ogg; codecs=opus' }), 'reply.ogg');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // fetch sets the multipart boundary
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { id?: string };
    return body?.id ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function audioPayload(recipient: string, mediaId: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'audio',
    audio: { id: mediaId },
  };
}

/** Send an Ogg Opus voice reply (R7.5). Uploads the bytes, then sends a
 *  type:audio message with retry per R12. Returns true on a 2xx send. Never
 *  throws; logs by Customer_Id (never the recipient). */
export async function sendAudio(
  recipient: string,
  ogg: Buffer,
  token: string,
  customerId = '',
  channel = 'voicenote',
): Promise<boolean> {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!phoneNumberId || !token) {
    console.error(`cannot send audio: missing PHONE_NUMBER_ID or token (customer ${customerId})`);
    emitDeliveryFailure(channel, customerId, 'token_or_config_unavailable');
    return false;
  }
  const mediaId = await uploadAudioMedia(phoneNumberId, token, ogg);
  if (!mediaId) {
    console.warn(`audio media upload failed for ${customerId}`);
    emitDeliveryFailure(channel, customerId, 'audio_upload_failed');
    return false;
  }
  const outcome = await sendWithRetry(() =>
    postMessage(phoneNumberId, token, audioPayload(recipient, mediaId)),
  );
  if (outcome.ok) {
    emitDeliverySuccess(channel, customerId);
    return true;
  }
  console.warn(
    `audio reply delivery failed for ${customerId} after ${outcome.attempts} attempt(s): ` +
      `status=${outcome.last.status} code=${outcome.last.errorCode ?? '-'} ` +
      `detail=${outcome.last.errorMessage ?? '-'}`,
  );
  emitDeliveryFailure(channel, customerId, `status_${outcome.last.status}`);
  return false;
}
