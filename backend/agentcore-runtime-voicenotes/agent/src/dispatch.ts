// Async turn dispatch + per-customer serialization for the VoiceNotes Runtime.
//
// Ported from async_dispatch.py. The runtime entrypoint acknowledges an
// invocation immediately and continues the turn in the background so the webhook
// worker is never blocked for the model turn. Two guarantees live here:
//   * Ack-then-continue: dispatchTurn schedules the work and returns the ack.
//   * Per-customer serialization: a customer's turns never run concurrently -
//     each turn is chained onto the customer's tail promise (Node is single-
//     threaded, so a promise chain per customerId is the natural equivalent of
//     the Python threading.Lock).
//
// This module imports nothing heavy so it stays unit-testable with fakes.
import { log } from "./log.js";

// --- Observability signals (async-reply-delivery R8) --------------------
// Structured, greppable markers for the start / completion / failure of each
// async turn. Keyed on the hashed customer_id only - never a secret, a raw
// wa_id, or audio bytes.

export function turnStarted(channel: string, customerId: string): void {
  log.info("async_turn_started", { channel, customer: customerId });
}

export function turnCompleted(channel: string, customerId: string): void {
  log.info("async_turn_completed", { channel, customer: customerId });
}

export function turnFailed(channel: string, customerId: string): void {
  log.warn("async_turn_failed", { channel, customer: customerId });
}

// --- Per-customer serialization + in-flight tracking --------------------
// A customer's turns must never run concurrently: turn N+1 waits for turn N to
// commit its context (memory) before it runs. Node is single-threaded, so the
// Python per-customer threading.Lock becomes a per-customerId PROMISE CHAIN -
// each turn is chained onto the customer's tail promise. The chain is coherent
// because the deterministic runtime session id routes a customer's invocations
// to the same microVM, where this process-local map lives.

/** customerId -> tail of that customer's serialized turn chain. */
const tails = new Map<string, Promise<void>>();
/** Number of turns currently queued or running (drives /ping HealthyBusy). */
let inflight = 0;

/** Current in-flight turn count (queued or running). Used by the /ping health check. */
export function inFlightCount(): number {
  return inflight;
}

/**
 * Chain `runTurn` onto the customer's serialized tail and return the chained
 * promise. Fire-and-forget from the entrypoint's perspective (it acks
 * immediately and does not await); the returned promise exists so tests and the
 * host can observe completion. A turn that throws is logged and never wedges the
 * customer's subsequent turns (the chain continues from a resolved state).
 */
export function dispatchTurn(customerId: string, runTurn: () => Promise<void>): Promise<void> {
  const prev = tails.get(customerId) ?? Promise.resolve();
  inflight++;
  const next = prev
    .catch(() => {}) // isolate: a prior turn's failure never blocks the next
    .then(() => runTurn())
    .catch((e) => log.error("async turn crashed", { customer: customerId, err: (e as Error).message }))
    .finally(() => {
      inflight--;
      if (tails.get(customerId) === next) tails.delete(customerId);
    });
  tails.set(customerId, next);
  return next;
}

/**
 * Run `turn` while refreshing the WhatsApp typing indicator best-effort. The
 * worker sends the initial indicator; this re-sends it every `intervalS` seconds
 * (< the ~25 s lapse) so it stays visible across a long turn, and stops as soon
 * as the turn finishes. A missing message id skips refreshing entirely; any
 * failure to send the indicator is swallowed - it never delays or fails the turn.
 */
export async function withTypingRefresh(
  turn: () => Promise<void>,
  messageId: string,
  sendTyping: (messageId: string) => Promise<boolean>,
  intervalS = 20,
): Promise<void> {
  if (!messageId) {
    await turn();
    return;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const refresher = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalS * 1000);
      });
      wake = undefined;
      if (stopped) return;
      try {
        await sendTyping(messageId);
      } catch {
        /* indicator is a nicety, never fatal */
      }
    }
  })();

  try {
    await turn();
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (wake) wake(); // wake the waiter so it observes `stopped` and exits
    await refresher.catch(() => {});
  }
}

/** Test helper - clear the per-customer chain registry and reset the counter. */
export function resetForTests(): void {
  tails.clear();
  inflight = 0;
}
