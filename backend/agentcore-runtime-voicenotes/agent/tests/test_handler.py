"""Tests for the VoiceNotes handler decision branches (Task 12.4).

Feature: whatsapp-restaurant-ai-host

These cover the handler's pure decision surface that does NOT require a live
Nova Sonic session: missing-id, empty/invalid/garbage audio all degrade to the
could-not-understand TEXT fallback (R7.6). The happy-path voice round-trip needs
strands + a real Ogg note and is covered by the Task 12.8 integration test.

Each case is reached BEFORE any strands import: decode fails (or is skipped) so
the bounded session is never constructed, keeping these runnable without the
bidi extra. ``asyncio.run`` drives the async entrypoint directly (no
pytest-asyncio dependency needed).
"""
from __future__ import annotations

import asyncio
import base64

from handler import COULD_NOT_UNDERSTAND, run_voice_note_turn


def _run(payload: dict) -> dict:
    return asyncio.run(run_voice_note_turn(payload))


def test_missing_customer_id_returns_error():
    assert _run({}) == {"error": "missing_customer_id"}


def test_empty_audio_returns_text_fallback():
    out = _run({"customer_id": "wa-deadbeefdeadbeef"})
    assert out == {"fallback_text": COULD_NOT_UNDERSTAND}


def test_invalid_base64_returns_text_fallback():
    out = _run({"customer_id": "wa-deadbeefdeadbeef", "audio_b64": "!!! not base64 !!!"})
    assert out == {"fallback_text": COULD_NOT_UNDERSTAND}


def test_garbage_ogg_returns_text_fallback():
    # Valid base64 but not a valid Ogg container -> decode fails (with or
    # without PyAV present) -> could-not-understand fallback (R7.6).
    garbage = base64.b64encode(b"this is definitely not an ogg opus file").decode("ascii")
    out = _run({"customer_id": "wa-deadbeefdeadbeef", "audio_b64": garbage})
    assert out == {"fallback_text": COULD_NOT_UNDERSTAND}


def test_session_id_used_when_customer_id_absent():
    # session_id == customer_id (R5.1); empty audio still yields the fallback,
    # but the point is the handler does not error on missing customer_id when
    # session_id is present.
    out = _run({"session_id": "wa-deadbeefdeadbeef"})
    assert out == {"fallback_text": COULD_NOT_UNDERSTAND}
