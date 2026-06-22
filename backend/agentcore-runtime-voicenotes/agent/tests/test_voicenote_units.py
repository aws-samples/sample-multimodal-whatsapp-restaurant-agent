"""Unit tests for VoiceNotes failure replies and memory ordering (Task 12.7).

Feature: whatsapp-restaurant-ai-host

Covers the agent-side (Python) slice of Task 12.7:
  - R7.6: when the bounded session yields no usable audio, the handler returns
    the could-not-understand TEXT fallback (not an audio reply).
  - R7.9: the bounded session reads shared memory BEFORE the Sonic session and
    writes events AFTER it (read-before-session, write-at-end).

The Media-URL / download failure replies (R7.7/R7.8) live in the webhook worker
(TypeScript) and are covered by the webhook jest suite (chooseVoiceReply). The
live Sonic round-trip is the Task 12.8 integration test.
"""
from __future__ import annotations

import asyncio
import base64
from unittest import mock

import bounded_sonic
import handler
from bounded_sonic import BoundedResult
from memory_client import MemoryReadResult


def test_r76_no_usable_audio_returns_text_fallback():
    """R7.6: a decoded note whose bounded session produces no audio yields the
    could-not-understand text fallback, not an audio reply."""

    async def _no_audio(customer_id, input_pcm, **_kwargs):
        return BoundedResult(output_pcm=b"", ok=True)

    audio_b64 = base64.b64encode(b"fake-ogg").decode("ascii")
    with mock.patch.object(
        handler.ogg_codec, "decode_ogg_opus_to_pcm", return_value=b"\x00\x00" * 160
    ), mock.patch.object(handler.bounded_sonic, "run_bounded_session", new=_no_audio):
        out = asyncio.run(
            handler.run_voice_note_turn(
                {"customer_id": "wa-deadbeefdeadbeef", "audio_b64": audio_b64}
            )
        )
    assert out == {"fallback_text": handler.COULD_NOT_UNDERSTAND}


def test_r79_memory_read_before_session_write_after():
    """R7.9: run_bounded_session reads long-term memory before driving Sonic and
    writes events after - read-before-session, write-at-end."""
    order: list[str] = []

    class FakeMemory:
        def read_long_term(self, customer_id, *a, **k):
            order.append("read")
            return MemoryReadResult(insights=[], ok=True)

        def write_events(self, customer_id, session_id, turns):
            order.append("write")
            return True

    async def _fake_drive(**_kwargs):
        order.append("drive")
        return BoundedResult(output_pcm=b"\x00\x00" * 10, ok=True)

    with mock.patch.object(bounded_sonic, "_drive_sonic", new=_fake_drive):
        result = asyncio.run(
            bounded_sonic.run_bounded_session(
                "wa-deadbeefdeadbeef", b"\x00\x00" * 320, memory=FakeMemory()
            )
        )

    assert result.ok is True
    assert order == ["read", "drive", "write"]


def test_r79_memory_write_happens_even_when_session_fails():
    """R7.9 corollary: events are still written at session end even if the Sonic
    drive raises - the customer interaction is recorded and never hard-fails."""
    order: list[str] = []

    class FakeMemory:
        def read_long_term(self, customer_id, *a, **k):
            order.append("read")
            return MemoryReadResult(insights=[], ok=True)

        def write_events(self, customer_id, session_id, turns):
            order.append("write")
            return True

    async def _boom(**_kwargs):
        order.append("drive")
        raise RuntimeError("sonic exploded")

    with mock.patch.object(bounded_sonic, "_drive_sonic", new=_boom):
        result = asyncio.run(
            bounded_sonic.run_bounded_session(
                "wa-deadbeefdeadbeef", b"\x00\x00" * 320, memory=FakeMemory()
            )
        )

    assert result.ok is False
    assert order == ["read", "drive", "write"]
