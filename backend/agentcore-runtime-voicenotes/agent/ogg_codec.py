"""Ogg Opus <-> linear PCM transcode for the VoiceNotes Runtime (Task 12.2).

WhatsApp voice notes are delivered as Ogg-contained Opus. Amazon Nova 2 Sonic
consumes 16 kHz / 16-bit / mono linear PCM and emits 24 kHz / 16-bit / mono
linear PCM. This module bridges the two with PyAV (libopus + libswresample):

  - ``decode_ogg_opus_to_pcm(ogg_bytes)`` -> 16 kHz/16-bit/mono PCM (R7.4 in).
  - ``encode_pcm_to_ogg_opus(pcm_bytes)`` -> Ogg Opus bytes (R7.4 out).

Design notes
------------
* PyAV (``av``) is imported LAZILY inside each transcode function so this module
  imports cleanly where ``av`` is absent (a partial dev checkout, the Docker
  import smoke test). The pure helpers and input validation below are fully
  unit-testable without ``av``; the libopus decode/encode path is exercised by
  the container build smoke + the Task 12.8 integration test.
* Opus runs natively at 48 kHz internally and accepts only a fixed set of frame
  durations (2.5/5/10/20/40/60 ms). On encode we resample the 24 kHz PCM up to
  48 kHz and feed the encoder fixed 20 ms (960-sample) frames via an
  ``av.AudioFifo``, padding the trailing partial frame with silence so libopus
  never sees a short frame.
* No phone number or customer content is logged here; this is a pure media path.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Audio constants (pure - no av dependency).
# ---------------------------------------------------------------------------
PCM_SAMPLE_WIDTH = 2          # 16-bit signed little-endian
INBOUND_PCM_RATE = 16000      # Nova Sonic input rate (R7.4)
OUTBOUND_PCM_RATE = 24000     # Nova Sonic output rate (R7.4)
OPUS_RATE = 48000             # Opus native internal rate
OPUS_FRAME_MS = 20            # encoder frame duration we feed
OPUS_FRAME_SAMPLES = OPUS_RATE * OPUS_FRAME_MS // 1000  # 960 samples @ 48 kHz


class OggCodecError(Exception):
    """Base class for transcode failures (decode or encode)."""


class OggDecodeError(OggCodecError):
    """Raised when inbound Ogg Opus cannot be decoded to PCM."""


class OggEncodeError(OggCodecError):
    """Raised when outbound PCM cannot be encoded to Ogg Opus."""


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without av).
# ---------------------------------------------------------------------------
def pcm_num_samples(pcm: bytes) -> int:
    """Number of 16-bit mono samples in a PCM buffer (floor on a trailing odd byte)."""
    return len(pcm) // PCM_SAMPLE_WIDTH


def pcm_duration_seconds(pcm: bytes, rate: int) -> float:
    """Duration in seconds of a 16-bit mono PCM buffer at ``rate`` Hz."""
    if rate <= 0:
        raise ValueError("rate must be positive")
    return pcm_num_samples(pcm) / rate


def pad_pcm_to_frame(pcm: bytes, frame_samples: int = OPUS_FRAME_SAMPLES) -> bytes:
    """Zero-pad a 16-bit mono PCM buffer up to a whole multiple of ``frame_samples``.

    Pure and deterministic: silence (0x00) is appended so the trailing Opus
    frame is exactly ``frame_samples`` long. A buffer already aligned is
    returned unchanged. ``frame_samples`` must be positive."""
    if frame_samples <= 0:
        raise ValueError("frame_samples must be positive")
    n = pcm_num_samples(pcm)
    remainder = n % frame_samples
    if remainder == 0:
        return pcm
    pad_samples = frame_samples - remainder
    return pcm + (b"\x00" * (pad_samples * PCM_SAMPLE_WIDTH))


# ---------------------------------------------------------------------------
# PyAV-backed transcode (lazy import).
# ---------------------------------------------------------------------------
def decode_ogg_opus_to_pcm(ogg_bytes: bytes, target_rate: int = INBOUND_PCM_RATE) -> bytes:
    """Decode Ogg Opus container bytes to 16-bit/mono PCM at ``target_rate``.

    Returns the raw little-endian PCM byte string. Raises ``OggDecodeError`` on
    empty input or any decode failure (the caller maps this to the
    could-not-understand fallback, R7.6)."""
    if not ogg_bytes:
        raise OggDecodeError("empty inbound audio")

    import io

    try:
        import av
        from av.audio.resampler import AudioResampler
    except ImportError as exc:  # pragma: no cover - av always present in the image
        raise OggDecodeError(f"PyAV not available: {exc}") from exc

    try:
        container = av.open(io.BytesIO(ogg_bytes), mode="r")
    except Exception as exc:  # noqa: BLE001
        raise OggDecodeError(f"could not open Ogg container: {exc}") from exc

    resampler = AudioResampler(format="s16", layout="mono", rate=target_rate)
    chunks: list[bytes] = []
    try:
        for frame in container.decode(audio=0):
            for rframe in resampler.resample(frame):
                chunks.append(_frame_pcm_bytes(rframe))
        # Flush any samples buffered inside the resampler.
        for rframe in resampler.resample(None):
            chunks.append(_frame_pcm_bytes(rframe))
    except Exception as exc:  # noqa: BLE001
        raise OggDecodeError(f"decode failed: {exc}") from exc
    finally:
        container.close()

    pcm = b"".join(chunks)
    if not pcm:
        raise OggDecodeError("no audio samples decoded")
    return pcm


def encode_pcm_to_ogg_opus(pcm_bytes: bytes, source_rate: int = OUTBOUND_PCM_RATE) -> bytes:
    """Encode 16-bit/mono PCM at ``source_rate`` to Ogg Opus container bytes.

    The PCM is resampled to 48 kHz and fed to libopus in fixed 20 ms frames
    (the trailing partial frame padded with silence). Raises ``OggEncodeError``
    on empty input or any encode failure."""
    if not pcm_bytes:
        raise OggEncodeError("empty PCM to encode")

    import io

    try:
        import av
        from av import AudioFrame
        from av.audio.resampler import AudioResampler
    except ImportError as exc:  # pragma: no cover - av always present in the image
        raise OggEncodeError(f"PyAV not available: {exc}") from exc

    out_buf = io.BytesIO()
    try:
        output = av.open(out_buf, mode="w", format="ogg")
        stream = output.add_stream("libopus", rate=OPUS_RATE)
        stream.layout = "mono"

        # Build a single source frame from the raw PCM at its native rate.
        src = AudioFrame(format="s16", layout="mono", samples=pcm_num_samples(pcm_bytes))
        src.sample_rate = source_rate
        src.planes[0].update(pcm_bytes)

        # Resample to Opus' native 48 kHz, buffer in a FIFO, then emit fixed
        # 20 ms frames so libopus never receives a short frame.
        resampler = AudioResampler(format="s16", layout="mono", rate=OPUS_RATE)
        fifo = av.AudioFifo()
        for rframe in resampler.resample(src):
            fifo.write(rframe)
        for rframe in resampler.resample(None):
            fifo.write(rframe)

        while True:
            chunk = fifo.read(OPUS_FRAME_SAMPLES)
            if chunk is None:
                break
            for packet in stream.encode(chunk):
                output.mux(packet)

        # Trailing partial frame: pad to a full Opus frame with silence.
        tail = fifo.read()  # remaining samples, if any
        if tail is not None:
            tail_pcm = pad_pcm_to_frame(_frame_pcm_bytes(tail), OPUS_FRAME_SAMPLES)
            pad_frame = AudioFrame(
                format="s16", layout="mono", samples=pcm_num_samples(tail_pcm)
            )
            pad_frame.sample_rate = OPUS_RATE
            pad_frame.planes[0].update(tail_pcm)
            for packet in stream.encode(pad_frame):
                output.mux(packet)

        # Flush the encoder.
        for packet in stream.encode(None):
            output.mux(packet)
        output.close()
    except Exception as exc:  # noqa: BLE001
        raise OggEncodeError(f"encode failed: {exc}") from exc

    data = out_buf.getvalue()
    if not data:
        raise OggEncodeError("encoder produced no output")
    return data


def _frame_pcm_bytes(frame) -> bytes:
    """Extract the exact little-endian PCM bytes from a packed s16 mono frame.

    ``frame.planes[0]`` is buffer-aligned and may be larger than the real audio;
    slice to ``samples * channels * width`` so no padding bytes leak through.
    Mono s16 -> samples * 2."""
    width = PCM_SAMPLE_WIDTH
    channels = 1
    real_len = frame.samples * channels * width
    return bytes(frame.planes[0])[:real_len]
