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
from dataclasses import dataclass, field
from typing import Iterator, Optional

import mcp_tools
from memory_client import SharedMemoryClient, Turn
from system_prompt import render_system_prompt

logger = logging.getLogger(__name__)

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

# After the note's audio we feed this much silence so Nova Sonic's endpointing
# detects end-of-turn and the model starts responding. The note itself has no
# natural trailing pause once the file ends.
DEFAULT_TRAILING_SILENCE_MS = 800

# Hard upper bound on how long we wait for the model's spoken response to
# complete before we stop and return whatever audio we collected. Keeps the
# bounded session bounded even if the model never emits a completion event.
DEFAULT_TURN_TIMEOUT_S = 30.0

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
    memory = memory or SharedMemoryClient()

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
            "turn_detection": {"endpointingSensitivity": "MEDIUM"},
        },
    )

    collector = OutputAudioCollector()
    user_parts: list[str] = []
    assistant_parts: list[str] = []
    done = asyncio.Event()

    client = MCPClient(mcp_tools.for_customer(customer_id))
    client.__enter__()  # sync context; closed in finally
    try:
        tools = client.list_tools_sync()
        tools = mcp_tools.apply_basepath_workaround(tools)
        tools = mcp_tools.strip_customer_id_from_schemas(tools)

        agent = BidiAgent(
            model=model,
            tools=tools,
            system_prompt=system_prompt_text,
            hooks=[mcp_tools.customer_id_hook(customer_id)],
        )
        await agent.start()

        async def _consume() -> None:
            async for event in agent.receive():
                if isinstance(event, BidiAudioStreamEvent):
                    collector.feed(event.audio)
                elif isinstance(event, BidiTranscriptStreamEvent):
                    if getattr(event, "is_final", False):
                        role = str(getattr(event, "role", "")).lower()
                        text = getattr(event, "text", "") or ""
                        if role == "assistant":
                            assistant_parts.append(text)
                        else:
                            user_parts.append(text)
                elif isinstance(event, BidiResponseCompleteEvent):
                    done.set()
                    return
                elif isinstance(event, (BidiErrorEvent, BidiConnectionCloseEvent)):
                    done.set()
                    return

        consumer = asyncio.create_task(_consume(), name=f"vn-consume-{customer_id}")

        # Producer: feed the note's audio, then trailing silence to endpoint.
        for frame in iter_audio_frames(input_pcm_16k, INPUT_FRAME_BYTES):
            await agent.send(
                BidiAudioInputEvent(
                    audio=base64.b64encode(frame).decode("ascii"),
                    format="pcm",
                    sample_rate=VN_INPUT_SAMPLE_RATE,
                    channels=CHANNELS,
                )
            )
        sil = base64.b64encode(silence_frame(INPUT_FRAME_BYTES)).decode("ascii")
        for _ in range(num_silence_frames(trailing_silence_ms, INPUT_FRAME_MS)):
            await agent.send(
                BidiAudioInputEvent(
                    audio=sil,
                    format="pcm",
                    sample_rate=VN_INPUT_SAMPLE_RATE,
                    channels=CHANNELS,
                )
            )

        # Wait (bounded) for the response to complete, then tear down.
        try:
            await asyncio.wait_for(done.wait(), timeout=turn_timeout_s)
        except asyncio.TimeoutError:
            logger.warning("bounded session timed out for %s after %ss", customer_id, turn_timeout_s)
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

    return BoundedResult(
        output_pcm=collector.pcm(),
        user_transcript=" ".join(p for p in user_parts if p).strip(),
        assistant_transcript=" ".join(p for p in assistant_parts if p).strip(),
        ok=True,
    )
