// Central configuration and tuning constants for the VoiceNotes Runtime.
//
// Env vars are threaded in by the CDK stack (unchanged from the Python runtime):
//   AGENTCORE_GATEWAY_URL, SHARED_MEMORY_ARN (and/or WA_MEMORY_ID),
//   SENDER_LAMBDA_ARN, AWS_REGION, LOG_LEVEL.
// The tuning constants are ported verbatim from bounded_sonic.py to preserve the
// empirically-tuned turn behavior (bounded endpointing, no runaway).

export const REGION = process.env.AWS_REGION || "us-east-1";
export const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || "amazon.nova-2-sonic-v1:0";
export const VOICE_ID = process.env.NOVA_SONIC_VOICE || "matthew";
export const GATEWAY_SERVICE = "bedrock-agentcore";

/** AgentCore Gateway MCP endpoint (required for tool use). */
export function gatewayUrl(): string {
  const url = (process.env.AGENTCORE_GATEWAY_URL || "").trim();
  if (!url) throw new Error("AGENTCORE_GATEWAY_URL is not set");
  return url;
}

/** Sender Lambda ARN (required for out-of-band delivery). */
export function senderLambdaArn(): string {
  return (process.env.SENDER_LAMBDA_ARN || "").trim();
}

/**
 * Resolve the bare AgentCore Memory id. Prefers WA_MEMORY_ID; falls back to
 * parsing it from SHARED_MEMORY_ARN (arn:...:memory/<id>). Returns "" when
 * neither is set (the memory client then degrades to a no-op).
 */
export function memoryId(): string {
  const bare = (process.env.WA_MEMORY_ID || "").trim();
  if (bare) return bare;
  const arn = (process.env.SHARED_MEMORY_ARN || "").trim();
  if (arn && arn.includes("/")) return arn.slice(arn.lastIndexOf("/") + 1);
  return "";
}

// --- Audio shape (Nova Sonic: 16 kHz in, 24 kHz out; 16-bit mono LPCM) ---
export const VN_INPUT_SAMPLE_RATE = 16000;
export const VN_OUTPUT_SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const SAMPLE_WIDTH = 2;
export const INPUT_FRAME_MS = 20;
/** 20 ms input frame: 2 * 16000 * 20/1000 = 640 bytes. */
export const INPUT_FRAME_BYTES = (SAMPLE_WIDTH * VN_INPUT_SAMPLE_RATE * INPUT_FRAME_MS) / 1000;

// --- Turn behavior (ported from bounded_sonic.py) ---
/** Bounded trailing-silence burst to endpoint the user turn; stops on first audio. */
export const DEFAULT_TRAILING_SILENCE_MS = 2500;
/** Sparse keepalive across a tool round-trip (avoids the ~55 s idle-close without re-tripping VAD). */
export const KEEPALIVE_INTERVAL_S = 15.0;
/** Hard upper bound on a turn; only fires when the model produces no audio at all. */
export const DEFAULT_TURN_TIMEOUT_S = 45.0;
/** End-of-response: audio started, then no new chunk for this long (and no tool pending). */
export const RESPONSE_QUIET_WINDOW_MS = 1200;
/** A completed speech segment shorter than this (~0.3 s @ 24 kHz) is merged, not sent as its own note. */
export const MIN_SEGMENT_BYTES = Math.floor(VN_OUTPUT_SAMPLE_RATE * SAMPLE_WIDTH * 0.3);

// --- Delivery ---
/** Sender Lambda synchronous-invoke payload limit (6 MB); base64 audio above this degrades to text. */
export const MAX_AUDIO_B64_CHARS = 6_000_000;

// --- Endpointing ---
export const ENDPOINTING_SENSITIVITY = process.env.ENDPOINTING || "MEDIUM";

export const COULD_NOT_UNDERSTAND =
  "Sorry, I could not understand that voice note. Please try again, or send " +
  "your order as a text message.";

export function logLevel(): string {
  return (process.env.LOG_LEVEL || "INFO").toUpperCase();
}
