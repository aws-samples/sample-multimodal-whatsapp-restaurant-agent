// WhatsApp Webhook Ingest Lambda (API Gateway proxy target).
//
// Fast path only - acknowledges Meta within 5 s (R2.5):
//   GET  -> verification handshake (R1).
//   POST -> signature gate (R2) -> enqueue one SQS message per inbound WhatsApp
//           message -> 200. The slow work (dispatch, Customer_Id, runtime
//           invoke, reply) runs in the Worker Lambda (worker.ts), fully
//           decoupled from this acknowledgement.
//
// Env (identifiers only, never secret values - R11.6): VERIFY_TOKEN_SECRET_NAME,
// APP_SECRET_SECRET_NAME (secret NAMES), INBOUND_QUEUE_URL.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { iterRawEvents } from './lib/dispatch.js';

const HUB_MODE = 'hub.mode';
const HUB_VERIFY_TOKEN = 'hub.verify_token';
const HUB_CHALLENGE = 'hub.challenge';
const SUBSCRIBE_MODE = 'subscribe';
const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_REGEX = /^sha256=[0-9a-fA-F]{64}$/;
const SIGNATURE_PREFIX = 'sha256=';

let verifyTokenCache: string | undefined;
let appSecretCache: Buffer | undefined;

interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function proxyResponse(statusCode: number, body: string): ProxyResponse {
  return { statusCode, headers: { 'Content-Type': 'text/plain' }, body };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pure verification decision (R1). Returns [status, body]; body is "" on any
 *  non-200 so the challenge is never echoed. Test seam for Property 1. */
export function verifySubscription(
  params: Record<string, string | undefined> | null | undefined,
  verifyToken: string,
): [number, string] {
  const p = params ?? {};
  const mode = p[HUB_MODE];
  const token = p[HUB_VERIFY_TOKEN];
  const challenge = p[HUB_CHALLENGE];
  if (!mode || !token || !challenge) return [400, '']; // R1.3
  if (mode !== SUBSCRIBE_MODE) return [400, '']; // R1.4
  if (!constantTimeEquals(token, verifyToken)) return [403, '']; // R1.2
  return [200, challenge]; // R1.1
}

/** Pure signature decision (R2). True iff header is sha256=+64hex and equals
 *  the constant-time HMAC of the raw body under appSecret. Test seam for P2. */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  appSecret: Buffer,
): boolean {
  if (!signatureHeader) return false; // R2.3/R2.4
  if (!SIGNATURE_REGEX.test(signatureHeader)) return false; // R2.4
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase();
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return constantTimeEquals(expectedHex, providedHex); // R2.1/R2.2
}

function headerLookup(headers: Record<string, string | undefined> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v ?? undefined;
  }
  return undefined;
}

function rawBodyBytes(event: any): Buffer {
  const body = event?.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (event?.isBase64Encoded) return Buffer.from(body, 'base64');
  return Buffer.from(String(body), 'utf8');
}

function httpMethod(event: any): string | undefined {
  return event?.httpMethod ?? event?.requestContext?.http?.method;
}

async function loadSecretValue(secretName: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!resp.SecretString) throw new Error('empty SecretString');
  return resp.SecretString;
}

async function loadVerifyToken(): Promise<string | null> {
  if (verifyTokenCache !== undefined) return verifyTokenCache;
  const name = process.env.VERIFY_TOKEN_SECRET_NAME;
  if (!name) return null;
  try {
    verifyTokenCache = await loadSecretValue(name);
    return verifyTokenCache;
  } catch {
    return null; // R1.6: fail closed (no challenge echoed)
  }
}

async function loadAppSecret(): Promise<Buffer | null> {
  if (appSecretCache !== undefined) return appSecretCache;
  const name = process.env.APP_SECRET_SECRET_NAME;
  if (!name) return null;
  try {
    appSecretCache = Buffer.from(await loadSecretValue(name), 'utf8');
    return appSecretCache;
  } catch {
    return null; // R2.6: fail closed
  }
}

async function handleVerification(event: any): Promise<ProxyResponse> {
  const verifyToken = await loadVerifyToken();
  if (verifyToken === null) {
    console.error('verify_token unavailable; rejecting verification GET');
    return proxyResponse(403, '');
  }
  const [status, body] = verifySubscription(event?.queryStringParameters, verifyToken);
  return proxyResponse(status, body);
}

async function enqueueEvent(body: any): Promise<void> {
  const queueUrl = process.env.INBOUND_QUEUE_URL;
  if (!queueUrl) {
    console.error('INBOUND_QUEUE_URL not set; cannot enqueue');
    return;
  }
  // The ingest's only "parsing": split the delivery into per-event envelopes
  // (messages + calls) and enqueue each. All normalization, Customer_Id
  // derivation, runtime invocation, the calls signaling proxy, and replies
  // happen in the worker - the front door does no business logic.
  const events = iterRawEvents(body);
  if (events.length === 0) return;
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  for (const event of events) {
    try {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) }));
    } catch (err) {
      console.error(`failed to enqueue an event: ${String(err)}`);
    }
  }
}

async function handleEvent(event: any): Promise<ProxyResponse> {
  // Signature-first gate (R2, R16.3): reject before any side effect.
  const appSecret = await loadAppSecret();
  if (appSecret === null) {
    console.error('app_secret unavailable; rejecting webhook POST (R2.6)');
    return proxyResponse(403, '');
  }
  const rawBody = rawBodyBytes(event);
  const signature = headerLookup(event?.headers, SIGNATURE_HEADER);
  if (!verifySignature(rawBody, signature, appSecret)) {
    console.warn('webhook signature verification failed; rejecting POST (R2.2/R2.3/R2.4)');
    return proxyResponse(403, '');
  }
  // Verified. Enqueue and acknowledge immediately (R2.5).
  try {
    const parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
    await enqueueEvent(parsed);
  } catch (err) {
    console.error(`event enqueue failed after signature verification: ${String(err)}`);
  }
  return proxyResponse(200, '');
}

export async function handler(event: any): Promise<ProxyResponse> {
  const method = httpMethod(event ?? {});
  if (method === 'GET') return handleVerification(event ?? {});
  if (method === 'POST') return handleEvent(event ?? {});
  return proxyResponse(405, '');
}

/** Test helpers - clear the module-level secret caches. */
export function resetCachesForTests(): void {
  verifyTokenCache = undefined;
  appSecretCache = undefined;
}
