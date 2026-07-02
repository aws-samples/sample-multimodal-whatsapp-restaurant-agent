"""Tests for the async-turn observability signals (async-reply-delivery R8).

The voice-note guarded turn emits started+completed on success and
started+failed on failure, keyed on the hashed customer_id only.
"""
from __future__ import annotations

import asyncio
import logging

import async_dispatch
import handler


def test_signal_helpers_emit_grepable_markers(caplog):
    with caplog.at_level(logging.INFO):
        async_dispatch.turn_started("voicenote", "wa-abc")
        async_dispatch.turn_completed("voicenote", "wa-abc")
        async_dispatch.turn_failed("voicenote", "wa-abc")
    assert "async_turn_started channel=voicenote customer=wa-abc" in caplog.text
    assert "async_turn_completed channel=voicenote customer=wa-abc" in caplog.text
    assert "async_turn_failed channel=voicenote customer=wa-abc" in caplog.text


def test_guarded_turn_emits_started_then_completed(monkeypatch, caplog):
    async def a_turn(_payload, deliver_audio=None):
        return {"fallback_text": "please resend"}

    monkeypatch.setattr(handler, "run_voice_note_turn", a_turn)
    monkeypatch.setattr(handler.sender_client, "send_text", lambda *a, **k: True)
    with caplog.at_level(logging.INFO):
        asyncio.run(handler._run_voice_turn_guarded({"customer_id": "wa-abc"}))
    assert "async_turn_started channel=voicenote customer=wa-abc" in caplog.text
    assert "async_turn_completed channel=voicenote customer=wa-abc" in caplog.text
    assert "async_turn_failed" not in caplog.text


def test_guarded_turn_emits_failed_and_sends_fallback(monkeypatch, caplog):
    async def boom(_payload, deliver_audio=None):
        raise RuntimeError("sonic blew up")

    sent: list[str] = []
    monkeypatch.setattr(handler, "run_voice_note_turn", boom)
    monkeypatch.setattr(handler.sender_client, "send_text", lambda cid, text, channel="voicenote": sent.append(cid) or True)
    with caplog.at_level(logging.WARNING):
        asyncio.run(handler._run_voice_turn_guarded({"customer_id": "wa-abc"}))
    assert "async_turn_failed channel=voicenote customer=wa-abc" in caplog.text
    assert sent == ["wa-abc"]
