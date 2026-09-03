// Shared AgentCore Memory client for the WhatsApp VoiceNotes Runtime.
//
// Ported from memory_client.py + probe4_memory.mjs. Talks to the single shared
// Amazon Bedrock AgentCore Memory resource (data plane: bedrock-agentcore, NOT
// bedrock-agentcore-control). Keyed by customer_id (the pseudonymous
// "wa-"+sha256(E164||Pepper)[:16] value) used as the AgentCore actorId; the raw
// phone number is never used as a key and never stored.
//
// Two operations:
//   readInsights(customerId)  at session START -> consolidated insight strings
//                             to inject into the system prompt.
//   writeEvents(customerId, turns) at session END -> append raw turns to
//                             short-term memory; managed consolidation distills
//                             them into long-term insights asynchronously.
//
// Failure posture: a read failure NEVER hard-fails the interaction (returns []).
// Long-term retrieval is EVENTUALLY CONSISTENT - read prior sessions' insights
// at session start, not same-turn data.
import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  CreateEventCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { REGION, memoryId } from "./config.js";
import { log } from "./log.js";

export type Role = "USER" | "ASSISTANT" | "TOOL" | "OTHER";

export interface Turn {
  role: Role;
  text: string;
}

/** Broad default query - surfaces name, dietary notes, and ordering preferences. */
export const DEFAULT_INSIGHT_QUERY =
  "customer name, dietary restrictions and allergies, usual order, " +
  "delivery or pickup preferences, recent order context";

/** Long-term insights namespace for a customer_id (templated on the resource). */
export function insightsNamespace(customerId: string): string {
  return `/insights/${customerId}/`;
}

/** AgentCore caps a single conversational content block at 9000 characters. */
const MAX_TEXT_CHARS = 9000;

/** Minimal client shape we depend on (lets tests inject a fake). */
export interface MemoryClientLike {
  send(command: RetrieveMemoryRecordsCommand | CreateEventCommand): Promise<Record<string, unknown>>;
}

let defaultClient: MemoryClientLike | null = null;
function client(injected?: MemoryClientLike): MemoryClientLike {
  if (injected) return injected;
  if (!defaultClient) defaultClient = new BedrockAgentCoreClient({ region: REGION }) as unknown as MemoryClientLike;
  return defaultClient;
}

/**
 * Retrieve consolidated long-term insights for a customer at session start.
 * Never throws: on any failure returns [] so the runtime proceeds with no prior
 * context.
 */
export async function readInsights(
  customerId: string,
  query: string = DEFAULT_INSIGHT_QUERY,
  topK = 10,
  injected?: MemoryClientLike,
): Promise<string[]> {
  const id = memoryId();
  if (!id) {
    log.warn("shared-memory not configured; proceeding with no insights");
    return [];
  }
  if (!customerId) return [];
  try {
    const resp = await client(injected).send(
      new RetrieveMemoryRecordsCommand({
        memoryId: id,
        namespace: insightsNamespace(customerId),
        searchCriteria: { searchQuery: query, topK },
      }),
    );
    const records = (resp.memoryRecordSummaries as Array<Record<string, unknown>>) || [];
    const insights: string[] = [];
    for (const rec of records) {
      const content = (rec.content as Record<string, unknown>) || {};
      const text = content.text as string | undefined;
      if (text) insights.push(text);
    }
    return insights;
  } catch (exc) {
    log.warn("shared-memory read failed", { customer: customerId, err: (exc as Error).message });
    return [];
  }
}

/**
 * Append conversation turns to short-term memory at session end. The
 * consolidation pipeline later distills them into long-term insights.
 * Returns true on success, false on failure (never breaks the reply path).
 */
export async function writeEvents(
  customerId: string,
  turns: Turn[],
  injected?: MemoryClientLike,
): Promise<boolean> {
  const id = memoryId();
  if (!id || !customerId || !turns || turns.length === 0) return false;

  const payload: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    const text = (turn.text || "").slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) continue;
    payload.push({ conversational: { role: turn.role, content: { text } } });
  }
  if (payload.length === 0) return false;

  try {
    await client(injected).send(
      new CreateEventCommand({
        memoryId: id,
        actorId: customerId,
        sessionId: customerId,
        eventTimestamp: new Date(),
        payload: payload as never,
      }),
    );
    return true;
  } catch (exc) {
    log.warn("shared-memory write failed", { customer: customerId, err: (exc as Error).message });
    return false;
  }
}
