"""Tests for the VoiceNotes runtime-owned per-segment delivery
(async-reply-delivery Move B / Step 2).

Covers, without a live Nova Sonic session or AWS:
  - sender_client: send_audio / send_text / send_typing payload shaping;
  - run_voice_note_turn: each speech segment is encoded and handed to the
    deliver_audio sink; no-audio yields the text fallback;
  - _run_voice_turn_guarded: delivers each segment as a voice note, sends the
    text fallback when no audio, and degrades an oversize segment to text.
"""
from __future__ import annotations

import asyncio
import base64

import handler
import sender_client
from bounded_sonic import BoundedResult


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


# --- sender_client payload shaping -----------------------------------------

def test_send_audio_builds_audio_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr(sender_client, "_invoke", lambda p: captured.update(p) or True)
    ok = sender_client.send_audio("wa-x", "b64audio", channel="voicenote")
    assert ok is True
    assert captured == {
        "kind": "audio",
        "customer_id": "wa-x",
        "audio_b64": "b64audio",
        "channel": "voicenote",
    }


def test_send_text_builds_text_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr(sender_client, "_invoke", lambda p: captured.update(p) or True)
    sender_client.send_text("wa-x", "hello")
    assert captured["kind"] == "text"
    assert captured["customer_id"] == "wa-x"
    assert captured["text"] == "hello"


def test_send_typing_builds_typing_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr(sender_client, "_invoke", lambda p: captured.update(p) or True)
    sender_client.send_typing("wamid.ABC")
    assert captured == {"kind": "typing", "message_id": "wamid.ABC"}


def test_send_audio_empty_is_refused(monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(sender_client, "_invoke", lambda p: called.__setitem__("n", called["n"] + 1) or True)
    assert sender_client.send_audio("wa-x", "") is False
    assert sender_client.send_audio("", "b64") is False
    assert called["n"] == 0


# --- helpers ----------------------------------------------------------------

def _mock_codec(monkeypatch, encoded: bytes = b"OggS"):
    monkeypatch.setattr(handler.ogg_codec, "decode_ogg_opus_to_pcm", lambda b: b"\x00\x00" * 160)
    monkeypatch.setattr(handler.ogg_codec, "encode_pcm_to_ogg_opus", lambda pcm: encoded)


def _payload():
    return {"customer_id": "wa-x", "audio_b64": _b64(b"in")}


# --- run_voice_note_turn: per-segment encode + deliver ----------------------

def test_run_voice_note_turn_delivers_each_segment(monkeypatch):
    _mock_codec(monkeypatch, encoded=b"OggS")

    async def fake_session(cid, pcm, on_segment=None, **_):
        await on_segment(b"seg1pcm")
        await on_segment(b"seg2pcm")
        return BoundedResult(segments_delivered=2, ok=True)

    monkeypatch.setattr(handler.bounded_sonic, "run_bounded_session", fake_session)

    delivered: list[str] = []

    async def deliver(b64: str) -> None:
        delivered.append(b64)

    out = asyncio.run(handler.run_voice_note_turn(_payload(), deliver_audio=deliver))
    assert out.get("delivered") == 2
    assert delivered == [_b64(b"OggS"), _b64(b"OggS")]


def test_run_voice_note_turn_no_audio_returns_fallback(monkeypatch):
    _mock_codec(monkeypatch)

    async def fake_session(cid, pcm, on_segment=None, **_):
        return BoundedResult(segments_delivered=0, ok=True)

    monkeypatch.setattr(handler.bounded_sonic, "run_bounded_session", fake_session)

    called = {"n": 0}

    async def deliver(_b64: str) -> None:
        called["n"] += 1

    out = asyncio.run(handler.run_voice_note_turn(_payload(), deliver_audio=deliver))
    assert out.get("fallback_text")
    assert called["n"] == 0


# --- _run_voice_turn_guarded: delivery + fallbacks --------------------------

def test_guarded_delivers_segments_as_voice_notes(monkeypatch):
    _mock_codec(monkeypatch, encoded=b"OggS")

    async def fake_session(cid, pcm, on_segment=None, **_):
        await on_segment(b"seg1")
        await on_segment(b"seg2")
        return BoundedResult(segments_delivered=2, ok=True)

    monkeypatch.setattr(handler.bounded_sonic, "run_bounded_session", fake_session)
    audios: list[str] = []
    texts: list[str] = []
    monkeypatch.setattr(handler.sender_client, "send_audio",
                        lambda cid, b64, channel="voicenote": audios.append(b64) or True)
    monkeypatch.setattr(handler.sender_client, "send_text",
                        lambda cid, t, channel="voicenote": texts.append(t) or True)

    asyncio.run(handler._run_voice_turn_guarded(_payload()))
    assert len(audios) == 2
    assert texts == []


def test_guarded_no_audio_sends_text_fallback(monkeypatch):
    _mock_codec(monkeypatch)

    async def fake_session(cid, pcm, on_segment=None, **_):
        return BoundedResult(segments_delivered=0, ok=True)

    monkeypatch.setattr(handler.bounded_sonic, "run_bounded_session", fake_session)
    texts: list[str] = []
    monkeypatch.setattr(handler.sender_client, "send_text",
                        lambda cid, t, channel="voicenote": texts.append(t) or True)
    monkeypatch.setattr(handler.sender_client, "send_audio",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no audio expected")))

    asyncio.run(handler._run_voice_turn_guarded(_payload()))
    assert texts == [handler.COULD_NOT_UNDERSTAND]


def test_guarded_oversize_segment_degrades_to_text(monkeypatch):
    # Encoded audio large enough that its base64 exceeds the invoke limit.
    _mock_codec(monkeypatch, encoded=b"\x00" * (handler.MAX_AUDIO_B64_CHARS))

    async def fake_session(cid, pcm, on_segment=None, **_):
        await on_segment(b"seg")
        return BoundedResult(segments_delivered=1, ok=True)

    monkeypatch.setattr(handler.bounded_sonic, "run_bounded_session", fake_session)
    audios: list[str] = []
    texts: list[str] = []
    monkeypatch.setattr(handler.sender_client, "send_audio",
                        lambda cid, b64, channel="voicenote": audios.append(b64) or True)
    monkeypatch.setattr(handler.sender_client, "send_text",
                        lambda cid, t, channel="voicenote": texts.append(t) or True)

    asyncio.run(handler._run_voice_turn_guarded(_payload()))
    assert audios == []  # oversize segment not sent as audio
    assert texts == [handler.COULD_NOT_UNDERSTAND]
