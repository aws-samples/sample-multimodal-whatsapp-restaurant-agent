// AgentCore Runtime invoke client for the Chat Runtime (Task 8.1).
//
// Invokes the WhatsApp Chat Runtime over the AgentCore data-plane invoke API
// with session_id == customer_id (R5.1). AgentCore's transport-level
// runtimeSessionId has a minimum length, so it is derived deterministically
// from the (19-char) customer_id rather than passed raw.

import { createHash } from 'node:crypto';

export interface ChatPayload {
  session_id: string;
  customer_id: string;
  text: string;
  images: Array<{ format: string; bytes_b64: string }>;
  documents: Array<{ format: string; name: string; bytes_b64: string }>;
}

export interface ChatResult {
  reply?: string;
  unsupported_attachments?: unknown;
}

/** Deterministic AgentCore runtimeSessionId for a customer_id (>= 33 chars):
 *  "wa-<16hex>" (19) + "-" + 16 hex = 36, alphanumeric + hyphen, stable. */
export function runtimeSessionId(customerId: string): string {
  const digest = createHash('sha256').update(customerId, 'utf8').digest('hex').slice(0, 16);
  return `${customerId}-${digest}`;
}

/** Invoke the Chat Runtime with the multimodal payload; return its parsed JSON
 *  response or null on failure. */
export async function invokeChat(payload: ChatPayload): Promise<ChatResult | null> {
  const arn = process.env.CHAT_RUNTIME_ARN;
  if (!arn) {
    console.error('CHAT_RUNTIME_ARN not set; cannot invoke Chat Runtime');
    return null;
  }
  const customerId = payload.customer_id || payload.session_id || '';
  try {
    const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = await import(
      '@aws-sdk/client-bedrock-agentcore'
    );
    const client = new BedrockAgentCoreClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
    const resp = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arn,
        runtimeSessionId: runtimeSessionId(customerId),
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    const body = resp.response;
    if (!body) return null;
    // The SDK streaming blob exposes transformToString() in the Node runtime.
    const text = await (body as { transformToString(): Promise<string> }).transformToString();
    return text ? (JSON.parse(text) as ChatResult) : null;
  } catch (err) {
    console.warn(`Chat Runtime invoke failed for ${customerId}: ${String(err)}`);
    return null;
  }
}

export interface VoiceNotePayload {
  session_id: string;
  customer_id: string;
  audio_b64: string; // base64 Ogg Opus voice note
}

export interface VoiceNoteResult {
  audio_b64?: string; // base64 Ogg Opus spoken reply (R7.5)
  fallback_text?: string; // could-not-understand text (R7.6) when no audio
  user_transcript?: string;
  assistant_transcript?: string;
  error?: string;
}

/** Invoke the VoiceNotes Runtime with the Ogg Opus voice note (Task 12.5,
 *  R7.3). The PAYLOAD session_id == customer_id (R5.1, for memory continuity),
 *  and the AgentCore TRANSPORT runtimeSessionId is the SAME deterministic
 *  per-customer id used by Chat: back-to-back notes in one exchange reuse the
 *  warm microVM (no per-note container cold start). Redeployed runtime images
 *  propagate via the runtime's short idleRuntimeSessionTimeout (lifecycle
 *  config), which recycles the microVM between exchanges - not by forcing a
 *  fresh transport id per note. Returns the parsed JSON response or null on an
 *  invoke-level failure. */
export async function invokeVoiceNote(payload: VoiceNotePayload): Promise<VoiceNoteResult | null> {
  const arn = process.env.VOICENOTES_RUNTIME_ARN;
  if (!arn) {
    console.error('VOICENOTES_RUNTIME_ARN not set; cannot invoke VoiceNotes Runtime');
    return null;
  }
  const customerId = payload.customer_id || payload.session_id || '';
  try {
    const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = await import(
      '@aws-sdk/client-bedrock-agentcore'
    );
    const client = new BedrockAgentCoreClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
    const resp = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arn,
        runtimeSessionId: runtimeSessionId(customerId),
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    const body = resp.response;
    if (!body) return null;
    const text = await (body as { transformToString(): Promise<string> }).transformToString();
    return text ? (JSON.parse(text) as VoiceNoteResult) : null;
  } catch (err) {
    console.warn(`VoiceNotes Runtime invoke failed for ${customerId}: ${String(err)}`);
    return null;
  }
}
