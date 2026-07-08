import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dispatchTurn, withTypingRefresh, inFlightCount, resetForTests } from "./dispatch.js";

beforeEach(() => resetForTests());

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test("dispatchTurn serializes a customer's turns in order", async () => {
  const order: string[] = [];
  let releaseA!: () => void;
  const turnA = () =>
    new Promise<void>((r) => {
      order.push("A-start");
      releaseA = () => {
        order.push("A-end");
        r();
      };
    });
  const turnB = async () => {
    order.push("B-start");
  };

  dispatchTurn("wa-1", turnA);
  const pB = dispatchTurn("wa-1", turnB);

  await tick();
  assert.deepEqual(order, ["A-start"], "B must wait for A");
  releaseA();
  await pB;
  assert.deepEqual(order, ["A-start", "A-end", "B-start"]);
});

test("dispatchTurn runs different customers concurrently", async () => {
  const started: string[] = [];
  const mk = (id: string) => () =>
    new Promise<void>((r) => {
      started.push(id);
      setTimeout(r, 20);
    });
  dispatchTurn("wa-1", mk("1"));
  dispatchTurn("wa-2", mk("2"));
  await tick();
  assert.deepEqual(started.sort(), ["1", "2"], "both customers start without waiting");
});

test("inFlightCount tracks queued + running turns and drains to zero", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p1 = dispatchTurn("wa-1", () => gate);
  const p2 = dispatchTurn("wa-1", async () => {});
  assert.equal(inFlightCount(), 2);
  release();
  await Promise.all([p1, p2]);
  assert.equal(inFlightCount(), 0);
});

test("dispatchTurn: a thrown turn does not block the next turn or leak in-flight", async () => {
  const order: string[] = [];
  const p1 = dispatchTurn("wa-1", async () => {
    order.push("A");
    throw new Error("boom");
  });
  const p2 = dispatchTurn("wa-1", async () => {
    order.push("B");
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["A", "B"]);
  assert.equal(inFlightCount(), 0);
});

test("withTypingRefresh: no message id runs the turn without refreshing", async () => {
  let typed = 0;
  let ran = false;
  await withTypingRefresh(
    async () => {
      ran = true;
    },
    "",
    async () => {
      typed++;
      return true;
    },
    0.01,
  );
  assert.equal(ran, true);
  assert.equal(typed, 0);
});

test("withTypingRefresh: refreshes periodically while the turn runs, then stops", async () => {
  let typed = 0;
  await withTypingRefresh(
    () => new Promise<void>((r) => setTimeout(r, 60)),
    "wamid.XYZ",
    async () => {
      typed++;
      return true;
    },
    0.02,
  );
  assert.ok(typed >= 1, `expected at least one refresh, got ${typed}`);
});

test("withTypingRefresh: a failing typing send never breaks the turn", async () => {
  let ran = false;
  await withTypingRefresh(
    async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
      ran = true;
    },
    "wamid.XYZ",
    async () => {
      throw new Error("typing failed");
    },
    0.01,
  );
  assert.equal(ran, true);
});
