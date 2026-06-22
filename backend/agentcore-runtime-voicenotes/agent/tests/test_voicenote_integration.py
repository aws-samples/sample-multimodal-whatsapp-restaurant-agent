"""Integration test - end-to-end voice-note round-trip (Task 12.8).

Feature: whatsapp-restaurant-ai-host

The headline VoiceNotes integration test (R7.3/R7.4/R7.5): a real Ogg Opus note
in -> decode to 16 kHz PCM -> bounded Nova 2 Sonic speech-to-speech session ->
24 kHz PCM out -> encode to Ogg Opus, producing an Ogg Opus audio reply. This is
1-3 concrete examples, NOT a property run.

This test exercises the live codec (PyAV/libopus) and the live Nova Sonic
bidirectional stream, so it requires:
  - PyAV (`av`) installed (the ARM64 container has it; a bare checkout may not),
  - strands with the bidi extra installed,
  - real AWS credentials with Bedrock Nova 2 Sonic access,
  - the opt-in env flag RUN_VOICENOTES_INTEGRATION=1 (so it never runs by
    accident in unit-test CI).

When any of those is absent the test SKIPS cleanly - it is a real test that runs
in an integration environment, not a no-op. The codec-only leg (encode silence
-> decode back to PCM) runs whenever PyAV is present, giving a partial round-trip
check even without Bedrock.
"""
from __future__ import annotations

import asyncio
import os

import pytest

RUN_FLAG = "RUN_VOICENOTES_INTEGRATION"


def _have(mod: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(mod) is not None


@pytest.mark.skipif(not _have("av"), reason="PyAV (av) not installed")
def test_codec_roundtrip_silence_is_lossless_in_shape():
    """Codec-only leg (runs whenever PyAV is present): encoding 24 kHz silence to
    Ogg Opus and decoding it back to 16 kHz PCM yields a non-empty PCM buffer of
    the expected mono 16-bit shape. Validates the R7.4 transcode wiring without
    Bedrock."""
    import ogg_codec

    # ~200 ms of 24 kHz mono silence.
    pcm_24k = b"\x00\x00" * (24000 // 5)
    ogg = ogg_codec.encode_pcm_to_ogg_opus(pcm_24k, source_rate=24000)
    assert ogg and ogg[:4] == b"OggS"  # valid Ogg container magic

    pcm_16k = ogg_codec.decode_ogg_opus_to_pcm(ogg, target_rate=16000)
    assert pcm_16k  # non-empty
    assert len(pcm_16k) % 2 == 0  # whole 16-bit samples


@pytest.mark.skipif(
    os.environ.get(RUN_FLAG) != "1"
    or not _have("av")
    or not _have("strands"),
    reason=(
        f"set {RUN_FLAG}=1 with PyAV + strands + Bedrock Nova Sonic access to run "
        "the live voice-note round-trip"
    ),
)
def test_end_to_end_voice_note_round_trip():
    """Full round-trip against live Nova 2 Sonic (R7.3/R7.4/R7.5): an Ogg Opus
    note in -> bounded Sonic session -> Ogg Opus audio reply out. Asserts the
    reply is audio (type audio / Ogg Opus), never a text-only reply for a valid
    note."""
    import base64

    import handler
    import ogg_codec

    # Build a short Ogg Opus "note" (silence is enough to drive the pipeline;
    # the model will respond with its greeting). A real recorded note can be
    # dropped in here for a richer example.
    pcm_24k = b"\x00\x00" * (24000 // 2)  # 0.5 s
    note_ogg = ogg_codec.encode_pcm_to_ogg_opus(pcm_24k, source_rate=24000)
    payload = {
        "customer_id": "wa-integrationtest",
        "session_id": "wa-integrationtest",
        "audio_b64": base64.b64encode(note_ogg).decode("ascii"),
    }

    out = asyncio.run(handler.run_voice_note_turn(payload))

    # A valid note must yield an audio reply, not a text fallback (R7.5 / P22).
    assert "audio_b64" in out, f"expected audio reply, got {out}"
    reply_ogg = base64.b64decode(out["audio_b64"])
    assert reply_ogg[:4] == b"OggS"  # the reply is an Ogg Opus container
