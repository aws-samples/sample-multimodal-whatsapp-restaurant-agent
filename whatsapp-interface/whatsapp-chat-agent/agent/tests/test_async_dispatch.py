"""Unit tests for async_dispatch (async-reply-delivery Move A + Component 2a).

Locks the two guarantees without a live AgentCore runtime, using a fake app and
real background threads:
  - ack-then-continue: dispatch_turn returns {"accepted": true} immediately and
    tracks the work via add_async_task / complete_async_task;
  - per-customer serialization: turns for one customer never run concurrently,
    and a failed turn releases the lock so the customer is never wedged.
"""
from __future__ import annotations

import asyncio
import threading
import time

import async_dispatch


class FakeApp:
    """Minimal stand-in for BedrockAgentCoreApp - only the async-task API."""

    def __init__(self) -> None:
        self.added: list[tuple[int, str]] = []
        self.completed: list[int] = []
        self._lock = threading.Lock()

    def add_async_task(self, name: str) -> int:
        with self._lock:
            tid = len(self.added) + 1
            self.added.append((tid, name))
        return tid

    def complete_async_task(self, tid: int) -> bool:
        with self._lock:
            self.completed.append(tid)
        return True


def _wait(cond, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_lock_for_is_stable_and_per_customer():
    async_dispatch.reset_locks_for_tests()
    a1 = async_dispatch._lock_for("wa-a")
    a2 = async_dispatch._lock_for("wa-a")
    b = async_dispatch._lock_for("wa-b")
    assert a1 is a2
    assert a1 is not b


def test_dispatch_returns_ack_and_tracks_task():
    async_dispatch.reset_locks_for_tests()
    app = FakeApp()
    ran = threading.Event()

    async def turn() -> None:
        ran.set()

    ack = async_dispatch.dispatch_turn(app, "chat_turn", "wa-x", lambda: turn())
    assert ack == {"accepted": True}
    assert ran.wait(2)
    assert _wait(lambda: len(app.completed) == 1)
    assert app.added and app.added[0][1] == "chat_turn"
    assert len(app.completed) == 1


def test_serializes_turns_for_one_customer():
    async_dispatch.reset_locks_for_tests()
    app = FakeApp()
    guard = threading.Lock()
    state = {"active": 0, "max": 0}

    def make_turn():
        async def turn() -> None:
            with guard:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            await asyncio.sleep(0.05)
            with guard:
                state["active"] -= 1

        return turn

    n = 5
    for _ in range(n):
        async_dispatch.dispatch_turn(app, "chat_turn", "wa-same", make_turn())

    assert _wait(lambda: len(app.completed) == n, timeout=5.0)
    # Non-concurrency: never more than one turn running for the same customer.
    assert state["max"] == 1


def test_failed_turn_releases_lock_and_completes_task():
    async_dispatch.reset_locks_for_tests()
    app = FakeApp()

    async def boom() -> None:
        raise RuntimeError("turn blew up")

    async_dispatch.dispatch_turn(app, "chat_turn", "wa-y", lambda: boom())

    ran = threading.Event()

    async def ok() -> None:
        ran.set()

    async_dispatch.dispatch_turn(app, "chat_turn", "wa-y", lambda: ok())

    # The second turn for the same customer still runs (lock was released), and
    # both tasks are marked complete despite the first throwing.
    assert ran.wait(3)
    assert _wait(lambda: len(app.completed) == 2)


def test_add_async_task_failure_still_runs_turn():
    async_dispatch.reset_locks_for_tests()

    class NoTrackApp:
        def add_async_task(self, name: str):
            raise RuntimeError("tracking unavailable")

        def complete_async_task(self, tid):  # pragma: no cover - never called
            raise AssertionError("should not complete a task that was never added")

    ran = threading.Event()

    async def turn() -> None:
        ran.set()

    ack = async_dispatch.dispatch_turn(NoTrackApp(), "chat_turn", "wa-z", lambda: turn())
    assert ack == {"accepted": True}
    assert ran.wait(2)
