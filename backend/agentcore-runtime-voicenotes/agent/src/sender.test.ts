import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { sendAudio, sendText, sendTyping, type LambdaLike } from "./sender.js";

const ARN = "arn:aws:lambda:us-east-1:123456789012:function:qsr-wa-wa-sender";

function fakeClient(reply: unknown, capture?: (input: Record<string, unknown>) => void): LambdaLike {
  return {
    async send(command: InvokeCommand) {
      const input = command.input as Record<string, unknown>;
      if (capture) capture(input);
      const body = Buffer.from(JSON.stringify(reply), "utf-8");
      return { Payload: new Uint8Array(body) };
    },
  };
}

let savedArn: string | undefined;
beforeEach(() => {
  savedArn = process.env.SENDER_LAMBDA_ARN;
  process.env.SENDER_LAMBDA_ARN = ARN;
});
afterEach(() => {
  if (savedArn === undefined) delete process.env.SENDER_LAMBDA_ARN;
  else process.env.SENDER_LAMBDA_ARN = savedArn;
});

test("sendAudio builds an audio payload and returns ok", async () => {
  let seen: Record<string, unknown> | undefined;
  const c = fakeClient({ ok: true }, (i) => (seen = i));
  const ok = await sendAudio("wa-abc123", "QUJD", "voicenote", c);
  assert.equal(ok, true);
  assert.equal(seen!.FunctionName, ARN);
  assert.equal(seen!.InvocationType, "RequestResponse");
  const payload = JSON.parse(Buffer.from(seen!.Payload as Uint8Array).toString("utf-8"));
  assert.deepEqual(payload, { kind: "audio", customer_id: "wa-abc123", audio_b64: "QUJD", channel: "voicenote" });
});

test("sendText builds a text payload", async () => {
  let seen: Record<string, unknown> | undefined;
  const c = fakeClient({ ok: true }, (i) => (seen = i));
  const ok = await sendText("wa-abc123", "hello", "voicenote", c);
  assert.equal(ok, true);
  const payload = JSON.parse(Buffer.from(seen!.Payload as Uint8Array).toString("utf-8"));
  assert.equal(payload.kind, "text");
  assert.equal(payload.text, "hello");
});

test("sendTyping builds a typing payload keyed by message_id", async () => {
  let seen: Record<string, unknown> | undefined;
  const c = fakeClient({ ok: true }, (i) => (seen = i));
  const ok = await sendTyping("wamid.XYZ", c);
  assert.equal(ok, true);
  const payload = JSON.parse(Buffer.from(seen!.Payload as Uint8Array).toString("utf-8"));
  assert.deepEqual(payload, { kind: "typing", message_id: "wamid.XYZ" });
});

test("not-ok response yields false", async () => {
  const c = fakeClient({ ok: false, reason: "no-window" });
  assert.equal(await sendAudio("wa-abc123", "QUJD", "voicenote", c), false);
});

test("invoke throwing yields false (never rejects)", async () => {
  const c: LambdaLike = { async send() { throw new Error("boom"); } };
  assert.equal(await sendText("wa-abc123", "hi", "voicenote", c), false);
});

test("empty inputs are refused without invoking", async () => {
  let called = false;
  const c: LambdaLike = { async send() { called = true; return {}; } };
  assert.equal(await sendAudio("", "QUJD", "voicenote", c), false);
  assert.equal(await sendAudio("wa-abc123", "", "voicenote", c), false);
  assert.equal(await sendText("wa-abc123", "   ", "voicenote", c), false);
  assert.equal(await sendTyping("", c), false);
  assert.equal(called, false);
});

test("missing SENDER_LAMBDA_ARN yields false", async () => {
  delete process.env.SENDER_LAMBDA_ARN;
  const c = fakeClient({ ok: true });
  assert.equal(await sendAudio("wa-abc123", "QUJD", "voicenote", c), false);
});
