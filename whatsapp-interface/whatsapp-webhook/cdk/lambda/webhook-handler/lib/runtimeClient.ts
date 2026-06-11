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
