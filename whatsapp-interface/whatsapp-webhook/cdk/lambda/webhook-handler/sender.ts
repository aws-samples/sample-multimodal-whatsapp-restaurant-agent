// WhatsApp Sender Lambda - direct-invoke message delivery for the AgentCore
// runtimes (Option C, extended for async reply delivery).
//
// The chat / voicenotes runtimes invoke THIS Lambda (RequestResponse) once per
// message they want to send. Why a Lambda instead of the runtime calling Meta
// directly:
//   - The Access_Token (Secrets Manager) and the recipient phone (PII) stay in
//     the Lambda tier; the runtime only ever passes { customer_id, ... }.
//   - The wa- customer_id is a NON-REVERSIBLE hash, so the recipient wa_id is
//     resolved here from the 24-hour window table (recorded at inbound time).
//   - The battle-tested delivery path (24-hour window routing, retry/backoff,
//     Utility-template fallback, metrics) is reused verbatim from
//     whatsappClient.ts - no logic is duplicated.
//
// Invoke contract (a backward-compatible discriminated union on `kind`):
//   text (default when `kind` is absent, so the existing chat-runtime payload
//         is unchanged):
//     { "kind":"text", "customer_id":"wa-...", "text":"...", "channel":"chat" }
//   audio (async voice-note reply delivery - the audio bytes travel IN the
//          invoke payload, never staged at rest):
//     { "kind":"audio", "customer_id":"wa-...", "audio_b64":"<ogg opus b64>",
//       "channel":"voicenote" }
//   typing (best-effort activity indicator refresh across a long turn; needs
//           only the INBOUND message id, no recipient resolution):
//     { "kind":"typing", "message_id":"wamid...." }
//
//   -> { "ok": true }                       on a 2xx send (or a relayed typing)
//   -> { "ok": false, "reason": "<why>" }   on any non-send (validation, no
//                                            recipient, token, delivery)
//
// Sending in order is the caller's responsibility: a runtime that wants an
// interim "one moment" message followed by a final answer simply invokes this
// Lambda in sequence (awaiting each), which preserves ordering.

import { getContact } from './lib/windowTable.js';
import { sendAudio, sendText, sendTypingIndicator } from './lib/whatsappClient.js';

export type SenderKind = 'text' | 'audio' | 'typing';

export interface SenderRequest {
  /** Delivery kind. Defaults to 'text' when absent (back-compat). */
  kind?: SenderKind;
  customer_id?: string;
  text?: string;
  /** base64 Ogg Opus voice reply, for kind:'audio'. */
  audio_b64?: string;
  /** INBOUND WhatsApp message id, for kind:'typing'. */
  message_id?: string;
  /** Metrics attribution: 'chat' | 'voicenote' | ... Defaults to 'chat'. */
  channel?: string;
}

export interface SenderResult {
  ok: boolean;
  reason?: string;
}

// Injectable seams so the orchestration is unit-testable without AWS/network,
// matching the project's pure-with-injection style (e.g. callsSignaling CallDeps).
export interface SenderDeps {
  loadToken: () => Promise<string>;
  resolveRecipient: (customerId: string) => Promise<string | null>;
  send: (
    recipient: string,
    text: string,
    token: string,
    customerId: string,
    channel: string,
  ) => Promise<boolean>;
  sendAudio: (
    recipient: string,
    ogg: Buffer,
    token: string,
    customerId: string,
    channel: string,
  ) => Promise<boolean>;
  sendTyping: (messageId: string, token: string) => Promise<void>;
}

let accessTokenCache: string | undefined;

async function loadAccessToken(): Promise<string> {
  if (accessTokenCache !== undefined) return accessTokenCache;
  const name = process.env.ACCESS_TOKEN_SECRET_NAME;
  if (!name) {
    console.error('ACCESS_TOKEN_SECRET_NAME not set; cannot load the Access_Token');
    return '';
  }
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const resp = await client.send(new GetSecretValueCommand({ SecretId: name }));
    accessTokenCache = resp.SecretString ?? '';
  } catch (err) {
    console.error(`failed to load the Access_Token from secret ${name}: ${String(err)}`);
    return '';
  }
  return accessTokenCache;
}

/** Deliver a text reply: resolve the recipient wa_id and send via the shared
 *  window-routed delivery path. */
async function deliverText(req: SenderRequest, deps: SenderDeps): Promise<SenderResult> {
  const customerId = (req?.customer_id ?? '').trim();
  const text = (req?.text ?? '').trim();
  const channel = req?.channel || 'chat';

  if (!customerId) return { ok: false, reason: 'missing_customer_id' };
  if (!text) return { ok: false, reason: 'empty_text' };

  const token = await deps.loadToken();
  if (!token) return { ok: false, reason: 'token_unavailable' };

  const recipient = await deps.resolveRecipient(customerId);
  if (!recipient) {
    console.warn(`no recipient wa_id recorded for ${customerId}; cannot send`);
    return { ok: false, reason: 'no_recipient' };
  }

  const ok = await deps.send(recipient, text, token, customerId, channel);
  return ok ? { ok: true } : { ok: false, reason: 'delivery_failed' };
}

/** Deliver a voice-note reply: decode the in-payload Ogg Opus bytes, resolve the
 *  recipient wa_id, and send via the two-step Media upload + type:audio send.
 *  The audio bytes are carried in the invoke payload (base64) and never stored
 *  at rest (async-reply-delivery R3.7). */
async function deliverAudio(req: SenderRequest, deps: SenderDeps): Promise<SenderResult> {
  const customerId = (req?.customer_id ?? '').trim();
  const audioB64 = (req?.audio_b64 ?? '').trim();
  const channel = req?.channel || 'voicenote';

  if (!customerId) return { ok: false, reason: 'missing_customer_id' };
  if (!audioB64) return { ok: false, reason: 'empty_audio' };

  let ogg: Buffer;
  try {
    ogg = Buffer.from(audioB64, 'base64');
  } catch {
    return { ok: false, reason: 'bad_audio_b64' };
  }
  if (ogg.length === 0) return { ok: false, reason: 'empty_audio' };

  const token = await deps.loadToken();
  if (!token) return { ok: false, reason: 'token_unavailable' };

  const recipient = await deps.resolveRecipient(customerId);
  if (!recipient) {
    console.warn(`no recipient wa_id recorded for ${customerId}; cannot send audio`);
    return { ok: false, reason: 'no_recipient' };
  }

  const ok = await deps.sendAudio(recipient, ogg, token, customerId, channel);
  return ok ? { ok: true } : { ok: false, reason: 'delivery_failed' };
}

/** Relay the WhatsApp "typing..." indicator for an inbound message. Best-effort:
 *  needs only the inbound message id + token (no recipient resolution), never
 *  throws, and a failure is reported as ok:false without disrupting the caller
 *  (the runtime treats typing as fire-and-forget). */
async function deliverTyping(req: SenderRequest, deps: SenderDeps): Promise<SenderResult> {
  const messageId = (req?.message_id ?? '').trim();
  if (!messageId) return { ok: false, reason: 'missing_message_id' };

  const token = await deps.loadToken();
  if (!token) return { ok: false, reason: 'token_unavailable' };

  await deps.sendTyping(messageId, token);
  return { ok: true };
}

/** Pure-with-injection core: route by `kind` (default 'text' for back-compat),
 *  validate, resolve the recipient where needed, and deliver via the injected
 *  functions. Never throws - every failure mode maps to { ok:false, reason }. */
export async function deliver(req: SenderRequest, deps: SenderDeps): Promise<SenderResult> {
  const kind: SenderKind = req?.kind ?? 'text';
  switch (kind) {
    case 'audio':
      return deliverAudio(req, deps);
    case 'typing':
      return deliverTyping(req, deps);
    case 'text':
      return deliverText(req, deps);
    default:
      return { ok: false, reason: 'unknown_kind' };
  }
}

const realDeps: SenderDeps = {
  loadToken: loadAccessToken,
  resolveRecipient: async (customerId) => (await getContact(customerId)).waId,
  send: sendText,
  sendAudio,
  sendTyping: sendTypingIndicator,
};

/** AgentCore-runtime-invoked entry point. The event IS the JSON payload (this
 *  is a direct Lambda invoke, not an API Gateway proxy event). */
export async function handler(event: SenderRequest): Promise<SenderResult> {
  return deliver(event ?? {}, realDeps);
}

/** Test helper - clears the module-level access-token cache. */
export function resetAccessTokenForTests(): void {
  accessTokenCache = undefined;
}
