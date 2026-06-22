"""Tests for the VoiceNotes Ogg Opus <-> PCM codec pure helpers (Task 12.2).

Feature: whatsapp-restaurant-ai-host

PyAV (``av``) is not exercised here - the libopus decode/encode path runs in the
ARM64 container and is validated by the container build smoke + the Task 12.8
integration test. These tests cover the PURE, av-free surface of ogg_codec:
sample math, frame padding, and the input-validation guards (empty input raises
before any ``av`` import), all property-checked with Hypothesis.
"""
from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from ogg_codec import (
    OPUS_FRAME_SAMPLES,
    PCM_SAMPLE_WIDTH,
    OggDecodeError,
    OggEncodeError,
    decode_ogg_opus_to_pcm,
    encode_pcm_to_ogg_opus,
    pad_pcm_to_frame,
    pcm_duration_seconds,
    pcm_num_samples,
)

# A PCM buffer is an even number of bytes (16-bit samples). We also throw in
# odd-length buffers to confirm the floor behavior.
_pcm = st.binary(min_size=0, max_size=4096)
_even_pcm = st.integers(min_value=0, max_value=2048).map(lambda n: b"\x01\x02" * n)


@given(pcm=_pcm)
def test_num_samples_is_floor_of_half(pcm):
    """Feature: whatsapp-restaurant-ai-host, Property (codec): sample count is
    floor(len/2) - a trailing odd byte is not a whole 16-bit sample."""
    assert pcm_num_samples(pcm) == len(pcm) // PCM_SAMPLE_WIDTH


@given(n=st.integers(min_value=0, max_value=4000), rate=st.sampled_from([16000, 24000, 48000]))
def test_duration_matches_samples_over_rate(n, rate):
    """Feature: whatsapp-restaurant-ai-host, Property (codec): duration equals
    sample_count / rate for a 16-bit mono buffer."""
    pcm = b"\x00\x00" * n
    assert pcm_duration_seconds(pcm, rate) == pytest.approx(n / rate)


def test_duration_rejects_nonpositive_rate():
    with pytest.raises(ValueError):
        pcm_duration_seconds(b"\x00\x00", 0)


@given(pcm=_even_pcm)
def test_pad_aligns_to_whole_opus_frames(pcm):
    """Feature: whatsapp-restaurant-ai-host, Property (codec): padding yields a
    whole multiple of the Opus frame size, never drops samples, and only ever
    appends trailing silence (the original is a prefix of the result)."""
    padded = pad_pcm_to_frame(pcm, OPUS_FRAME_SAMPLES)
    n_padded = pcm_num_samples(padded)
    # Whole number of Opus frames.
    assert n_padded % OPUS_FRAME_SAMPLES == 0
    # Never shrinks, never grows by a full frame or more.
    assert n_padded >= pcm_num_samples(pcm)
    assert n_padded - pcm_num_samples(pcm) < OPUS_FRAME_SAMPLES
    # Original data preserved as a prefix; only silence appended.
    assert padded[: len(pcm)] == pcm
    assert set(padded[len(pcm):]) <= {0}


@given(pcm=_even_pcm)
def test_pad_is_idempotent_on_aligned_input(pcm):
    """Feature: whatsapp-restaurant-ai-host, Property (codec): padding an
    already-aligned buffer is a no-op (idempotent)."""
    once = pad_pcm_to_frame(pcm, OPUS_FRAME_SAMPLES)
    twice = pad_pcm_to_frame(once, OPUS_FRAME_SAMPLES)
    assert once == twice


def test_pad_rejects_nonpositive_frame():
    with pytest.raises(ValueError):
        pad_pcm_to_frame(b"\x00\x00", 0)


def test_decode_empty_raises_before_av():
    """Empty inbound audio raises OggDecodeError without needing PyAV (the
    guard runs before the lazy `import av`)."""
    with pytest.raises(OggDecodeError):
        decode_ogg_opus_to_pcm(b"")


def test_encode_empty_raises_before_av():
    """Empty PCM raises OggEncodeError without needing PyAV."""
    with pytest.raises(OggEncodeError):
        encode_pcm_to_ogg_opus(b"")
