// Outbound WhatsApp delivery via the Sender Lambda (async-reply-delivery).
//
// Ported from sender_client.py. The VoiceNotes Runtime does not return the audio
// reply to the worker; it delivers out-of-band by invoking the Sender Lambda
// (RequestResponse), mirroring how the Chat Runtime delivers text. The runtime
// never holds the Meta Access_Token or the recipient phone (PII) - it passes
// only {customer_id, ...} and the Lambda resolves the recipient wa_id from the
// 24-hour window table and sends via the shared delivery path.
//
// The audio bytes travel IN the invoke payload (base64), never staged at rest.
// The synchronous Lambda invoke payload limit (6 MB) bounds the reply size; the
// turn orchestrator checks the size before invoking and falls back to text if a
// reply would exceed it.
//
// Every function is best-effort: a delivery failure is logged and returns false
// so a delivery problem degrades gracefully rather than crashing the turn.
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { REGION, senderLambdaArn } from "./config.js";
import { log } from "./log.js";

/** Minimal shape of the Lambda client we depend on (lets tests inject a fake). */
export interface LambdaLike {
  send(command: InvokeCommand): Promise<{ Payload?: Uint8Array }>;
}

let defaultClient: LambdaLike | null = null;
function client(injected?: LambdaLike): LambdaLike {
  if (injected) return injected;
  if (!defaultClient) defaultClient = new LambdaClient({ region: REGION }) as unknown as LambdaLike;
  return defaultClient;
}

type Payload = Record<string, unknown> & { kind: string };

/**
 * Invoke the Sender Lambda with a delivery payload; return the Lambda's `ok`.
 * Never throws - any failure (missing ARN, invoke error, not-ok response) is
 * logged and returns false.
 */
async function invoke(payload: Payload, injected?: LambdaLike): Promise<boolean> {
  const arn = senderLambdaArn();
  if (!arn) {
    log.error("SENDER_LAMBDA_ARN not set; cannot deliver via the Sender Lambda", { kind: payload.kind });
    return false;
  }
  try {
    const resp = await client(injected).send(
      new InvokeCommand({
        FunctionName: arn,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(payload), "utf-8"),
      }),
    );
    const raw = resp.Payload ? Buffer.from(resp.Payload).toString("utf-8") : "";
    const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const ok = Boolean(data.ok);
    if (!ok) log.warn("sender lambda reported not-ok", { kind: payload.kind, reason: data.reason });
    return ok;
  } catch (exc) {
    log.error("sender lambda invoke failed", { kind: payload.kind, err: (exc as Error).message });
    return false;
  }
}

/**
 * Deliver a voice-note (audio) reply. The OGG Opus bytes travel base64 in the
 * invoke payload; the Sender Lambda does the two-step Media upload + send.
 */
export async function sendAudio(
  customerId: string,
  audioB64: string,
  channel = "voicenote",
  injected?: LambdaLike,
): Promise<boolean> {
  if (!customerId || !audioB64) {
    log.warn("refusing to send empty audio", { customer: customerId || "<none>" });
    return false;
  }
  return invoke({ kind: "audio", customer_id: customerId, audio_b64: audioB64, channel }, injected);
}

/** Deliver a text reply (the could-not-understand / error fallback). */
export async function sendText(
  customerId: string,
  text: string,
  channel = "voicenote",
  injected?: LambdaLike,
): Promise<boolean> {
  if (!customerId || !text || !text.trim()) {
    log.warn("refusing to send empty text", { customer: customerId || "<none>" });
    return false;
  }
  return invoke({ kind: "text", customer_id: customerId, text, channel }, injected);
}

/** Relay the WhatsApp typing indicator for an inbound message (best-effort). */
export async function sendTyping(messageId: string, injected?: LambdaLike): Promise<boolean> {
  if (!messageId) return false;
  return invoke({ kind: "typing", message_id: messageId }, injected);
}
