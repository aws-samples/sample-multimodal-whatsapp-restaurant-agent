"""Property 22 - voice-note round-trip is audio-in / audio-out (Task 12.6).

Feature: whatsapp-restaurant-ai-host

Property 22: for any valid inbound voice note (Ogg Opus), the path produces an
outbound message whose payload is Ogg Opus audio; it NEVER produces a text-only
reply for a valid voice note - the could-not-understand text fallback applies
ONLY when the bounded session yields no usable audio (R7.6).

The libopus codec and the live Nova Sonic session run in the container and are
exercised by the Task 12.8 integration test; here they are mocked at the module
boundary so the audio-in/audio-out ROUTING invariant is property-checked
deterministically. We patch:
  - ogg_codec.decode_ogg_opus_to_pcm -> returns fixed 16 kHz PCM (decode ok),
  - bounded_sonic.run_bounded_session -> returns a BoundedResult whose
    output_pcm is the generated value (sometimes empty = no usable audio),
  - ogg_codec.encode_ogg helper -> returns a fixed Ogg marker.

The invariant under test: the reply is audio iff the bounded session produced
usable audio, and is the text fallback otherwise - never both, never text when
audio exists.
"""
from __future__ import annotations

import asyncio
import base64
from unittest import mock

from hypothesis import given
from hypothesis import strategies as st

import handler
from bounded_sonic import BoundedResult

# A valid base64 Ogg payload (content irrelevant - decode is mocked).
_audio_b64 = st.binary(min_size=1, max_size=256).map(
    lambda b: base64.b64encode(b).decode("ascii")
)
# The bounded session's output PCM: empty => no usable audio; >=1 sample => audio.
_out_pcm = st.binary(min_size=0, max_size=512)


@given(audio_b64=_audio_b64, out_pcm=_out_pcm)
def test_property22_audio_in_audio_out(audio_b64, out_pcm):
    """Feature: whatsapp-restaurant-ai-host, Property 22: Voice-note round-trip
    is audio-in / audio-out - a valid voice note yields an audio reply iff the
    bounded session produced usable audio, and the text fallback otherwise
    (never text when audio exists, never both)."""

    async def _fake_session(customer_id, input_pcm, **_kwargs):
        return BoundedResult(output_pcm=out_pcm, ok=True)

    with mock.patch.object(
        handler.ogg_codec, "decode_ogg_opus_to_pcm", return_value=b"\x00\x00" * 160
    ), mock.patch.object(
        handler.bounded_sonic, "run_bounded_session", new=_fake_session
    ), mock.patch.object(
        handler.ogg_codec, "encode_pcm_to_ogg_opus", return_value=b"OggS-reply"
    ):
        out = asyncio.run(
            handler.run_voice_note_turn(
                {"customer_id": "wa-deadbeefdeadbeef", "audio_b64": audio_b64}
            )
        )

    has_usable_audio = len(out_pcm) >= 2  # >= one 16-bit sample
    if has_usable_audio:
        # Audio out, never the text fallback.
        assert "audio_b64" in out
        assert "fallback_text" not in out
        # The reply payload is the encoded Ogg bytes (base64).
        assert base64.b64decode(out["audio_b64"]) == b"OggS-reply"
    else:
        # No usable audio -> text fallback only (R7.6).
        assert "fallback_text" in out
        assert "audio_b64" not in out
