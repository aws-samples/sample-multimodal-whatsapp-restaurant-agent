"""Bounded Nova 2 Sonic speech-to-speech session for one voice note (Task 12.3).

A WhatsApp voice note is a SINGLE, self-contained utterance, not a live call. So
unlike the telephony Call agent (a continuous duplex stream over a WebSocket),
this runtime runs a SHORT, BOUNDED session per note:

  1. read the customer's long-term insights from the shared AgentCore Memory,
  2. open a Nova 2 Sonic bidirectional session (16 kHz PCM in, 24 kHz PCM out)
     with the gateway-only MCP tools and the memory-seeded system prompt,
  3. feed the note's PCM, then a short trailing silence so Nova Sonic endpoints
     the user's turn and responds,
  4. collect the spoken response audio (and transcripts) until the response
     completes or a hard timeout fires,
  5. close the session and write the two conversation turns back to shared
     memory.

The Sonic event protocol, the gateway-only MCP wiring, and the customer-id
isolation hook are PORTED from the telephony agent unchanged in behavior; only
the session lifecycle differs (bounded one-shot vs continuous).

``strands`` and ``boto3`` are imported lazily inside the async entrypoint so this
module imports cleanly in a test/lint environment without the bidi extra. The
pure framing/aggregation helpers below are fully unit-testable without strands;
the live Sonic round-trip is validated by the container build smoke and the
Task 12.8 integration test.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from dataclasses import dataclass, field
from typing import Iterator, Optional

import mcp_tools
from memory_client import ENV_MEMORY_ID, SharedMemoryClient, Turn
from system_prompt import render_system_prompt

logger = logging.getLogger(__name__)


def _resolve_memory_id() -> str:
    """Resolve the bare AgentCore Memory id for the shared memory client.

    Prefers ``WA_MEMORY_ID`` (the bare id the canonical client reads). Falls back
    to parsing it out of ``SHARED_MEMORY_ARN`` (``arn:...:memory/<id>``) because
    the VoiceNotes stack currently threads only the ARN. Returns "" when neither
    is set (the memory client then degrades to a no-op). Mirrors the Chat and
    Call runtimes so the same customer recalls across all three channels."""
    memory_id = os.environ.get(ENV_MEMORY_ID, "").strip()
    if memory_id:
        return memory_id
    arn = os.environ.get("SHARED_MEMORY_ARN", "").strip()
    if arn and "/" in arn:
        return arn.rsplit("/", 1)[-1]
    return ""

# Audio shape (R7.4): Nova Sonic input is 16 kHz, output is 24 kHz, both 16-bit
# mono linear PCM. The ogg_codec decode produces 16 kHz; its encode consumes
# 24 kHz, matching these rates end to end.
VN_INPUT_SAMPLE_RATE = 16000
VN_OUTPUT_SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2

# 20 ms input frames: 2 bytes * 16000 * 20/1000 = 640 bytes.
INPUT_FRAME_MS = 20
INPUT_FRAME_BYTES = SAMPLE_WIDTH * VN_INPUT_SAMPLE_RATE * INPUT_FRAME_MS // 1000

# After the note's audio we feed paced silence so Nova Sonic's endpointing
# detects end-of-turn and the model starts responding. With real-time pacing
# (one frame per 20 ms) the server sees a genuine trailing pause; 1.5 s is
# comfortably above the MEDIUM endpointing threshold.
DEFAULT_TRAILING_SILENCE_MS = 1500

# Hard upper bound on the whole turn. With manual contentEnd + audio-idle
# detection the turn normally ends ~1-2 s after the model stops speaking; this
# cap only fires when the model produces no audio at all (error path).
DEFAULT_TURN_TIMEOUT_S = 45.0

# End-of-response detection: Nova Sonic does NOT emit a per-turn completion event
# mid-session (BidiResponseCompleteEvent only arrives at prompt teardown), so we
# treat the turn as done once audio output has started and then no new audio
# chunk has arrived for this long. This is what makes a reply land in a few
# seconds instead of waiting out the full DEFAULT_TURN_TIMEOUT_S.
RESPONSE_QUIET_WINDOW_MS = 1200

_MODEL_ID_DEFAULT = "amazon.nova-2-sonic-v1:0"
_VOICE_DEFAULT = "matthew"


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without strands).
# ---------------------------------------------------------------------------
def pcm_is_usable(pcm: bytes) -> bool:
    """True iff the PCM buffer holds at least one whole 16-bit sample."""
    return bool(pcm) and len(pcm) >= SAMPLE_WIDTH


def iter_audio_frames(pcm: bytes, frame_bytes: int = INPUT_FRAME_BYTES) -> Iterator[bytes]:
    """Yield fixed-size PCM frames, zero-padding the trailing partial frame.

    Pure and deterministic: every yielded frame is exactly ``frame_bytes`` long
    (the last one padded with silence), so the producer can stream uniform
    frames into the bidi session. An empty buffer yields nothing."""
    if frame_bytes <= 0:
        raise ValueError("frame_bytes must be positive")
    for off in range(0, len(pcm), frame_bytes):
        frame = pcm[off : off + frame_bytes]
        if len(frame) < frame_bytes:
            frame = frame + (b"\x00" * (frame_bytes - len(frame)))
        yield frame


def silence_frame(frame_bytes: int = INPUT_FRAME_BYTES) -> bytes:
    """A single all-zero (silence) PCM frame of ``frame_bytes`` bytes."""
    return b"\x00" * frame_bytes


def num_silence_frames(ms: int, frame_ms: int = INPUT_FRAME_MS) -> int:
    """Number of ``frame_ms`` frames needed to cover ``ms`` of silence."""
    if frame_ms <= 0:
        raise ValueError("frame_ms must be positive")
    if ms <= 0:
        return 0
    return (ms + frame_ms - 1) // frame_ms  # ceil


class OutputAudioCollector:
    """Accumulate Nova Sonic's base64 audio chunks into one PCM buffer.

    The model emits many small ``BidiAudioStreamEvent``s while speaking; we
    decode and concatenate them so the handler can encode one Ogg Opus reply.
    Pure (no strands): ``feed`` takes the base64 string off the event."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, b64_audio: str) -> None:
        if b64_audio:
            self._buf.extend(base64.b64decode(b64_audio))

    def pcm(self) -> bytes:
        return bytes(self._buf)

    def __len__(self) -> int:  # number of bytes collected
        return len(self._buf)


@dataclass
class BoundedResult:
    """Outcome of one bounded voice-note session.

    ``output_pcm`` is 24 kHz/16-bit/mono PCM (empty when the model produced no
    usable audio -> the handler sends the could-not-understand text fallback,
    R7.6). ``ok`` is False only on a session-level failure (the handler still
    falls back gracefully)."""

    output_pcm: bytes = b""
    user_transcript: str = ""
    assistant_transcript: str = ""
    ok: bool = True
    error: Optional[str] = None

    @property
    def has_audio(self) -> bool:
        return pcm_is_usable(self.output_pcm)


# ---------------------------------------------------------------------------
# Bounded session (strands-backed; lazy imports).
# ---------------------------------------------------------------------------
async def run_bounded_session(
    customer_id: str,
    input_pcm_16k: bytes,
    *,
    memory: Optional[SharedMemoryClient] = None,
    model_id: str = _MODEL_ID_DEFAULT,
    voice: str = _VOICE_DEFAULT,
    trailing_silence_ms: int = DEFAULT_TRAILING_SILENCE_MS,
    turn_timeout_s: float = DEFAULT_TURN_TIMEOUT_S,
    region: Optional[str] = None,
) -> BoundedResult:
    """Run one bounded Nova 2 Sonic speech-to-speech turn for a voice note.

    Reads shared memory at session start, feeds ``input_pcm_16k`` (16 kHz PCM)
    to Nova Sonic, collects the spoken response (24 kHz PCM), writes the two
    turns back to shared memory, and returns a ``BoundedResult``. Never raises:
    any failure is captured on the result so the handler can fall back (R7.6)."""
    import os

    if not customer_id:
        return BoundedResult(ok=False, error="missing_customer_id")
    if not pcm_is_usable(input_pcm_16k):
        return BoundedResult(ok=False, error="empty_input_audio")

    region = region or os.environ.get("AWS_REGION", "us-east-1")
    memory = memory or SharedMemoryClient(memory_id=_resolve_memory_id())

    # --- session start: read shared long-term memory (graceful on failure) ---
    read = memory.read_long_term(customer_id)
    if not read.ok:
        logger.info("proceeding with no prior insights for %s (%s)", customer_id, read.error)
    system_prompt_text = render_system_prompt(read.insights)

    try:
        result = await _drive_sonic(
            customer_id=customer_id,
            input_pcm_16k=input_pcm_16k,
            system_prompt_text=system_prompt_text,
            model_id=model_id,
            voice=voice,
            trailing_silence_ms=trailing_silence_ms,
            turn_timeout_s=turn_timeout_s,
            region=region,
        )
    except Exception as exc:  # noqa: BLE001 - never hard-fail the customer
        logger.exception("bounded sonic session failed for %s", customer_id)
        result = BoundedResult(ok=False, error=str(exc))

    # --- session end: write the turns to shared memory (graceful on failure) ---
    memory.write_events(
        customer_id,
        customer_id,  # session_id == customer_id (R5.1)
        [
            Turn(role="USER", text=result.user_transcript or "[voice note]"),
            Turn(role="ASSISTANT", text=result.assistant_transcript or ""),
        ],
    )
    return result


async def _drive_sonic(
    *,
    customer_id: str,
    input_pcm_16k: bytes,
    system_prompt_text: str,
    model_id: str,
    voice: str,
    trailing_silence_ms: int,
    turn_timeout_s: float,
    region: str,
) -> BoundedResult:
    """The strands-backed core: open the bidi session, feed audio, collect the
    response. All strands imports are local so the module imports without the
    bidi extra installed."""
    from strands.experimental.bidi.agent import BidiAgent
    from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
    from strands.experimental.bidi.types.events import (
        BidiAudioInputEvent,
        BidiAudioStreamEvent,
        BidiConnectionCloseEvent,
        BidiErrorEvent,
        BidiResponseCompleteEvent,
        BidiTranscriptStreamEvent,
    )
    from strands.tools.mcp.mcp_client import MCPClient

    # NO turn_detection: a voice note is a single, COMPLETE utterance, so we run
    # Nova Sonic in MANUAL turn mode and end the user's turn explicitly with a
    # contentEnd once the clip is fully fed (see below). Server-side VAD
    # (turnDetectionConfiguration) is for a continuous live stream (the telephony
    # Call agent) where the model must guess end-of-turn from pauses; for a bounded
    # clip + synthetic trailing silence that VAD never endpoints, so the model
    # would wait forever and emit only BidiConnectionStartEvent. Manual contentEnd
    # is the canonical bounded flow: contentStart(AUDIO) -> audioInput -> contentEnd
    # -> response.
    model = BidiNovaSonicModel(
        model_id=model_id,
        region=region,
        provider_config={
            "audio": {
                "input_rate": VN_INPUT_SAMPLE_RATE,
                "output_rate": VN_OUTPUT_SAMPLE_RATE,
                "channels": CHANNELS,
                "voice": voice,
            },
        },
    )

    collector = OutputAudioCollector()
    user_parts: list[str] = []
    assistant_parts: list[str] = []
    done = asyncio.Event()
    # Diagnostics: count every event TYPE the model emits, so we can see whether
    # the classes we match (BidiAudioStreamEvent / BidiResponseCompleteEvent)
    # actually arrive, or whether strands emits different ones.
    from collections import Counter

    event_counts: Counter = Counter()
    completion_reason = "none"
    # Wall-clock (event-loop) time of the most recent audio-output chunk; used by
    # the audio-idle end-of-response detector below. None until the first chunk.
    last_audio_ts: Optional[float] = None

    logger.info(
        "vn session start cid=%s input_pcm_bytes=%d (~%.2fs @16k) trailing_silence_ms=%d timeout=%ss",
        customer_id,
        len(input_pcm_16k),
        len(input_pcm_16k) / (VN_INPUT_SAMPLE_RATE * SAMPLE_WIDTH),
        trailing_silence_ms,
        turn_timeout_s,
    )
    print(
        f"[vn] session start cid={customer_id} input_pcm_bytes={len(input_pcm_16k)} "
        f"(~{len(input_pcm_16k) / (VN_INPUT_SAMPLE_RATE * SAMPLE_WIDTH):.2f}s @16k) "
        f"trailing_silence_ms={trailing_silence_ms} timeout={turn_timeout_s}s",
        flush=True,
    )

    client = MCPClient(mcp_tools.for_customer(customer_id))
    client.__enter__()  # sync context; closed in finally
    try:
        tools = client.list_tools_sync()
        tools = mcp_tools.apply_basepath_workaround(tools)
        tools = mcp_tools.strip_customer_id_from_schemas(tools)
        logger.info("vn tools discovered cid=%s count=%d", customer_id, len(tools))
        print(f"[vn] tools discovered cid={customer_id} count={len(tools)}", flush=True)

        agent = BidiAgent(
            model=model,
            tools=tools,
            system_prompt=system_prompt_text,
            hooks=[mcp_tools.customer_id_hook(customer_id)],
        )
        await agent.start()
        logger.info("vn agent started cid=%s", customer_id)
        print(f"[vn] agent started cid={customer_id}", flush=True)

        async def _consume() -> None:
            nonlocal completion_reason, last_audio_ts
            try:
                async for event in agent.receive():
                    tname = type(event).__name__
                    event_counts[tname] += 1
                    # Log the first occurrence of each event type so we can see the
                    # actual event vocabulary without flooding the log.
                    if event_counts[tname] == 1:
                        logger.info("vn first event type=%s cid=%s", tname, customer_id)
                        print(f"[vn] first event type={tname} cid={customer_id}", flush=True)
                    if isinstance(event, BidiAudioStreamEvent):
                        collector.feed(event.audio)
                        last_audio_ts = asyncio.get_event_loop().time()
                    elif isinstance(event, BidiTranscriptStreamEvent):
                        if getattr(event, "is_final", False):
                            role = str(getattr(event, "role", "")).lower()
                            text = getattr(event, "text", "") or ""
                            logger.info("vn transcript role=%s len=%d cid=%s", role, len(text), customer_id)
                            if role == "assistant":
                                assistant_parts.append(text)
                            else:
                                user_parts.append(text)
                    elif isinstance(event, BidiResponseCompleteEvent):
                        completion_reason = "response_complete"
                        done.set()
                        return
                    elif isinstance(event, (BidiErrorEvent, BidiConnectionCloseEvent)):
                        completion_reason = tname
                        logger.warning("vn terminal event=%s cid=%s detail=%s", tname, customer_id, getattr(event, "error", getattr(event, "reason", "")))
                        done.set()
                        return
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - DIAGNOSTIC: surface, don't swallow
                # The strands loop re-raises a Nova-side ValidationException here
                # WITHOUT logging it; previously our outer teardown swallowed it,
                # so a hard model error looked identical to silence. Log it loudly
                # and end the wait so we stop masking it behind the 45s timeout.
                completion_reason = f"consumer_error:{type(exc).__name__}"
                logger.exception("vn consumer error cid=%s", customer_id)
                print(f"[vn] consumer error cid={customer_id}: {exc!r}", flush=True)
                done.set()

        consumer = asyncio.create_task(_consume(), name=f"vn-consume-{customer_id}")

        # Producer: feed the note's audio as fast as the stream accepts it (NO
        # real-time pacing) and NO trailing silence. In MANUAL turn mode the model
        # buffers the audio content and only infers on contentEnd, so the pacing
        # and trailing-silence we needed for the VAD era just add latency now.
        frames_fed = 0
        for frame in iter_audio_frames(input_pcm_16k, INPUT_FRAME_BYTES):
            await agent.send(
                BidiAudioInputEvent(
                    audio=base64.b64encode(frame).decode("ascii"),
                    format="pcm",
                    sample_rate=VN_INPUT_SAMPLE_RATE,
                    channels=CHANNELS,
                )
            )
            frames_fed += 1
        silence_fed = 0  # no trailing silence in manual-contentEnd mode
        logger.info("vn audio fed cid=%s note_frames=%d silence_frames=%d", customer_id, frames_fed, silence_fed)
        print(f"[vn] audio fed cid={customer_id} note_frames={frames_fed} silence_frames={silence_fed}", flush=True)

        # Close the user's audio turn so Nova Sonic stops listening and responds.
        # Nova Sonic only begins inference once the audio content block is closed
        # with contentEnd; the strands BidiAgent exposes no public end-of-input
        # event, so we close the model's audio block directly. Without this the
        # model waits indefinitely (only BidiConnectionStartEvent is emitted) and
        # the session times out with output_pcm_bytes=0. Private method, guarded -
        # strands is pinned to 1.37.0 (strands-agents[bidi]).
        end_audio = getattr(model, "_end_audio_input", None)
        if end_audio is not None:
            acn_set = bool(getattr(model, "_audio_content_name", None))
            logger.info("vn pre-contentEnd audio_content_open=%s cid=%s", acn_set, customer_id)
            print(f"[vn] pre-contentEnd audio_content_open={acn_set} cid={customer_id}", flush=True)
            try:
                await end_audio()
                logger.info("vn user turn closed (contentEnd) cid=%s", customer_id)
                print(f"[vn] user turn closed (contentEnd) cid={customer_id}", flush=True)
            except Exception:  # noqa: BLE001 - never hard-fail the customer
                logger.exception("vn failed to close audio turn cid=%s", customer_id)
        else:
            logger.warning("vn model has no _end_audio_input; cannot close turn cid=%s", customer_id)

        # Wait for the spoken response, then tear down. Nova Sonic does NOT emit
        # a per-turn completion event mid-session (BidiResponseCompleteEvent only
        # arrives at prompt teardown), so waiting for `done` alone always burned
        # the full timeout. Instead detect END-OF-RESPONSE by AUDIO IDLE: once
        # audio output has started and then no new chunk arrives for
        # RESPONSE_QUIET_WINDOW_MS, the turn is done. `done` still short-circuits
        # on a real completion/terminal/consumer-error event; the hard timeout is
        # the fallback when the model produces no audio at all.
        loop = asyncio.get_event_loop()
        deadline = loop.time() + turn_timeout_s
        quiet_window_s = RESPONSE_QUIET_WINDOW_MS / 1000.0
        try:
            while not done.is_set():
                now = loop.time()
                if now >= deadline:
                    completion_reason = "timeout"
                    logger.warning("bounded session timed out for %s after %ss", customer_id, turn_timeout_s)
                    break
                if last_audio_ts is not None and len(collector) > 0 and (now - last_audio_ts) >= quiet_window_s:
                    completion_reason = "audio_idle"
                    break
                await asyncio.sleep(0.1)
        finally:
            consumer.cancel()
            try:
                await consumer
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            try:
                await agent.stop()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
    finally:
        try:
            client.__exit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass

    logger.info(
        "vn session end cid=%s completion=%s output_pcm_bytes=%d events=%s",
        customer_id,
        completion_reason,
        len(collector),
        dict(event_counts),
    )
    print(
        f"[vn] session end cid={customer_id} completion={completion_reason} "
        f"output_pcm_bytes={len(collector)} events={dict(event_counts)}",
        flush=True,
    )

    return BoundedResult(
        output_pcm=collector.pcm(),
        user_transcript=" ".join(p for p in user_parts if p).strip(),
        assistant_transcript=" ".join(p for p in assistant_parts if p).strip(),
        ok=True,
    )
