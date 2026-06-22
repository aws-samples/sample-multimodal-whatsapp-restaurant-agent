// WhatsApp Sender Lambda - direct-invoke message delivery for the AgentCore
// runtimes (Option C).
//
// The chat / voicenotes runtimes invoke THIS Lambda (RequestResponse) once per
// message they want to send. Why a Lambda instead of the runtime calling Meta
// directly:
//   - The Access_Token (Secrets Manager) and the recipient phone (PII) stay in
//     the Lambda tier; the runtime only ever passes { customer_id, text }.
//   - The wa- customer_id is a NON-REVERSIBLE hash, so the recipient wa_id is
//     resolved here from the 24-hour window table (recorded at inbound time).
//   - The battle-tested delivery path (24-hour window routing, retry/backoff,
//     Utility-template fallback, metrics) is reused verbatim from
//     whatsappClient.ts - no logic is duplicated.
//
// Invoke contract (the runtime builds this payload):
//   { "customer_id": "wa-1f0c3a9b2e4d6f80", "text": "...", "channel": "chat" }
//   -> { "ok": true }                       on a 2xx send
//   -> { "ok": false, "reason": "<why>" }   on any non-send (validation, no
//                                            recipient, token, delivery)
//
// Sending in order is the caller's responsibility: a runtime that wants an
// interim "one moment" message followed by a final answer simply invokes this
// Lambda twice in sequence (awaiting each), which preserves ordering.

import { getContact } from './lib/windowTable.js';
import { sendText } from './lib/whatsappClient.js';

export interface SenderRequest {
  customer_id?: string;
  text?: string;
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

/** Pure-with-injection core: validate the request, resolve the recipient, and
 *  send via the injected delivery function. Never throws - every failure mode
 *  maps to { ok:false, reason }. */
export async function deliver(req: SenderRequest, deps: SenderDeps): Promise<SenderResult> {
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

const realDeps: SenderDeps = {
  loadToken: loadAccessToken,
  resolveRecipient: async (customerId) => (await getContact(customerId)).waId,
  send: sendText,
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
