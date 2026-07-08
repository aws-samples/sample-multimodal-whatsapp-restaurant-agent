import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pcmIsUsable,
  iterAudioFrames,
  silenceFrame,
  numSilenceFrames,
  SegmentBuilder,
  buildPrimingEvents,
  buildToolResultEvents,
  runSonicSession,
  type SonicTransport,
  type SonicEvent,
} from "./sonic.js";
import type { SonicToolConfig, ToolGateway } from "./mcpTools.js";

// --- Pure frame helpers -------------------------------------------------

test("pcmIsUsable requires at least one whole sample", () => {
  assert.equal(pcmIsUsable(Buffer.alloc(0)), false);
  assert.equal(pcmIsUsable(Buffer.alloc(1)), false);
  assert.equal(pcmIsUsable(Buffer.alloc(2)), true);
});

test("iterAudioFrames yields uniform frames, zero-padding the tail", () => {
  const pcm = Buffer.alloc(640 + 320, 1); // 1.5 frames
  const frames = [...iterAudioFrames(pcm, 640)];
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 640);
  assert.equal(frames[1].length, 640);
  // tail frame is padded with zeros after the 320 real bytes
  assert.equal(frames[1][0], 1);
  assert.equal(frames[1][320], 0);
});

test("iterAudioFrames on empty buffer yields nothing", () => {
  assert.equal([...iterAudioFrames(Buffer.alloc(0))].length, 0);
});

test("silenceFrame is all zeros of the requested size", () => {
  const f = silenceFrame(640);
  assert.equal(f.length, 640);
  assert.ok(f.every((b) => b === 0));
});

test("numSilenceFrames ceils ms/frameMs", () => {
  assert.equal(numSilenceFrames(2500, 20), 125);
  assert.equal(numSilenceFrames(0), 0);
  assert.equal(numSilenceFrames(25, 20), 2);
});

// --- SegmentBuilder -----------------------------------------------------

test("SegmentBuilder: audio-only turn is a single segment", () => {
  const b = new SegmentBuilder(1000);
  b.onAudio(Buffer.alloc(20000));
  const segs = b.finish();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 20000);
});

test("SegmentBuilder: tool round-trip splits into two segments", () => {
  const b = new SegmentBuilder(1000);
  b.onAudio(Buffer.alloc(20000)); // pre-tool narration
  b.onToolUse();
  b.onToolResult();
  b.onAudio(Buffer.alloc(20000)); // post-tool answer
  const segs = b.finish();
  assert.equal(segs.length, 2);
});

test("SegmentBuilder: short pre-tool fragment merges into the next segment", () => {
  const b = new SegmentBuilder(14400);
  b.onAudio(Buffer.alloc(500)); // below min -> not its own note
  b.onToolResult();
  b.onAudio(Buffer.alloc(20000));
  const segs = b.finish();
  assert.equal(segs.length, 1, "short fragment must merge, not split");
  assert.equal(segs[0].length, 20500);
});

test("SegmentBuilder: final segment below min is dropped", () => {
  const b = new SegmentBuilder(14400);
  b.onAudio(Buffer.alloc(500));
  assert.equal(b.finish().length, 0);
});

test("SegmentBuilder: awaitingAudio toggles with audio and tool events", () => {
  const b = new SegmentBuilder(1000);
  assert.equal(b.awaitingAudio, true);
  b.onAudio(Buffer.alloc(10));
  assert.equal(b.awaitingAudio, false);
  b.onToolUse();
  assert.equal(b.awaitingAudio, true);
});

// --- Event builders -----------------------------------------------------

test("buildPrimingEvents produces the ordered opening events", () => {
  const specs: SonicToolConfig["specs"] = [
    { toolSpec: { name: "GetMenu", description: "menu", inputSchema: { json: "{}" } } },
  ];
  const { events, promptName, audioContentName } = buildPrimingEvents("SYS", specs, { voice: "matthew", endpointing: "MEDIUM" });
  assert.ok(promptName && audioContentName);
  const kinds = events.map((e) => Object.keys(e.event)[0]);
  assert.deepEqual(kinds, ["sessionStart", "promptStart", "contentStart", "textInput", "contentEnd", "contentStart"]);
  const promptStart = events[1].event.promptStart as Record<string, unknown>;
  const toolCfg = promptStart.toolConfiguration as { tools: unknown[] };
  assert.equal(toolCfg.tools.length, 1);
  const sess = events[0].event.sessionStart as Record<string, unknown>;
  assert.deepEqual(sess.turnDetectionConfiguration, { endpointingSensitivity: "MEDIUM" });
});

test("buildToolResultEvents produces contentStart/toolResult/contentEnd", () => {
  const evs = buildToolResultEvents("p1", "tu-1", "result text");
  const kinds = evs.map((e) => Object.keys(e.event)[0]);
  assert.deepEqual(kinds, ["contentStart", "toolResult", "contentEnd"]);
  const cs = evs[0].event.contentStart as Record<string, unknown>;
  const tric = cs.toolResultInputConfiguration as Record<string, unknown>;
  assert.equal(tric.toolUseId, "tu-1");
});

test("buildToolResultEvents truncates result text to 8000 chars", () => {
  const evs = buildToolResultEvents("p1", "tu-1", "x".repeat(9000));
  const tr = evs[1].event.toolResult as Record<string, unknown>;
  assert.equal((tr.content as string).length, 8000);
});

// --- Driver with a scripted fake transport ------------------------------

function b64(n: number): string {
  return Buffer.alloc(n).toString("base64");
}

function fakeTransport(scripted: SonicEvent[], onSend?: (e: { event: Record<string, unknown> }) => void): SonicTransport {
  let i = 0;
  return {
    send(e) {
      onSend?.(e);
    },
    async open() {
      return {
        next(): Promise<IteratorResult<SonicEvent>> {
          if (i < scripted.length) return Promise.resolve({ value: scripted[i++], done: false });
          return new Promise<IteratorResult<SonicEvent>>(() => {}); // block -> audio-idle ends the turn
        },
      };
    },
    close() {},
  };
}

function fakeGateway(calls: Array<{ name: string; args: Record<string, unknown> }>): ToolGateway {
  return {
    async listTools() {
      return [];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return JSON.stringify({ ok: true });
    },
    async close() {},
  };
}

const driverOpts = { turnTimeoutS: 5, responseQuietWindowMs: 30, keepaliveIntervalS: 0.05, trailingSilenceMs: 40 };

test("driver: audio-only turn delivers one segment and captures transcripts", async () => {
  const scripted: SonicEvent[] = [
    { audioOutput: { content: b64(20000) } },
    { textOutput: { role: "USER", content: "I want a latte" } },
    { textOutput: { role: "ASSISTANT", content: "One latte coming up" } },
  ];
  const segments: Buffer[] = [];
  const res = await runSonicSession({
    customerId: "wa-abc",
    inputPcm16k: Buffer.alloc(1280),
    systemPrompt: "SYS",
    toolConfig: { specs: [], nameMap: new Map() },
    gateway: fakeGateway([]),
    transport: fakeTransport(scripted),
    onSegment: async (pcm) => {
      segments.push(pcm);
    },
    ...driverOpts,
  });
  assert.equal(res.ok, true);
  assert.equal(res.segmentsDelivered, 1);
  assert.equal(segments.length, 1);
  assert.equal(res.userTranscript, "I want a latte");
  assert.equal(res.assistantTranscript, "One latte coming up");
});

test("driver: tool round-trip calls the gateway with injected customerId and splits segments", async () => {
  const scripted: SonicEvent[] = [
    { audioOutput: { content: b64(20000) } }, // pre-tool narration
    { toolUse: { toolName: "qsr_backend_api___GetMenu", toolUseId: "tu-1", content: JSON.stringify({ q: "x" }) } },
    { contentEnd: { type: "TOOL", stopReason: "TOOL_USE" } },
    { audioOutput: { content: b64(20000) } }, // post-tool answer
  ];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const segments: Buffer[] = [];
  const res = await runSonicSession({
    customerId: "wa-abc",
    inputPcm16k: Buffer.alloc(1280),
    systemPrompt: "SYS",
    toolConfig: { specs: [], nameMap: new Map([["qsr_backend_api___GetMenu", "qsr-backend-api___GetMenu"]]) },
    gateway: fakeGateway(calls),
    transport: fakeTransport(scripted),
    onSegment: async (pcm) => {
      segments.push(pcm);
    },
    ...driverOpts,
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "qsr-backend-api___GetMenu", "sonic name mapped back to real MCP name");
  assert.equal(calls[0].args.customerId, "wa-abc", "server-injected customerId");
  assert.equal(res.segmentsDelivered, 2);
  assert.equal(segments.length, 2);
});

test("driver: rejects empty input audio", async () => {
  const res = await runSonicSession({
    customerId: "wa-abc",
    inputPcm16k: Buffer.alloc(0),
    systemPrompt: "SYS",
    toolConfig: { specs: [], nameMap: new Map() },
    gateway: fakeGateway([]),
    transport: fakeTransport([]),
    ...driverOpts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "empty_input_audio");
});

test("driver: missing customerId is rejected", async () => {
  const res = await runSonicSession({
    customerId: "",
    inputPcm16k: Buffer.alloc(1280),
    systemPrompt: "SYS",
    toolConfig: { specs: [], nameMap: new Map() },
    gateway: fakeGateway([]),
    transport: fakeTransport([]),
    ...driverOpts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "missing_customer_id");
});
