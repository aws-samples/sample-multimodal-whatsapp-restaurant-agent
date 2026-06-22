"""Tests for the pure PCM frame buffer behind SonicOutputTrack (Task 16.3).

Feature: whatsapp-restaurant-ai-host

OutputBuffer carries no native deps, so its framing / underrun-silence / barge-in
behavior is unit-tested without aiortc or PyAV (the SonicOutputTrack recv() that
builds av.AudioFrames is exercised live in the container).
"""
from __future__ import annotations

import transcode


def test_exact_frame_then_remainder_padded():
    b = transcode.OutputBuffer()
    b.queue_pcm(b"\x01\x02\x03\x04\x05\x06")
    assert b.next_frame(4) == b"\x01\x02\x03\x04"
    # 2 bytes remain -> padded to a full 4-byte frame with silence.
    assert b.next_frame(4) == b"\x05\x06\x00\x00"


def test_underrun_returns_full_silence_frame():
    b = transcode.OutputBuffer()
    assert b.next_frame(4) == b"\x00\x00\x00\x00"


def test_frame_spans_multiple_queued_chunks():
    b = transcode.OutputBuffer()
    b.queue_pcm(b"\x01\x02")
    b.queue_pcm(b"\x03\x04\x05\x06")
    assert b.next_frame(4) == b"\x01\x02\x03\x04"
    assert b.next_frame(4) == b"\x05\x06\x00\x00"


def test_clear_drops_queued_and_partial():
    b = transcode.OutputBuffer()
    b.queue_pcm(b"\xff" * 10)
    assert b.next_frame(4) == b"\xff\xff\xff\xff"  # leaves 6 bytes partial+queued
    b.clear()
    assert b.pending_bytes() == 0
    assert b.next_frame(4) == b"\x00\x00\x00\x00"


def test_pending_bytes_tracks_queue_and_partial():
    b = transcode.OutputBuffer()
    b.queue_pcm(b"\x01\x02\x03\x04\x05\x06")
    assert b.pending_bytes() == 6
    b.next_frame(4)
    assert b.pending_bytes() == 2


def test_empty_queue_pcm_is_noop():
    b = transcode.OutputBuffer()
    b.queue_pcm(b"")
    assert b.pending_bytes() == 0
