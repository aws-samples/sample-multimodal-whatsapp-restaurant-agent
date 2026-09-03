// Bounded raw Nova 2 Sonic speech-to-speech engine for one WhatsApp voice note.
//
// Ported from bounded_sonic.py (behavior) onto the RAW bidirectional protocol
// proven in the spike (probe3/probe6), replacing the strands BidiAgent. A voice
// note is a single self-contained utterance, so the session is SHORT and
// BOUNDED per note:
//   1. open a Nova 2 Sonic bidi session (16 kHz PCM in, 24 kHz PCM out) with the
//      gateway-only MCP toolSpecs and the memory-seeded system prompt,
//   2. feed the note's PCM real-time, then a BOUNDED trailing-silence burst so
//      server-side VAD endpoints the user's turn (stops the instant the model
//      starts speaking, so we never re-trip the endpointer into a runaway),
//   3. keep the stream alive across a tool round-trip with a SPARSE keepalive
//      (one silence frame every 15 s - too infrequent to re-trip VAD),
//   4. collect the spoken response as one or more SEGMENTS split at tool
//      round-trips, delivering each via onSegment,
//   5. end on audio-idle (no new chunk for RESPONSE_QUIET_WINDOW_MS) or the hard
//      timeout, then tear down.
//
// The pure cores (frame helpers, SegmentBuilder, priming/tool-result builders)
// are unit-tested; the live transport is injectable so the driver's segmentation
// and tool round-trip wiring is tested with a scripted event sequence.
import { randomUUID } from "node:crypto";
import {
  VN_INPUT_SAMPLE_RATE,
  VN_OUTPUT_SAMPLE_RATE,
  CHANNELS,
  SAMPLE_WIDTH,
  INPUT_FRAME_MS,
  INPUT_FRAME_BYTES,
  DEFAULT_TRAILING_SILENCE_MS,
  KEEPALIVE_INTERVAL_S,
  DEFAULT_TURN_TIMEOUT_S,
  RESPONSE_QUIET_WINDOW_MS,
  MIN_SEGMENT_BYTES,
  MODEL_ID,
  VOICE_ID,
  ENDPOINTING_SENSITIVITY,
  REGION,
} from "./config.js";
import { log } from "./log.js";
import { injectCustomerId, type SonicToolConfig, type ToolGateway } from "./mcpTools.js";

// --- Pure frame helpers (unit tested) -----------------------------------

/** True iff the PCM buffer holds at least one whole 16-bit sample. */
export function pcmIsUsable(pcm: Buffer): boolean {
  return Boolean(pcm) && pcm.length >= SAMPLE_WIDTH;
}

/** Yield fixed-size PCM frames, zero-padding the trailing partial frame. */
export function* iterAudioFrames(pcm: Buffer, frameBytes = INPUT_FRAME_BYTES): Generator<Buffer> {
  if (frameBytes <= 0) throw new Error("frameBytes must be positive");
  for (let off = 0; off < pcm.length; off += frameBytes) {
    let frame = pcm.subarray(off, off + frameBytes);
    if (frame.length < frameBytes) {
      frame = Buffer.concat([frame, Buffer.alloc(frameBytes - frame.length)]);
    }
    yield frame;
  }
}

/** A single all-zero (silence) PCM frame of `frameBytes` bytes. */
export function silenceFrame(frameBytes = INPUT_FRAME_BYTES): Buffer {
  return Buffer.alloc(frameBytes);
}

/** Number of `frameMs` frames needed to cover `ms` of silence (ceil). */
export function numSilenceFrames(ms: number, frameMs = INPUT_FRAME_MS): number {
  if (frameMs <= 0) throw new Error("frameMs must be positive");
  if (ms <= 0) return 0;
  return Math.ceil(ms / frameMs);
}

// --- Segmentation state machine (unit tested with scripted events) ------

/**
 * Accumulates Nova Sonic audio chunks into speech SEGMENTS, split at tool
 * round-trips. The model narrates ("let me check your cart"), calls a tool,
 * then speaks the answer -> two segments, two notes. A pre-tool fragment shorter
 * than minSegmentBytes is merged into the next segment rather than sent as its
 * own tiny note. Ported from the current_segment/awaiting_audio/
 * result_pending_flush logic in bounded_sonic.py.
 */
export class SegmentBuilder {
  private segments: Buffer[] = [];
  private current: Buffer[] = [];
  private currentLen = 0;
  private resultPendingFlush = false;
  /** True while we are still expecting (more) audio - start of turn and after each tool result. */
  awaitingAudio = true;

  constructor(private readonly minSegmentBytes = MIN_SEGMENT_BYTES) {}

  /** A tool USE means a post-tool answer is still coming; keep suppressing end-of-response. */
  onToolUse(): void {
    this.awaitingAudio = true;
  }

  /** A tool RESULT means the model is about to speak again; the next audio chunk closes the pre-tool segment. */
  onToolResult(): void {
    this.awaitingAudio = true;
    this.resultPendingFlush = true;
  }

  /** Append an audio chunk, flushing the pre-tool segment first if this is the post-tool audio. */
  onAudio(pcm: Buffer): void {
    if (this.resultPendingFlush) {
      if (this.currentLen >= this.minSegmentBytes) this.flushCurrent();
      this.resultPendingFlush = false;
    }
    this.current.push(pcm);
    this.currentLen += pcm.length;
    this.awaitingAudio = false;
  }

  private flushCurrent(): void {
    if (this.currentLen > 0) this.segments.push(Buffer.concat(this.current));
    this.current = [];
    this.currentLen = 0;
  }

  /** Bytes accumulated in the segment currently being built. */
  get currentBytes(): number {
    return this.currentLen;
  }

  /** Close the final segment (if large enough) and return all collected segments. */
  finish(): Buffer[] {
    if (this.currentLen >= this.minSegmentBytes) this.flushCurrent();
    this.current = [];
    this.currentLen = 0;
    return this.segments;
  }
}

// --- Pure event builders (unit tested) ----------------------------------

/** Wrap an inner event object in the Sonic `{event:{...}}` envelope. */
export const ev = (o: Record<string, unknown>): { event: Record<string, unknown> } => ({ event: o });

export interface PrimingResult {
  events: Array<{ event: Record<string, unknown> }>;
  promptName: string;
  audioContentName: string;
}

/**
 * Build the ordered priming events that open a bidi session: sessionStart,
 * promptStart (with tool config + audio/text output config), the system TEXT
 * content block, and the USER AUDIO contentStart. Pure and deterministic given
 * the generated names.
 */
export function buildPrimingEvents(
  systemPrompt: string,
  toolSpecs: SonicToolConfig["specs"],
  opts: { voice?: string; endpointing?: string } = {},
): PrimingResult {
  const promptName = randomUUID();
  const sysName = randomUUID();
  const audioContentName = randomUUID();
  const voice = opts.voice || VOICE_ID;
  const endpointing = opts.endpointing || ENDPOINTING_SENSITIVITY;

  const events = [
    ev({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 2048, topP: 0.9, temperature: 0.7 },
        turnDetectionConfiguration: { endpointingSensitivity: endpointing },
      },
    }),
    ev({
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: VN_OUTPUT_SAMPLE_RATE,
          sampleSizeBits: 16,
          channelCount: CHANNELS,
          voiceId: voice,
          encoding: "base64",
          audioType: "SPEECH",
        },
        toolUseOutputConfiguration: { mediaType: "application/json" },
        toolConfiguration: { tools: toolSpecs },
      },
    }),
    ev({
      contentStart: {
        promptName,
        contentName: sysName,
        type: "TEXT",
        interactive: false,
        role: "SYSTEM",
        textInputConfiguration: { mediaType: "text/plain" },
      },
    }),
    ev({ textInput: { promptName, contentName: sysName, content: systemPrompt } }),
    ev({ contentEnd: { promptName, contentName: sysName } }),
    ev({
      contentStart: {
        promptName,
        contentName: audioContentName,
        type: "AUDIO",
        interactive: true,
        role: "USER",
        audioInputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: VN_INPUT_SAMPLE_RATE,
          sampleSizeBits: 16,
          channelCount: CHANNELS,
          audioType: "SPEECH",
          encoding: "base64",
        },
      },
    }),
  ];
  return { events, promptName, audioContentName };
}

/** Build an audioInput event carrying one base64 PCM frame. */
export function audioInputEvent(promptName: string, contentName: string, frameB64: string): { event: Record<string, unknown> } {
  return ev({ audioInput: { promptName, contentName, content: frameB64 } });
}

/** Build the 3 events of a tool RESULT round-trip (contentStart TOOL / toolResult / contentEnd). */
export function buildToolResultEvents(
  promptName: string,
  toolUseId: string,
  resultText: string,
): Array<{ event: Record<string, unknown> }> {
  const tn = randomUUID();
  return [
    ev({
      contentStart: {
        promptName,
        contentName: tn,
        interactive: false,
        type: "TOOL",
        role: "TOOL",
        toolResultInputConfiguration: {
          toolUseId,
          type: "TEXT",
          textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    }),
    ev({ toolResult: { promptName, contentName: tn, content: resultText.slice(0, 8000) } }),
    ev({ contentEnd: { promptName, contentName: tn } }),
  ];
}

// --- Transport (injectable; live impl uses Bedrock bidi) ----------------

export type SonicEvent = Record<string, unknown>;

/**
 * Bidirectional Sonic transport. Input events are pushed via send() onto the
 * model's input stream; open() sends the streaming command and returns the
 * model's output-event async iterator. The live implementation wraps the
 * Bedrock bidi stream; tests inject a scripted fake.
 */
export interface SonicTransport {
  send(evObj: { event: Record<string, unknown> }): void;
  open(): Promise<AsyncIterator<SonicEvent>>;
  close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Async-iterable input queue that the Bedrock bidi command consumes as its body. */
class InputQueue {
  private items: Array<{ chunk: { bytes: Uint8Array } }> = [];
  private waiters: Array<(r: IteratorResult<{ chunk: { bytes: Uint8Array } }>) => void> = [];
  private closed = false;

  push(evObj: { event: Record<string, unknown> }): void {
    const it = { chunk: { bytes: encoder.encode(JSON.stringify(evObj)) } };
    const w = this.waiters.shift();
    if (w) w({ value: it, done: false });
    else this.items.push(it);
  }

  close(): void {
    this.closed = true;
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<{ chunk: { bytes: Uint8Array } }>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
      return: (): Promise<IteratorResult<{ chunk: { bytes: Uint8Array } }>> => {
        this.closed = true;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * Live transport over the Bedrock Runtime bidirectional stream. Imported lazily
 * so unit tests (which inject a fake transport) never require the AWS SDK bidi
 * client or an HTTP/2 handler.
 */
export async function createBedrockTransport(modelId: string, region: string): Promise<SonicTransport> {
  const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = await import(
    "@aws-sdk/client-bedrock-runtime"
  );
  const { NodeHttp2Handler } = await import("@smithy/node-http-handler");

  const queue = new InputQueue();
  const client = new BedrockRuntimeClient({
    region,
    requestHandler: new NodeHttp2Handler({ requestTimeout: 600000, sessionTimeout: 600000 }),
  });

  return {
    send(evObj) {
      queue.push(evObj);
    },
    async open() {
      const response = await client.send(
        new InvokeModelWithBidirectionalStreamCommand({ modelId, body: queue as never }),
      );
      const inner = (response.body as AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>)[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<SonicEvent>> {
          for (;;) {
            const r = await inner.next();
            if (r.done) return { value: undefined as never, done: true };
            const bytes = r.value?.chunk?.bytes;
            if (!bytes) continue;
            try {
              const parsed = JSON.parse(decoder.decode(bytes)) as { event?: SonicEvent };
              if (parsed.event) return { value: parsed.event, done: false };
            } catch {
              /* skip unparseable frame */
            }
          }
        },
      };
    },
    close() {
      try {
        queue.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// --- Driver -------------------------------------------------------------

export interface SonicOptions {
  customerId: string;
  inputPcm16k: Buffer;
  systemPrompt: string;
  toolConfig: SonicToolConfig;
  gateway: ToolGateway;
  /** Injectable transport; defaults to the live Bedrock bidi transport. */
  transport?: SonicTransport;
  /** Called with each completed segment's 24 kHz PCM (in order). */
  onSegment?: (pcm: Buffer) => Promise<void>;
  modelId?: string;
  voice?: string;
  region?: string;
  trailingSilenceMs?: number;
  turnTimeoutS?: number;
  responseQuietWindowMs?: number;
  keepaliveIntervalS?: number;
}

export interface SonicResult {
  segmentsDelivered: number;
  userTranscript: string;
  assistantTranscript: string;
  /** Concatenated PCM when no onSegment sink was provided; empty otherwise. */
  outputPcm: Buffer;
  ok: boolean;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run one bounded raw Nova 2 Sonic turn for a voice note. Never throws: any
 * failure is captured on the result so the orchestrator can fall back.
 */
export async function runSonicSession(opts: SonicOptions): Promise<SonicResult> {
  const {
    customerId,
    inputPcm16k,
    systemPrompt,
    toolConfig,
    gateway,
    onSegment,
    modelId = MODEL_ID,
    voice = VOICE_ID,
    region = REGION,
    trailingSilenceMs = DEFAULT_TRAILING_SILENCE_MS,
    turnTimeoutS = DEFAULT_TURN_TIMEOUT_S,
    responseQuietWindowMs = RESPONSE_QUIET_WINDOW_MS,
    keepaliveIntervalS = KEEPALIVE_INTERVAL_S,
  } = opts;

  if (!customerId) return emptyResult(false, "missing_customer_id");
  if (!pcmIsUsable(inputPcm16k)) return emptyResult(false, "empty_input_audio");

  const seg = new SegmentBuilder();
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  let lastAudioTs = 0;
  let feeding = true;
  // Input-cadence gating (the over-generation fix). Feed silence only to TRIGGER
  // a model turn (endpointing), then STOP while the model holds the floor - it
  // streams its response to END_TURN without needing more input, and feeding
  // silence during generation pushes it to over-generate. Re-arm after a tool
  // result to trigger the post-tool answer. SONIC_SILENCE=continuous restores
  // the old always-on feed to REPRODUCE the runaway (diagnostic only).
  let silenceArmed = true;
  const continuousSilence = process.env.SONIC_SILENCE === "continuous";
  let completionReason = "none";
  // Observability: response cycles (completionStart) is the spiral check - it
  // should stay low (1-2), not the 49-105 the strands path produced; toolCalls
  // is how many gateway tools the turn invoked.
  let completionStarts = 0;
  let toolCalls = 0;

  const transport = opts.transport || (await createBedrockTransport(modelId, region));
  const { events: priming, promptName, audioContentName } = buildPrimingEvents(systemPrompt, toolConfig.specs, {
    voice,
    endpointing: ENDPOINTING_SENSITIVITY,
  });

  try {
    for (const e of priming) transport.send(e);
    const iter = await transport.open();

    // Producer: feed the note real-time, then CONTINUOUS real-time-paced silence
    // until teardown. In the RAW Sonic path this continuous silence is what
    // re-triggers the model to speak the post-tool answer (server-side VAD needs
    // ongoing input to endpoint each turn, including the turn after a tool
    // result). It does NOT cause the re-prompt spiral - that was strands-only;
    // the raw path stays bounded (proven by the spike capstone, probe6). Silence
    // frames never reset lastAudioTs, so audio-idle end-of-turn still fires.
    // (A sparse keepalive was tried instead and left tool turns silent -> 45s
    // timeout with zero audio; see the fix history.)
    const feedTask = (async () => {
      const frameIntervalMs = INPUT_FRAME_MS;
      for (const frame of iterAudioFrames(inputPcm16k)) {
        if (!feeding) return;
        await sleep(frameIntervalMs);
        transport.send(audioInputEvent(promptName, audioContentName, frame.toString("base64")));
      }
      const silenceB64 = silenceFrame().toString("base64");
      while (feeding) {
        await sleep(frameIntervalMs);
        if (!feeding) break;
        // Only feed while armed (triggering a turn); once the model is speaking
        // it is disarmed until the next tool result. continuousSilence forces
        // the old always-on behavior for reproduction.
        if (continuousSilence || silenceArmed) {
          transport.send(audioInputEvent(promptName, audioContentName, silenceB64));
        }
      }
    })().catch(() => {
      /* stream closing; feeder stops quietly */
    });

    // Consumer loop with an audio-idle heartbeat.
    const start = Date.now();
    const deadline = start + turnTimeoutS * 1000;
    interface PendingTool { toolName?: string; toolUseId?: string; content?: unknown }
    let pendingTool: PendingTool | null = null;
    let ended = false;
    // Diagnostic tracing (SONIC_TRACE=1): logs the first occurrence of each raw
    // event type plus the full payload of tool-related events, so we can see the
    // exact protocol the model emits. Off by default; enabled in the local debug
    // harness. Remove/reduce once the tool round-trip is confirmed.
    const trace = process.env.SONIC_TRACE === "1";
    const seenTypes = new Set<string>();

    // Hold the outstanding iter.next() across heartbeats. Racing a fresh
    // iter.next() against the beat and abandoning the loser would DISCARD the
    // event that the abandoned next() later resolves with - and for a tool turn
    // that single dropped toolUse event stalls the whole turn (the model waits
    // for a tool result we never send). Keep `pending` alive between beats and
    // only clear it once we actually consume its event.
    let pending: Promise<{ __beat: false; r: IteratorResult<SonicEvent> }> | null = null;
    while (!ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        completionReason = "timeout";
        break;
      }
      if (!pending) pending = iter.next().then((r) => ({ __beat: false as const, r }));
      const beat = sleep(Math.min(remaining, 200)).then(() => ({ __beat: true as const }));
      const winner = await Promise.race([beat, pending]);

      if (winner.__beat) {
        if (
          lastAudioTs !== 0 &&
          seg.currentBytes > 0 &&
          !seg.awaitingAudio &&
          Date.now() - lastAudioTs >= responseQuietWindowMs
        ) {
          completionReason = "audio_idle";
          break;
        }
        continue; // pending is preserved for the next iteration - no event lost
      }

      pending = null; // consumed this event; allow a fresh next() on the next loop
      const r = winner.r;
      if (r.done) {
        completionReason = "stream_end";
        break;
      }
      const j = r.value as Record<string, Record<string, unknown>>;

      if (trace) {
        const evKey = Object.keys(j)[0] || "?";
        if (!seenTypes.has(evKey)) {
          seenTypes.add(evKey);
          log.info("sonic event first-seen", { key: evKey });
        }
        if (evKey === "toolUse" || evKey === "contentStart" || evKey === "contentEnd" || evKey === "completionStart" || evKey === "completionEnd") {
          log.info("sonic event", { key: evKey, payload: JSON.stringify(j[evKey]).slice(0, 700) });
        }
      }

      if (j.completionStart) {
        completionStarts++;
      } else if (j.audioOutput) {
        const b = Buffer.from(j.audioOutput.content as string, "base64");
        seg.onAudio(b);
        lastAudioTs = Date.now();
        silenceArmed = false; // model holds the floor; stop feeding until the next tool result
      } else if (j.textOutput) {
        const role = String((j.textOutput.role as string) || "").toUpperCase();
        const content = j.textOutput.content as string | undefined;
        if (content) (role === "USER" ? userParts : assistantParts).push(content);
      } else if (j.toolUse) {
        pendingTool = j.toolUse as unknown as PendingTool;
        seg.onToolUse();
      } else if (
        j.contentEnd &&
        j.contentEnd.type === "TOOL" &&
        j.contentEnd.stopReason === "TOOL_USE" &&
        pendingTool
      ) {
        const sonicToolName = String(pendingTool.toolName || "");
        const realName = toolConfig.nameMap.get(sonicToolName) || sonicToolName;
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof pendingTool.content === "string"
              ? (JSON.parse(pendingTool.content) as Record<string, unknown>)
              : ((pendingTool.content as Record<string, unknown>) || {});
        } catch {
          args = {};
        }
        const injected = injectCustomerId(realName, args, customerId);
        toolCalls++;
        let resultText = "{}";
        try {
          resultText = await gateway.callTool(realName, injected);
          log.info("tool call", { customer: customerId, tool: realName, resultChars: resultText.length });
        } catch (e) {
          resultText = JSON.stringify({ error: (e as Error).message });
          log.warn("tool call failed", { customer: customerId, tool: realName, err: (e as Error).message });
        }
        for (const e of buildToolResultEvents(promptName, String(pendingTool.toolUseId || ""), resultText)) {
          transport.send(e);
        }
        seg.onToolResult();
        silenceArmed = true; // re-arm silence to trigger the post-tool answer
        pendingTool = null;
      } else if (j.completionEnd || j.sessionEnd) {
        completionReason = "completion_end";
        break;
      }
    }

    feeding = false;
    try {
      transport.send(ev({ promptEnd: { promptName } }));
      transport.send(ev({ sessionEnd: {} }));
    } catch {
      /* stream already closing */
    }
    transport.close();
    await feedTask;

    const segments = seg.finish();
    log.info("sonic session end", {
      customer: customerId,
      completion: completionReason,
      segments: segments.length,
      bytes: segments.reduce((n, s) => n + s.length, 0),
      cycles: completionStarts,
      tools: toolCalls,
    });

    let delivered = 0;
    if (onSegment) {
      for (const s of segments) {
        try {
          await onSegment(s);
          delivered++;
        } catch (e) {
          log.error("segment delivery failed", { customer: customerId, err: (e as Error).message });
        }
      }
    } else {
      delivered = segments.length;
    }

    return {
      segmentsDelivered: delivered,
      userTranscript: userParts.filter(Boolean).join(" ").trim(),
      assistantTranscript: assistantParts.filter(Boolean).join(" ").trim(),
      outputPcm: onSegment ? Buffer.alloc(0) : Buffer.concat(segments),
      ok: true,
    };
  } catch (exc) {
    feeding = false;
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    log.error("sonic session failed", { customer: customerId, err: (exc as Error).message });
    return emptyResult(false, (exc as Error).message);
  }
}

function emptyResult(ok: boolean, error?: string): SonicResult {
  return { segmentsDelivered: 0, userTranscript: "", assistantTranscript: "", outputPcm: Buffer.alloc(0), ok, error };
}

// Re-export the audio shape so the orchestrator/tests can reference it.
export const AUDIO_SHAPE = {
  inputRate: VN_INPUT_SAMPLE_RATE,
  outputRate: VN_OUTPUT_SAMPLE_RATE,
  channels: CHANNELS,
  sampleWidth: SAMPLE_WIDTH,
  frameBytes: INPUT_FRAME_BYTES,
} as const;
