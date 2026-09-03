"""Tests for with_typing_refresh (async-reply-delivery R7).

Locks the best-effort typing-indicator refresh: skipped without a message id,
fired periodically across a long turn, not fired for a short turn, and a
send failure never breaks the turn.
"""
from __future__ import annotations

import asyncio

import async_dispatch


def test_no_message_id_skips_refresh():
    calls: list[str] = []
    ran: list[int] = []

    async def turn() -> None:
        ran.append(1)

    asyncio.run(async_dispatch.with_typing_refresh(turn, "", lambda mid: calls.append(mid)))
    assert ran == [1]
    assert calls == []


def test_refreshes_during_a_long_turn():
    calls: list[str] = []

    async def turn() -> None:
        await asyncio.sleep(0.07)

    asyncio.run(
        async_dispatch.with_typing_refresh(
            turn, "wamid.1", lambda mid: calls.append(mid), interval=0.02
        )
    )
    assert len(calls) >= 1
    assert all(c == "wamid.1" for c in calls)


def test_short_turn_does_not_refresh():
    calls: list[str] = []

    async def turn() -> None:
        return None

    asyncio.run(
        async_dispatch.with_typing_refresh(
            turn, "wamid.1", lambda mid: calls.append(mid), interval=1.0
        )
    )
    assert calls == []


def test_typing_failure_does_not_break_turn():
    ran: list[int] = []

    async def turn() -> None:
        await asyncio.sleep(0.05)
        ran.append(1)

    def boom(_mid: str) -> None:
        raise RuntimeError("typing relay down")

    asyncio.run(
        async_dispatch.with_typing_refresh(turn, "wamid.1", boom, interval=0.02)
    )
    assert ran == [1]
