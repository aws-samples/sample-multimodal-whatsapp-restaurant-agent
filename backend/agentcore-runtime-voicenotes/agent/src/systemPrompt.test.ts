import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSystemPrompt, BASE_SYSTEM_PROMPT } from "./systemPrompt.js";

test("no insights returns the base prompt unchanged", () => {
  assert.equal(renderSystemPrompt(), BASE_SYSTEM_PROMPT);
  assert.equal(renderSystemPrompt([]), BASE_SYSTEM_PROMPT);
});

test("blank/whitespace-only insights collapse to the base prompt", () => {
  assert.equal(renderSystemPrompt(["", "   "]), BASE_SYSTEM_PROMPT);
});

test("insights are appended as a bulleted memory block", () => {
  const out = renderSystemPrompt(["Prefers oat milk", "Usual: large latte"]);
  assert.ok(out.startsWith(BASE_SYSTEM_PROMPT));
  assert.ok(out.includes("What you remember about this customer"));
  assert.ok(out.includes("- Prefers oat milk"));
  assert.ok(out.includes("- Usual: large latte"));
});

test("blank entries are filtered out of a non-empty list", () => {
  const out = renderSystemPrompt(["Keeps kosher", "  "]);
  assert.ok(out.includes("- Keeps kosher"));
  assert.ok(!out.includes("-   \n"));
});

test("prompt is ASCII only", () => {
  const out = renderSystemPrompt(["Prefers oat milk"]);
  assert.ok(/^[\x00-\x7F]*$/.test(out), "system prompt must be ASCII");
});
