"""Async turn dispatch + per-customer serialization for the AgentCore runtimes
(async-reply-delivery, Move A + Component 2a).

The runtime entrypoint acknowledges an invocation immediately (a fast
``{"accepted": true}``) and continues the turn in the background, so the webhook
worker Lambda is never blocked for the model turn. Two guarantees live here:

  * **Ack-then-continue** - ``dispatch_turn`` registers the work with the
    AgentCore async-task API (``app.add_async_task`` / ``complete_async_task``)
    so ``/ping`` reports ``HealthyBusy`` while the turn runs and the microVM is
    not idle-terminated mid-turn, then returns the ack synchronously.

  * **Per-customer serialization (Component 2a)** - a customer's turns never run
    concurrently: a per-``customer_id`` lock is held for the whole turn, so
    turn N+1 waits for turn N to commit its context (session store + memory)
    before it runs. This is coherent because the deterministic runtime session
    id routes a customer's invocations to the same microVM, where this
    process-local lock lives. It guarantees NON-CONCURRENCY (the correctness
    need); strict arrival ordering across rapid-fire messages additionally needs
    ordered ingestion (a documented enhancement).

Each background turn runs in its own thread with its own ``asyncio`` event loop
(``asyncio.run``), so the per-customer lock is a cross-thread ``threading.Lock``
(an ``asyncio.Lock`` would not span the independent loops). The lock is always
released in a ``finally`` - a failed turn never wedges a customer's subsequent
messages.

This module imports NOTHING heavy (no bedrock_agentcore, strands, boto3), so it
is unit-testable with a fake app and stays importable in the Docker smoke test.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

# Per-customer serialization locks. The guard protects the dict itself; each
# value serializes one customer's turns. Process-local (per microVM).
_locks_guard = threading.Lock()
_customer_locks: dict[str, threading.Lock] = {}


def _lock_for(customer_id: str) -> threading.Lock:
    """Return the (stable) serialization lock for a customer, creating it once."""
    with _locks_guard:
        lock = _customer_locks.get(customer_id)
        if lock is None:
            lock = threading.Lock()
            _customer_locks[customer_id] = lock
        return lock


def run_turn_blocking(customer_id: str, turn: Callable[[], Awaitable[None]]) -> None:
    """Acquire the customer's serialization lock and run ``turn`` to completion
    on a fresh event loop. Never raises: a turn that throws is logged (the turn
    itself owns any customer-facing fallback). The lock is always released.

    Exposed (not just inlined in ``dispatch_turn``) so serialization can be
    tested deterministically without the AgentCore app.
    """
    lock = _lock_for(customer_id)
    lock.acquire()
    try:
        asyncio.run(turn())
    except Exception:  # noqa: BLE001 - a background turn must never crash the worker/thread
        logger.exception("async turn crashed for %s", customer_id)
    finally:
        lock.release()


def dispatch_turn(
    app: Any,
    task_name: str,
    customer_id: str,
    turn: Callable[[], Awaitable[None]],
) -> dict:
    """Acknowledge immediately and run ``turn`` in the background, serialized per
    ``customer_id``. Returns the ack the entrypoint should return to the worker.

    ``app`` is the BedrockAgentCoreApp (only its ``add_async_task`` /
    ``complete_async_task`` are used, so a fake app works in tests).
    """
    task_id = None
    try:
        task_id = app.add_async_task(task_name)
    except Exception:  # noqa: BLE001 - task tracking is best-effort telemetry
        logger.exception("add_async_task failed for %s", customer_id)

    def _worker() -> None:
        try:
            run_turn_blocking(customer_id, turn)
        finally:
            if task_id is not None:
                try:
                    app.complete_async_task(task_id)
                except Exception:  # noqa: BLE001
                    logger.exception("complete_async_task failed for %s", customer_id)

    threading.Thread(target=_worker, name=f"turn-{customer_id[:24]}", daemon=True).start()
    return {"accepted": True}


async def with_typing_refresh(
    turn: Callable[[], Awaitable[None]],
    message_id: str,
    send_typing: Callable[[str], Any],
    interval: float = 20.0,
) -> None:
    """Run ``turn`` while refreshing the WhatsApp typing indicator best-effort
    (async-reply-delivery R7). The worker sends the initial indicator; this
    re-sends it every ``interval`` seconds (< the ~25 s lapse) so it stays
    visible across a long turn, and stops as soon as the turn finishes.

    Best-effort by contract: a missing message id skips refreshing entirely, and
    any failure to send the indicator is swallowed - it never delays or fails the
    turn. ``send_typing`` is the (blocking) Sender-Lambda call, run off the event
    loop; it is injected so this stays dependency-free and testable.
    """
    if not message_id:
        await turn()
        return

    stop = asyncio.Event()

    async def _refresher() -> None:
        try:
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=interval)
                    return  # stop was set -> the turn finished
                except asyncio.TimeoutError:
                    pass  # interval elapsed -> refresh
                try:
                    await asyncio.to_thread(send_typing, message_id)
                except Exception:  # noqa: BLE001 - indicator is a nicety, never fatal
                    logger.debug("typing refresh failed for %s", message_id)
        except asyncio.CancelledError:  # pragma: no cover - cancellation path
            pass

    task = asyncio.ensure_future(_refresher())
    try:
        await turn()
    finally:
        stop.set()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


# --- Observability (async-reply-delivery R8) --------------------------------
# Structured, machine-greppable signals for the start / completion / failure of
# each async turn. Durable + observable via CloudWatch Logs; a metric filter or
# EMF can turn these markers into metrics in production. In-flight turn count is
# already observable via /ping HealthyBusy + app.get_async_task_info(). Keyed on
# the HASHED customer_id only - never a secret, a raw wa_id, or audio bytes
# (R8.4).

def turn_started(channel: str, customer_id: str) -> None:
    logger.info("async_turn_started channel=%s customer=%s", channel, customer_id)


def turn_completed(channel: str, customer_id: str) -> None:
    logger.info("async_turn_completed channel=%s customer=%s", channel, customer_id)


def turn_failed(channel: str, customer_id: str) -> None:
    logger.warning("async_turn_failed channel=%s customer=%s", channel, customer_id)


def reset_locks_for_tests() -> None:
    """Test helper - clear the per-customer lock registry."""
    with _locks_guard:
        _customer_locks.clear()
