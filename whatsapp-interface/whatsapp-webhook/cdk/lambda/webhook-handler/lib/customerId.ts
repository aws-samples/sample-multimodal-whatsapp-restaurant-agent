// Cross-channel Customer_Id derivation for the WhatsApp webhook (R3).
//
// customer_id = "wa-" + sha256(E164 || Pepper)[:16] - a pure function of the
// normalized E.164 sender and the shared Pepper, EXACTLY 19 characters. This is
// the same SHA-256 pepper-hash construction the telephony agent uses (prefix
// "pstn-" there), so a customer's WhatsApp and phone orders share identity. The
// language differs (Node here vs Python in telephony) but the bytes hashed are
// identical, so the derived ids match (R3.1).
//
// No anonymous fallback: WhatsApp messages always carry a sender, so a
// non-normalizable value is an error (R3.5), never an anonymous session. No
// unpeppered fallback: if the Pepper cannot be loaded, derivation aborts (R3.6).
// The raw phone number is never logged above debug; the Pepper is never logged.

import { createHash } from 'node:crypto';

const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const PREFIX = 'wa-';
const HEX_LEN = 16;
export const CUSTOMER_ID_LEN = PREFIX.length + HEX_LEN; // 19 (R3.1)

export class PhoneNormalizationError extends Error {} // R3.5
export class PepperUnavailableError extends Error {} // R3.6

// Module-level Pepper cache (Buffer). undefined = not yet loaded.
let pepperCache: Buffer | undefined;

/** Normalize a raw sender to E.164 (R3.4). WhatsApp wa_id is usually bare
 *  digits, so prepend '+' when missing, then validate. Throws on anything that
 *  cannot become valid E.164 (no anonymous fallback, R3.5). */
export function normalizeE164(rawFrom: unknown): string {
  if (typeof rawFrom !== 'string') {
    throw new PhoneNormalizationError('sender phone number is not a string');
  }
  let candidate = rawFrom.trim();
  if (!candidate) {
    throw new PhoneNormalizationError('sender phone number is empty');
  }
  if (!candidate.startsWith('+')) {
    candidate = `+${candidate}`;
  }
  if (!E164_REGEX.test(candidate)) {
    // Do NOT include the raw value in the error (R3.7).
    throw new PhoneNormalizationError('sender phone number is not valid E.164');
  }
  return candidate;
}

/** Pure derivation: (rawFrom, pepper) -> "wa-" + sha256(E164 || pepper)[:16].
 *  Deterministic; the test seam for Property 3 (inject a pepper directly). */
export function deriveCustomerId(rawFrom: string, pepper: Buffer): string {
  const e164 = normalizeE164(rawFrom);
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from(e164, 'utf8'), pepper]))
    .digest('hex');
  const customerId = PREFIX + digest.slice(0, HEX_LEN);
  if (customerId.length !== CUSTOMER_ID_LEN) {
    throw new Error('customer_id must be 19 chars');
  }
  return customerId;
}

/** Last 4 digits of the input, or '' if fewer than 4 - a low-sensitivity hint
 *  for logs/metrics when referencing by customer_id alone is not enough. */
export function last4(value: string | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length < 4 ? '' : digits.slice(-4);
}

/** Load the shared Pepper from SSM (SecureString) once per process; cache it.
 *  Never logs the value. Throws PepperUnavailableError if PEPPER_PARAM_NAME is
 *  unset or the fetch fails - NO unpeppered fallback (R3.6). */
export async function loadPepper(): Promise<Buffer> {
  if (pepperCache !== undefined) {
    return pepperCache;
  }
  const paramName = process.env.PEPPER_PARAM_NAME;
  if (!paramName) {
    throw new PepperUnavailableError(
      'PEPPER_PARAM_NAME is not set; cannot load the shared Pepper',
    );
  }
  try {
    // Lazy import so unit tests of the pure functions need no AWS SDK.
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const client = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const resp = await client.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    );
    const value = resp.Parameter?.Value;
    if (!value) {
      throw new Error('empty Pepper parameter');
    }
    pepperCache = Buffer.from(value, 'utf8');
  } catch (err) {
    throw new PepperUnavailableError(
      `failed to load the shared Pepper from SSM parameter ${paramName}`,
    );
  }
  return pepperCache;
}

/** Convenience: load+cache the Pepper, then derive (R3). */
export async function deriveForEvent(rawFrom: string): Promise<string> {
  return deriveCustomerId(rawFrom, await loadPepper());
}

/** Test helper - clears the module-level Pepper cache. */
export function resetPepperForTests(): void {
  pepperCache = undefined;
}
