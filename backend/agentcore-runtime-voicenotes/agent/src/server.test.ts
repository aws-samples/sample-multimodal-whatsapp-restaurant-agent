import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ackFor, pingBody, handleInvocation, createHttpServer, type Dispatch } from "./server.js";

// --- pure helpers -------------------------------------------------------

test("ackFor accepts a payload with customer_id", () => {
  assert.deepEqual(ackFor({ customer_id: "wa-abc" }), { accepted: true });
});

test("ackFor falls back to session_id", () => {
  assert.deepEqual(ackFor({ session_id: "wa-abc" }), { accepted: true });
});

test("ackFor rejects a payload with no identity", () => {
  assert.deepEqual(ackFor({}), { accepted: false, error: "missing_customer_id" });
});

test("pingBody reflects in-flight count", () => {
  assert.deepEqual(pingBody(0), { status: "Healthy" });
  assert.deepEqual(pingBody(3), { status: "HealthyBusy" });
});

// --- handleInvocation routing (injected dispatch) -----------------------

test("handleInvocation dispatches an accepted turn without running it", () => {
  const seen: Array<{ customerId: string; hasRun: boolean }> = [];
  const dispatch: Dispatch = (customerId, run) => {
    seen.push({ customerId, hasRun: typeof run === "function" });
  };
  const ack = handleInvocation({ customer_id: "wa-abc", audio_b64: "QQ==", message_id: "wamid.1" }, dispatch);
  assert.deepEqual(ack, { accepted: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].customerId, "wa-abc");
  assert.equal(seen[0].hasRun, true);
});

test("handleInvocation does not dispatch a rejected payload", () => {
  let dispatched = false;
  const dispatch: Dispatch = () => {
    dispatched = true;
  };
  const ack = handleInvocation({}, dispatch);
  assert.equal(ack.accepted, false);
  assert.equal(dispatched, false);
});

// --- HTTP surface -------------------------------------------------------

async function withServer(
  fn: (base: string, recorded: string[]) => Promise<void>,
): Promise<void> {
  const recorded: string[] = [];
  const dispatch: Dispatch = (customerId) => {
    recorded.push(customerId);
  };
  const server = createHttpServer({ dispatch, inFlight: () => 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, recorded);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /ping returns Healthy", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "Healthy" });
  });
});

test("POST /invocations acks and dispatches", async () => {
  await withServer(async (base, recorded) => {
    const res = await fetch(`${base}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: "wa-abc", audio_b64: "QQ==" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: true });
    assert.deepEqual(recorded, ["wa-abc"]);
  });
});

test("POST /invocations with no identity is not dispatched", async () => {
  await withServer(async (base, recorded) => {
    const res = await fetch(`${base}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_b64: "QQ==" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: false, error: "missing_customer_id" });
    assert.deepEqual(recorded, []);
  });
});

test("POST /invocations with malformed JSON returns 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_json");
  });
});

test("unknown route returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
