import { test } from "node:test";
import assert from "node:assert/strict";
import { COULD_NOT_UNDERSTAND, MAX_AUDIO_B64_CHARS } from "./config.js";
import {
  runVoiceNoteTurn,
  runVoiceTurnGuarded,
  type TurnDeps,
  type GuardedDeps,
  type VoiceNoteResult,
} from "./turn.js";
import type { SonicOptions, SonicResult } from "./sonic.js";
import type { ToolGateway } from "./mcpTools.js";
import type { Turn } from "./memory.js";

const fakeGateway: ToolGateway = {
  async listTools() {
    return [];
  },
  async callTool() {
    return "{}";
  },
  async close() {},
};

function baseDeps(over: Partial<TurnDeps> = {}): TurnDeps {
  return {
    decodeOgg: async () => Buffer.alloc(1280, 1),
    encodeOgg: async () => Buffer.from("OGGDATA"),
    readInsights: async () => [],
    writeEvents: async () => true,
    connectGateway: async () => fakeGateway,
    runSession: async () => ({
      segmentsDelivered: 0,
      userTranscript: "",
      assistantTranscript: "",
      outputPcm: Buffer.alloc(0),
      ok: true,
    }),
    ...over,
  };
}

test("runVoiceNoteTurn: missing customerId returns error", async () => {
  const res = await runVoiceNoteTurn({}, undefined, baseDeps());
  assert.deepEqual(res, { error: "missing_customer_id" });
});

test("runVoiceNoteTurn: missing audio returns fallback text", async () => {
  const res = await runVoiceNoteTurn({ customer_id: "wa-abc" }, undefined, baseDeps());
  assert.equal(res.fallbackText, COULD_NOT_UNDERSTAND);
});

test("runVoiceNoteTurn: decode failure returns fallback and does not write memory", async () => {
  let wrote = false;
  const deps = baseDeps({
    decodeOgg: async () => {
      throw new Error("bad ogg");
    },
    writeEvents: async () => {
      wrote = true;
      return true;
    },
  });
  const res = await runVoiceNoteTurn({ customer_id: "wa-abc", audio_b64: "QQ==" }, undefined, deps);
  assert.equal(res.fallbackText, COULD_NOT_UNDERSTAND);
  assert.equal(wrote, false, "no memory write on decode failure");
});

test("runVoiceNoteTurn: successful turn encodes + delivers each segment and writes memory", async () => {
  const delivered: string[] = [];
  let closed = false;
  const gw: ToolGateway = { ...fakeGateway, async close() { closed = true; } };
  let wroteTurns: Turn[] | undefined;
  const deps = baseDeps({
    connectGateway: async () => gw,
    encodeOgg: async () => Buffer.from("OGG"),
    writeEvents: async (_c, turns) => {
      wroteTurns = turns;
      return true;
    },
    runSession: async (opts: SonicOptions) => {
      // Simulate two spoken segments delivered through the sink.
      await opts.onSegment?.(Buffer.alloc(20000));
      await opts.onSegment?.(Buffer.alloc(20000));
      return {
        segmentsDelivered: 2,
        userTranscript: "I want a latte",
        assistantTranscript: "One latte coming up",
        outputPcm: Buffer.alloc(0),
        ok: true,
      };
    },
  });
  const res = await runVoiceNoteTurn(
    { customer_id: "wa-abc", audio_b64: "QQ==" },
    async (b64) => {
      delivered.push(b64);
    },
    deps,
  );
  assert.equal(res.delivered, 2);
  assert.equal(res.userTranscript, "I want a latte");
  assert.equal(res.assistantTranscript, "One latte coming up");
  assert.equal(delivered.length, 2, "each segment delivered");
  assert.equal(closed, true, "gateway closed");
  assert.equal(wroteTurns?.[0].role, "USER");
  assert.equal(wroteTurns?.[0].text, "I want a latte");
});

test("runVoiceNoteTurn: zero segments returns fallback but still writes memory placeholder", async () => {
  let wroteTurns: Turn[] | undefined;
  const deps = baseDeps({
    writeEvents: async (_c, turns) => {
      wroteTurns = turns;
      return true;
    },
    runSession: async () => ({
      segmentsDelivered: 0,
      userTranscript: "",
      assistantTranscript: "",
      outputPcm: Buffer.alloc(0),
      ok: true,
    }),
  });
  const res = await runVoiceNoteTurn({ customer_id: "wa-abc", audio_b64: "QQ==" }, async () => {}, deps);
  assert.equal(res.fallbackText, COULD_NOT_UNDERSTAND);
  assert.equal(wroteTurns?.[0].text, "[voice note]");
  assert.equal(wroteTurns?.[1].text, "");
});

test("runVoiceNoteTurn: gateway connect failure degrades to fallback (never throws)", async () => {
  let closed = false;
  const deps = baseDeps({
    connectGateway: async () => {
      throw new Error("gateway down");
    },
    writeEvents: async () => {
      return true;
    },
    runSession: async () => {
      throw new Error("should not run");
    },
  });
  const res = await runVoiceNoteTurn({ customer_id: "wa-abc", audio_b64: "QQ==" }, async () => {}, deps);
  assert.equal(res.fallbackText, COULD_NOT_UNDERSTAND);
  assert.equal(closed, false);
});

// --- guarded runner -----------------------------------------------------

function guardedDeps(over: Partial<GuardedDeps> = {}): { deps: GuardedDeps; log: string[] } {
  const logArr: string[] = [];
  const deps: GuardedDeps = {
    sendAudio: async (_c, b64) => {
      logArr.push(`audio:${b64.length}`);
      return true;
    },
    sendText: async (_c, t) => {
      logArr.push(`text:${t.slice(0, 10)}`);
      return true;
    },
    runTurn: async () => ({ delivered: 1 }) as VoiceNoteResult,
    turnStarted: () => logArr.push("started"),
    turnCompleted: () => logArr.push("completed"),
    turnFailed: () => logArr.push("failed"),
    ...over,
  };
  return { deps, log: logArr };
}

test("runVoiceTurnGuarded: no customerId is a no-op", async () => {
  const { deps, log } = guardedDeps();
  await runVoiceTurnGuarded({}, deps);
  assert.deepEqual(log, []);
});

test("runVoiceTurnGuarded: delivers audio segments via the sink", async () => {
  const { deps, log } = guardedDeps({
    runTurn: async (_p, deliverAudio) => {
      await deliverAudio?.("QUJD");
      return { delivered: 1 };
    },
  });
  await runVoiceTurnGuarded({ customer_id: "wa-abc", audio_b64: "QQ==" }, deps);
  assert.ok(log.includes("started"));
  assert.ok(log.includes("audio:4"));
  assert.ok(log.includes("completed"));
});

test("runVoiceTurnGuarded: oversize segment degrades to text", async () => {
  const big = "x".repeat(MAX_AUDIO_B64_CHARS + 1);
  const { deps, log } = guardedDeps({
    runTurn: async (_p, deliverAudio) => {
      await deliverAudio?.(big);
      return { delivered: 1 };
    },
  });
  await runVoiceTurnGuarded({ customer_id: "wa-abc", audio_b64: "QQ==" }, deps);
  assert.ok(log.some((l) => l.startsWith("text:")), "oversize -> text");
  assert.ok(!log.some((l) => l.startsWith("audio:")), "no audio send");
});

test("runVoiceTurnGuarded: fallbackText result is sent as text", async () => {
  const { deps, log } = guardedDeps({
    runTurn: async () => ({ fallbackText: COULD_NOT_UNDERSTAND }),
  });
  await runVoiceTurnGuarded({ customer_id: "wa-abc", audio_b64: "QQ==" }, deps);
  assert.ok(log.some((l) => l.startsWith("text:")));
  assert.ok(log.includes("completed"));
});

test("runVoiceTurnGuarded: a thrown turn records failure and sends the fallback text", async () => {
  const { deps, log } = guardedDeps({
    runTurn: async () => {
      throw new Error("boom");
    },
  });
  await runVoiceTurnGuarded({ customer_id: "wa-abc", audio_b64: "QQ==" }, deps);
  assert.ok(log.includes("failed"));
  assert.ok(log.some((l) => l.startsWith("text:")));
  assert.ok(!log.includes("completed"));
});
