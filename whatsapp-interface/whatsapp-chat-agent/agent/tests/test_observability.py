"""Tests for the async-turn observability signals (async-reply-delivery R8).

The chat guarded turn emits started+completed on success and started+failed on
failure, keyed on the hashed customer_id only (no secret / raw wa_id / audio).
"""
from __future__ import annotations

import asyncio
import logging

import async_dispatch
import chat_agent


def test_signal_helpers_emit_grepable_markers(caplog):
    with caplog.at_level(logging.INFO):
        async_dispatch.turn_started("chat", "wa-abc")
        async_dispatch.turn_completed("chat", "wa-abc")
        async_dispatch.turn_failed("chat", "wa-abc")
    assert "async_turn_started channel=chat customer=wa-abc" in caplog.text
    assert "async_turn_completed channel=chat customer=wa-abc" in caplog.text
    assert "async_turn_failed channel=chat customer=wa-abc" in caplog.text


def test_guarded_turn_emits_started_then_completed(monkeypatch, caplog):
    async def ok(_payload):
        return {"ok": True}

    monkeypatch.setattr(chat_agent, "run_chat_turn", ok)
    with caplog.at_level(logging.INFO):
        asyncio.run(chat_agent._run_chat_turn_guarded({"customer_id": "wa-abc"}))
    assert "async_turn_started channel=chat customer=wa-abc" in caplog.text
    assert "async_turn_completed channel=chat customer=wa-abc" in caplog.text
    assert "async_turn_failed" not in caplog.text


def test_guarded_turn_emits_failed_and_sends_fallback(monkeypatch, caplog):
    async def boom(_payload):
        raise RuntimeError("turn blew up")

    sent: list[tuple[str, str, str]] = []

    async def fake_send(cid, text, channel):
        sent.append((cid, text, channel))
        return True

    monkeypatch.setattr(chat_agent, "run_chat_turn", boom)
    monkeypatch.setattr(chat_agent, "_default_send", fake_send)
    with caplog.at_level(logging.WARNING):
        asyncio.run(chat_agent._run_chat_turn_guarded({"customer_id": "wa-abc"}))
    assert "async_turn_failed channel=chat customer=wa-abc" in caplog.text
    assert sent and sent[0][0] == "wa-abc"


def test_signals_never_contain_a_raw_phone(caplog):
    # The signals take only channel + the hashed customer_id, so a raw E.164
    # can never appear in them.
    with caplog.at_level(logging.INFO):
        async_dispatch.turn_started("chat", "wa-1f0c3a9b2e4d6f80")
        async_dispatch.turn_completed("chat", "wa-1f0c3a9b2e4d6f80")
    assert "+1" not in caplog.text
    assert "15551230000" not in caplog.text
