// WhatsApp VoiceNotes Runtime - turn orchestrator.
//
// Ported from handler.py. Wires the OGG codec, shared memory, gateway MCP tools,
// and the bounded raw Nova Sonic session into one voice-note turn: OGG Opus in,
// one or more OGG Opus voice notes out (voice-in / voice-out).
//
//   runVoiceNoteTurn(payload, deliverAudio):
//     decode the inbound OGG -> 16 kHz PCM; read the customer's memory insights;
//     open the gateway + Sonic session; each spoken SEGMENT is encoded to OGG
//     and handed to deliverAudio (its own voice note); write the two turns back
//     to memory. Returns {delivered:n} or {fallbackText} (could-not-understand)
//     when no usable audio was produced. Never throws.
//
//   runVoiceTurnGuarded(payload):
//     the reliability wrapper used by the entrypoint - delivers each segment
//     out-of-band via the Sender Lambda, degrades an oversize segment to text,
//     records the async turn signals, and guarantees an acknowledged message is
//     never left without a reply or a recorded failure.
import { COULD_NOT_UNDERSTAND, MAX_AUDIO_B64_CHARS } from "./config.js";
import { log } from "./log.js";
import { decodeOggToPcm16k, encodePcm24kToOgg } from "./ogg.js";
import { readInsights, writeEvents, type Turn } from "./memory.js";
import { connectGateway, toSonicToolSpecs, type ToolGateway } from "./mcpTools.js";
import { renderSystemPrompt } from "./systemPrompt.js";
import { runSonicSession, type SonicOptions, type SonicResult } from "./sonic.js";
import { sendAudio, sendText } from "./sender.js";
import { turnStarted, turnCompleted, turnFailed } from "./dispatch.js";

export interface VoiceNotePayload {
  customer_id?: string;
  session_id?: string;
  message_id?: string;
  audio_b64?: string;
}

export interface VoiceNoteResult {
  delivered?: number;
  fallbackText?: string;
  error?: string;
  userTranscript?: string;
  assistantTranscript?: string;
}

/** Injectable dependencies (defaults are the real modules); lets tests avoid AWS/ffmpeg. */
export interface TurnDeps {
  decodeOgg: (ogg: Buffer) => Promise<Buffer>;
  encodeOgg: (pcm: Buffer) => Promise<Buffer>;
  readInsights: (customerId: string) => Promise<string[]>;
  writeEvents: (customerId: string, turns: Turn[]) => Promise<boolean>;
  connectGateway: () => Promise<ToolGateway>;
  runSession: (opts: SonicOptions) => Promise<SonicResult>;
}

const defaultDeps: TurnDeps = {
  decodeOgg: (ogg) => decodeOggToPcm16k(ogg),
  encodeOgg: (pcm) => encodePcm24kToOgg(pcm),
  readInsights: (customerId) => readInsights(customerId),
  writeEvents: (customerId, turns) => writeEvents(customerId, turns),
  connectGateway: () => connectGateway(),
  runSession: (opts) => runSonicSession(opts),
};

function resolveCustomerId(payload: VoiceNotePayload): string {
  return (payload.customer_id || payload.session_id || "").trim();
}

/**
 * Run one bounded voice-note turn. Each spoken segment's 24 kHz PCM is encoded
 * to OGG Opus and handed to `deliverAudio` (which sends it as its own voice
 * note). Returns {delivered:n} on success, or {fallbackText} when no usable
 * audio was produced. Never raises: failures degrade to the text fallback.
 */
export async function runVoiceNoteTurn(
  payload: VoiceNotePayload,
  deliverAudio?: (audioB64: string) => Promise<void>,
  deps: TurnDeps = defaultDeps,
): Promise<VoiceNoteResult> {
  const customerId = resolveCustomerId(payload);
  if (!customerId) return { error: "missing_customer_id" };

  const audioB64 = payload.audio_b64 || "";
  if (!audioB64) return { fallbackText: COULD_NOT_UNDERSTAND };

  // Decode the inbound OGG Opus voice note to 16 kHz PCM.
  let inputPcm: Buffer;
  try {
    inputPcm = await deps.decodeOgg(Buffer.from(audioB64, "base64"));
  } catch (exc) {
    log.info("voice-note decode failed", { customer: customerId, err: (exc as Error).message });
    return { fallbackText: COULD_NOT_UNDERSTAND };
  }

  // Per-segment sink: encode one 24 kHz PCM segment to OGG Opus and deliver it.
  // A single segment that fails to encode is skipped, not fatal.
  const onSegment = deliverAudio
    ? async (pcm: Buffer): Promise<void> => {
        let ogg: Buffer;
        try {
          ogg = await deps.encodeOgg(pcm);
        } catch (exc) {
          log.warn("voice segment encode failed", { customer: customerId, err: (exc as Error).message });
          return;
        }
        await deliverAudio(ogg.toString("base64"));
      }
    : undefined;

  // Session start: read shared long-term memory (graceful; never throws).
  const insights = await deps.readInsights(customerId);
  const systemPrompt = renderSystemPrompt(insights);

  let result: SonicResult = {
    segmentsDelivered: 0,
    userTranscript: "",
    assistantTranscript: "",
    outputPcm: Buffer.alloc(0),
    ok: false,
  };
  let gateway: ToolGateway | undefined;
  try {
    gateway = await deps.connectGateway();
    const tools = await gateway.listTools();
    const toolConfig = toSonicToolSpecs(tools);
    result = await deps.runSession({
      customerId,
      inputPcm16k: inputPcm,
      systemPrompt,
      toolConfig,
      gateway,
      onSegment,
    });
  } catch (exc) {
    log.error("voice-note session failed", { customer: customerId, err: (exc as Error).message });
  } finally {
    if (gateway) await gateway.close();
  }

  // Session end: write the two turns to shared memory (best-effort).
  const turns: Turn[] = [
    { role: "USER", text: result.userTranscript || "[voice note]" },
    { role: "ASSISTANT", text: result.assistantTranscript || "" },
  ];
  await deps.writeEvents(customerId, turns);

  if (result.segmentsDelivered === 0) {
    log.info("voice-note produced no usable audio", { customer: customerId, ok: result.ok, err: result.error });
    return { fallbackText: COULD_NOT_UNDERSTAND };
  }

  const out: VoiceNoteResult = { delivered: result.segmentsDelivered };
  if (result.userTranscript) out.userTranscript = result.userTranscript;
  if (result.assistantTranscript) out.assistantTranscript = result.assistantTranscript;
  return out;
}

/** Dependencies for the guarded runner (sender + signals), injectable for tests. */
export interface GuardedDeps {
  sendAudio: (customerId: string, audioB64: string, channel?: string) => Promise<boolean>;
  sendText: (customerId: string, text: string, channel?: string) => Promise<boolean>;
  runTurn: (
    payload: VoiceNotePayload,
    deliverAudio?: (audioB64: string) => Promise<void>,
  ) => Promise<VoiceNoteResult>;
  turnStarted: (channel: string, customerId: string) => void;
  turnCompleted: (channel: string, customerId: string) => void;
  turnFailed: (channel: string, customerId: string) => void;
}

const defaultGuardedDeps: GuardedDeps = {
  sendAudio: (c, b, ch) => sendAudio(c, b, ch),
  sendText: (c, t, ch) => sendText(c, t, ch),
  runTurn: (p, d) => runVoiceNoteTurn(p, d),
  turnStarted,
  turnCompleted,
  turnFailed,
};

/**
 * Run one voice-note turn and DELIVER each segment out-of-band as its own voice
 * note, owning reliability: on no usable audio, send the could-not-understand
 * text; on an unexpected failure, send it and record async_turn_failed - so no
 * acknowledged message is left without a reply or a recorded failure.
 */
export async function runVoiceTurnGuarded(
  payload: VoiceNotePayload,
  deps: GuardedDeps = defaultGuardedDeps,
): Promise<void> {
  const customerId = resolveCustomerId(payload);
  if (!customerId) return;
  deps.turnStarted("voicenote", customerId);

  const deliverAudio = async (audioB64: string): Promise<void> => {
    if (audioB64.length > MAX_AUDIO_B64_CHARS) {
      log.warn("voice segment too large; sending text", {
        customer: customerId,
        chars: audioB64.length,
        max: MAX_AUDIO_B64_CHARS,
      });
      await deps.sendText(customerId, COULD_NOT_UNDERSTAND, "voicenote");
      return;
    }
    await deps.sendAudio(customerId, audioB64, "voicenote");
  };

  try {
    const result = await deps.runTurn(payload, deliverAudio);
    if (result.fallbackText) {
      await deps.sendText(customerId, result.fallbackText, "voicenote");
    }
    deps.turnCompleted("voicenote", customerId);
  } catch (exc) {
    deps.turnFailed("voicenote", customerId);
    log.error("voice-note turn failed", { customer: customerId, err: (exc as Error).message });
    try {
      await deps.sendText(customerId, COULD_NOT_UNDERSTAND, "voicenote");
    } catch (exc2) {
      log.error("failed to send the voice error fallback", { customer: customerId, err: (exc2 as Error).message });
    }
  }
}
