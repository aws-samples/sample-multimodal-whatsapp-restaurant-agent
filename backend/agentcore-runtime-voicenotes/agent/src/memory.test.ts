import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readInsights, writeEvents, insightsNamespace, type MemoryClientLike, type Turn } from "./memory.js";

const MEM_ID = "whatsapp_shared_memory-EXAMPLE01";

let savedMem: string | undefined;
let savedArn: string | undefined;
beforeEach(() => {
  savedMem = process.env.WA_MEMORY_ID;
  savedArn = process.env.SHARED_MEMORY_ARN;
  process.env.WA_MEMORY_ID = MEM_ID;
  delete process.env.SHARED_MEMORY_ARN;
});
afterEach(() => {
  if (savedMem === undefined) delete process.env.WA_MEMORY_ID;
  else process.env.WA_MEMORY_ID = savedMem;
  if (savedArn === undefined) delete process.env.SHARED_MEMORY_ARN;
  else process.env.SHARED_MEMORY_ARN = savedArn;
});

test("insightsNamespace is deterministic and customer-scoped", () => {
  assert.equal(insightsNamespace("wa-abc"), "/insights/wa-abc/");
  assert.notEqual(insightsNamespace("wa-abc"), insightsNamespace("wa-def"));
});

test("readInsights extracts content.text from record summaries", async () => {
  let sentInput: Record<string, unknown> | undefined;
  const c: MemoryClientLike = {
    async send(cmd) {
      sentInput = (cmd as { input: Record<string, unknown> }).input;
      return {
        memoryRecordSummaries: [
          { content: { text: "Prefers oat milk" } },
          { content: { text: "Usual: large latte" } },
          { content: {} },
        ],
      };
    },
  };
  const out = await readInsights("wa-abc123", undefined, 10, c);
  assert.deepEqual(out, ["Prefers oat milk", "Usual: large latte"]);
  assert.equal(sentInput!.memoryId, MEM_ID);
  assert.equal(sentInput!.namespace, "/insights/wa-abc123/");
});

test("readInsights returns [] on client failure (never throws)", async () => {
  const c: MemoryClientLike = { async send() { throw new Error("boom"); } };
  assert.deepEqual(await readInsights("wa-abc123", undefined, 10, c), []);
});

test("readInsights returns [] when memory not configured", async () => {
  delete process.env.WA_MEMORY_ID;
  const c: MemoryClientLike = { async send() { throw new Error("should not be called"); } };
  assert.deepEqual(await readInsights("wa-abc123", undefined, 10, c), []);
});

test("readInsights falls back to parsing SHARED_MEMORY_ARN", async () => {
  delete process.env.WA_MEMORY_ID;
  process.env.SHARED_MEMORY_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/${MEM_ID}`;
  let sentInput: Record<string, unknown> | undefined;
  const c: MemoryClientLike = {
    async send(cmd) {
      sentInput = (cmd as { input: Record<string, unknown> }).input;
      return { memoryRecordSummaries: [] };
    },
  };
  await readInsights("wa-abc123", undefined, 10, c);
  assert.equal(sentInput!.memoryId, MEM_ID);
});

test("writeEvents builds a conversational payload keyed by customer", async () => {
  let sentInput: Record<string, unknown> | undefined;
  const c: MemoryClientLike = {
    async send(cmd) {
      sentInput = (cmd as { input: Record<string, unknown> }).input;
      return { event: { eventId: "evt-1" } };
    },
  };
  const turns: Turn[] = [
    { role: "USER", text: "I want a latte" },
    { role: "ASSISTANT", text: "One latte coming up" },
  ];
  assert.equal(await writeEvents("wa-abc123", turns, c), true);
  assert.equal(sentInput!.memoryId, MEM_ID);
  assert.equal(sentInput!.actorId, "wa-abc123");
  assert.equal(sentInput!.sessionId, "wa-abc123");
  const payload = sentInput!.payload as Array<Record<string, unknown>>;
  assert.equal(payload.length, 2);
  assert.deepEqual(payload[0], { conversational: { role: "USER", content: { text: "I want a latte" } } });
});

test("writeEvents skips blank turns and returns false if all blank", async () => {
  const c: MemoryClientLike = { async send() { throw new Error("should not be called"); } };
  assert.equal(await writeEvents("wa-abc123", [{ role: "USER", text: "   " }], c), false);
});

test("writeEvents returns false on client failure", async () => {
  const c: MemoryClientLike = { async send() { throw new Error("boom"); } };
  assert.equal(await writeEvents("wa-abc123", [{ role: "USER", text: "hi" }], c), false);
});

test("writeEvents returns false with no turns or no customer", async () => {
  const c: MemoryClientLike = { async send() { return {}; } };
  assert.equal(await writeEvents("wa-abc123", [], c), false);
  assert.equal(await writeEvents("", [{ role: "USER", text: "hi" }], c), false);
});
