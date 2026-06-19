// Pure order-lifecycle logic for the kitchen simulator + notifier (Task 27).
//
// A freshly placed order is `confirmed` (what the place-order lambda writes).
// The DEMO kitchen simulator advances it one step per scan:
//
//     confirmed --(age >= 1 min)--> in-preparation --(age >= 2 min)--> ready
//
// One step per scan guarantees each transition is its own DynamoDB Stream
// event, so the notifier sends a message for EACH stage (being-prepared, then
// ready) even if an order is stale (e.g. the notifier was briefly down). These
// thresholds are the simulator's stand-in for a real kitchen/POS advancing the
// order; they are intentionally short for demoing.
//
// This module is PURE (no AWS, no I/O) so it unit-tests without mocks. The
// message TEXT and the notify-worthy status set are owned by the webhook's
// orderConfirmation module (reused by the notifier) - this file only decides
// the kitchen-sim transitions and parses the timestamp.

/** Demo stage thresholds in milliseconds (age since order placement). */
export const STAGE_AT_MS = {
  inPreparation: 60_000, // 1 min: confirmed -> in-preparation
  ready: 120_000, // 2 min: in-preparation -> ready
} as const;

/** The next kitchen status for an order, or null when no transition is due yet.
 *  Advances at most ONE step (the caller applies it with an optimistic
 *  condition on the current status). Deterministic given (current, ageMs). */
export function nextStatus(current: string, ageMs: number): 'in-preparation' | 'ready' | null {
  if (current === 'confirmed' && ageMs >= STAGE_AT_MS.inPreparation) return 'in-preparation';
  if (current === 'in-preparation' && ageMs >= STAGE_AT_MS.ready) return 'ready';
  return null;
}

/** True when a stream MODIFY is a customer-notify-worthy status change: the
 *  status actually changed AND the new status is one we message about. Pure. */
export function isNotifiableTransition(
  oldStatus: string | undefined,
  newStatus: string | undefined,
): boolean {
  if (!newStatus || oldStatus === newStatus) return false;
  return newStatus === 'in-preparation' || newStatus === 'ready';
}
