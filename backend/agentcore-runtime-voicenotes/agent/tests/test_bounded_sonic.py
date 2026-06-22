"""Tests for the bounded Sonic session pure helpers (Task 12.3).

Feature: whatsapp-restaurant-ai-host

strands (the Nova Sonic bidi SDK) is not exercised here - the live
speech-to-speech round-trip runs in the container and is validated by the
Task 12.8 integration test. These tests cover the PURE, strands-free surface of
bounded_sonic: input framing, silence generation, output aggregation, and the
result helpers, property-checked with Hypothesis.
"""
from __future__ import annotations

import base64

from hypothesis import given
from hypothesis import strategies as st

from bounded_sonic import (
    INPUT_FRAME_BYTES,
    INPUT_FRAME_MS,
    SAMPLE_WIDTH,
    BoundedResult,
    OutputAudioCollector,
    iter_audio_frames,
    num_silence_frames,
    pcm_is_usable,
    silence_frame,
)

_pcm = st.binary(min_size=0, max_size=8192)


@given(pcm=_pcm)
def test_pcm_is_usable_matches_sample_threshold(pcm):
    """Feature: whatsapp-restaurant-ai-host, Property (voicenotes): a buffer is
    usable iff it holds at least one whole 16-bit sample."""
    assert pcm_is_usable(pcm) == (len(pcm) >= SAMPLE_WIDTH)


@given(pcm=_pcm, frame=st.integers(min_value=2, max_value=2048))
def test_iter_audio_frames_uniform_and_lossless(pcm, frame):
    """Feature: whatsapp-restaurant-ai-host, Property (voicenotes): every framed
    chunk is exactly ``frame`` bytes (last zero-padded), the frame count is
    ceil(len/frame), and the concatenation reproduces the input as a prefix
    (only trailing silence is added)."""
    frames = list(iter_audio_frames(pcm, frame))
    expected_count = (len(pcm) + frame - 1) // frame if pcm else 0
    assert len(frames) == expected_count
    assert all(len(f) == frame for f in frames)
    joined = b"".join(frames)
    assert joined[: len(pcm)] == pcm
    # Anything past the original is silence padding.
    assert set(joined[len(pcm):]) <= {0}


def test_iter_audio_frames_empty_yields_nothing():
    assert list(iter_audio_frames(b"", INPUT_FRAME_BYTES)) == []


def test_silence_frame_length_and_content():
    sf = silence_frame(INPUT_FRAME_BYTES)
    assert len(sf) == INPUT_FRAME_BYTES
    assert set(sf) <= {0}


@given(ms=st.integers(min_value=-100, max_value=10000))
def test_num_silence_frames_is_ceil(ms):
    """Feature: whatsapp-restaurant-ai-host, Property (voicenotes): silence frame
    count is ceil(ms/frame_ms) for positive ms and 0 for non-positive ms."""
    n = num_silence_frames(ms, INPUT_FRAME_MS)
    if ms <= 0:
        assert n == 0
    else:
        assert n == (ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS
        # Covers at least the requested duration, by less than one frame over.
        assert (n - 1) * INPUT_FRAME_MS < ms <= n * INPUT_FRAME_MS


@given(chunks=st.lists(st.binary(min_size=0, max_size=512), min_size=0, max_size=20))
def test_output_collector_concatenates_in_order(chunks):
    """Feature: whatsapp-restaurant-ai-host, Property (voicenotes): the collector
    returns the in-order concatenation of every decoded chunk it was fed."""
    collector = OutputAudioCollector()
    expected = b""
    for c in chunks:
        collector.feed(base64.b64encode(c).decode("ascii"))
        expected += c
    assert collector.pcm() == expected
    assert len(collector) == len(expected)


def test_output_collector_ignores_empty_feed():
    collector = OutputAudioCollector()
    collector.feed("")
    assert collector.pcm() == b""


def test_bounded_result_has_audio():
    assert BoundedResult(output_pcm=b"\x01\x02").has_audio is True
    assert BoundedResult(output_pcm=b"").has_audio is False
    assert BoundedResult(output_pcm=b"\x01").has_audio is False  # < one sample
