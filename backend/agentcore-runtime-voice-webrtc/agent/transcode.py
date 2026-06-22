"""WebRTC <-> Nova 2 Sonic audio bridge for the Call Runtime (Task 16.3).

Two pieces wire aiortc's media tracks to the Strands BidiAgent:

  - InboundResampler: Meta's inbound Opus is decoded by aiortc into
    ``av.AudioFrame``s (typically 48 kHz, mono/stereo, s16). We resample to
    16 kHz / 16-bit / mono PCM - exactly what Nova 2 Sonic's audioInput expects
    (MODEL_INPUT_SAMPLE_RATE / MODEL_CHANNELS) - and hand back raw PCM bytes the
    caller base64-encodes into a BidiAudioInputEvent.

  - SonicOutputTrack: a sendable aiortc MediaStreamTrack. Nova Sonic's
    audioOutput (16 kHz mono s16, see protocol.MODEL_OUTPUT_SAMPLE_RATE) is
    pushed in via queue_pcm(); recv() emits wall-clock-paced 20 ms frames, with
    monotonic pts and silence on underrun (which doubles as outbound comfort
    noise / keepalive). clear_buffer() is the barge-in primitive (drop queued
    agent speech the instant the caller talks over it).

The pure byte-buffer math lives in OutputBuffer so it unit-tests without aiortc
or PyAV (both are native and do not build on a dev Mac). av is imported lazily;
aiortc's MediaStreamTrack base is imported under a guard so this module imports
for tests even when aiortc is absent.
"""
from __future__ import annotations

import asyncio
import fractions
import logging
import threading
import time
from collections import deque
from typing import List, Optional

from protocol import MODEL_INPUT_SAMPLE_RATE, MODEL_OUTPUT_SAMPLE_RATE

logger = logging.getLogger(__name__)

_BYTES_PER_SAMPLE = 2  # s16 little-endian, mono
_FRAME_MS = 0.02  # 20 ms WebRTC framing (matches Meta's a=ptime:20)


# aiortc is a native dep; guard the import so the pure OutputBuffer (and these
# tests) load without it. SonicOutputTrack subclasses the real base in the
# container and a plain object under test.
try:  # pragma: no cover - exercised only where aiortc is installed
    from aiortc import MediaStreamTrack as _MediaStreamTrack
    _HAVE_AIORTC = True
except Exception:  # pragma: no cover
    _MediaStreamTrack = object  # type: ignore[assignment,misc]
    _HAVE_AIORTC = False


class OutputBuffer:
    """Thread-safe PCM byte buffer feeding fixed-size frames (pure, no deps).

    Holds queued Nova Sonic PCM and serves exact ``frame_bytes``-sized chunks,
    zero-padding (silence) on underrun. Separated from the aiortc track so the
    framing/underrun/barge-in logic is unit-testable without native deps."""

    def __init__(self) -> None:
        self._chunks: deque[bytes] = deque()
        self._partial = b""
        self._lock = threading.Lock()

    def queue_pcm(self, pcm: bytes) -> None:
        if pcm:
            with self._lock:
                self._chunks.append(pcm)

    def clear(self) -> None:
        """Barge-in: drop all queued + partial audio."""
        with self._lock:
            self._chunks.clear()
            self._partial = b""

    def next_frame(self, frame_bytes: int) -> bytes:
        """Return exactly ``frame_bytes`` bytes, zero-padded on underrun."""
        with self._lock:
            data = self._partial
            while len(data) < frame_bytes and self._chunks:
                data += self._chunks.popleft()
            if len(data) >= frame_bytes:
                self._partial = data[frame_bytes:]
                return data[:frame_bytes]
            # Underrun: emit what we have padded to a full frame of silence.
            self._partial = b""
            return data + b"\x00" * (frame_bytes - len(data))

    def pending_bytes(self) -> int:
        with self._lock:
            return len(self._partial) + sum(len(c) for c in self._chunks)


class InboundResampler:
    """Resample aiortc inbound frames to Nova Sonic's 16 kHz mono s16 PCM.

    av.AudioResampler is created lazily (native dep) and handles any inbound
    rate/layout Meta negotiates (usually 48 kHz). resample() may emit zero or
    more frames per input frame; we return one PCM byte-string per output
    frame."""

    def __init__(self, target_rate: int = MODEL_INPUT_SAMPLE_RATE) -> None:
        self._target_rate = target_rate
        self._resampler = None  # built on first use

    def _ensure(self):
        if self._resampler is None:
            import av  # lazy native import

            self._resampler = av.AudioResampler(
                format="s16", layout="mono", rate=self._target_rate
            )
        return self._resampler

    def frame_to_pcm(self, frame) -> List[bytes]:
        """Resample one inbound av.AudioFrame to a list of 16 kHz mono PCM blobs."""
        resampler = self._ensure()
        out: List[bytes] = []
        for resampled in resampler.resample(frame):
            # s16/mono: to_ndarray() is shape (1, samples); tobytes() is LE s16.
            out.append(resampled.to_ndarray().tobytes())
        return out


class SonicOutputTrack(_MediaStreamTrack):  # type: ignore[misc,valid-type]
    """Sendable aiortc audio track fed by Nova Sonic output.

    recv() is wall-clock paced at 20 ms, emits monotonic pts (never reset, so
    audio stays in sync across silence gaps), and returns silence frames on
    underrun. Adding this track to the pc BEFORE createAnswer is what makes
    aiortc advertise sendrecv (so we no longer hand-munge recvonly->sendrecv)."""

    kind = "audio"

    def __init__(self, sample_rate: int = MODEL_OUTPUT_SAMPLE_RATE) -> None:
        super().__init__()
        self._rate = sample_rate
        self._samples_per_frame = int(sample_rate * _FRAME_MS)
        self._frame_bytes = self._samples_per_frame * _BYTES_PER_SAMPLE
        self._buffer = OutputBuffer()
        self._start: Optional[float] = None
        self._frames_sent = 0

    def queue_pcm(self, pcm: bytes) -> None:
        self._buffer.queue_pcm(pcm)

    def clear_buffer(self) -> None:
        self._buffer.clear()

    async def recv(self):  # pragma: no cover - requires aiortc/av + event loop
        import av  # lazy native import

        if self._start is None:
            self._start = time.time()
        # Pace to real time: frame N is due at start + N*20ms.
        target = self._start + self._frames_sent * _FRAME_MS
        delay = target - time.time()
        if delay > 0:
            await asyncio.sleep(delay)

        pcm = self._buffer.next_frame(self._frame_bytes)
        frame = av.AudioFrame(format="s16", layout="mono", samples=self._samples_per_frame)
        frame.planes[0].update(pcm)
        frame.sample_rate = self._rate
        frame.time_base = fractions.Fraction(1, self._rate)
        frame.pts = self._frames_sent * self._samples_per_frame
        self._frames_sent += 1
        return frame
