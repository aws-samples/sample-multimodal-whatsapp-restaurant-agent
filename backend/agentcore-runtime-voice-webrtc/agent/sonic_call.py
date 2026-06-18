"""Per-call Nova 2 Sonic orchestration for the WhatsApp Call Runtime (Task 16.4).

This is the telephony Sonic loop (telephony_agent.py) with the transport swapped
from the L16-websocket SIP bridge to aiortc WebRTC media tracks. The Nova Sonic
session itself - Strands BidiAgent + BidiNovaSonicModel, AgentCore Gateway MCP
tools, per-call system prompt, barge-in - is unchanged in behavior; only the
audio I/O is rewired:

  - inbound: an aiortc track pump (make_inbound_pump) reads decoded frames,
    resamples to 16 kHz mono PCM (transcode.InboundResampler), and feeds Nova
    Sonic via agent.send(BidiAudioInputEvent);
  - outbound: receive_pump drains agent.receive() and pushes Nova Sonic audio
    into a SonicOutputTrack (which paces it back onto the WebRTC track), clearing
    the track buffer on a BidiInterruptionEvent (barge-in);
  - keepalive: a 20 s silence sender keeps Nova Sonic's bidi stream alive across
    pauses / tool calls (Nova closes at ~55 s idle with error 532).

Strands is imported LAZILY inside each function (mirroring mcp_tools) so this
module - and `import handler` - load for unit tests without the SDK present; the
SDK only exists inside the container. Shared AgentCore Memory (read-at-start /
write-at-end) is intentionally NOT wired here yet - it is the immediate follow-up
task (see tasks.md 16.4).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Any, Callable, List, Tuple

import mcp_tools
import prompt_renderer
import system_prompt
from protocol import MODEL_CHANNELS, MODEL_INPUT_SAMPLE_RATE, MODEL_OUTPUT_SAMPLE_RATE
from session import Session
from transcode import InboundResampler

logger = logging.getLogger(__name__)

# 20 ms @ 16 kHz mono L16 = 320 samples = 640 bytes of zeros (one silence frame).
_SILENCE_FRAME = b"\x00" * (int(MODEL_INPUT_SAMPLE_RATE * 0.02) * MODEL_CHANNELS * 2)
_KEEPALIVE_INTERVAL_S = 20.0


def _discover_tools(customer_id: str) -> Tuple[Any, List[Any]]:
    """Open an MCPClient against AgentCore Gateway and return wrapped tools.

    Same contract as the telephony agent: basePath workaround applied, customerId
    stripped from input schemas (re-injected at invoke time by the hook). Caller
    owns the returned client and must close it."""
    from strands.tools.mcp.mcp_client import MCPClient  # lazy: container-only

    factory = mcp_tools.for_customer(customer_id)
    client = MCPClient(factory)
    client.__enter__()
    raw = client.list_tools_sync()
    mcp_tools.apply_basepath_workaround(raw)
    tools = mcp_tools.strip_customer_id_from_schemas(raw)
    logger.info("mcp tools discovered for call", extra={"count": len(tools)})
    return client, tools


async def build_agent(session: Session, voice_id: str = "tiffany") -> Tuple[Any, Any]:
    """Build + start a Nova 2 Sonic BidiAgent for one call.

    Resolves the per-call system prompt, constructs the model at 16 kHz in/out,
    discovers AgentCore Gateway MCP tools, starts the agent, and primes it with
    "Hi" so Nova Sonic greets first. Returns (mcp_client, agent); the caller owns
    the MCPClient and must close it on teardown."""
    from strands.experimental.bidi.agent import BidiAgent  # lazy: container-only
    from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel

    renderer_task = asyncio.create_task(
        prompt_renderer.fetch(session.raw_from, session.customer_id),
        name=f"renderer-{session.call_id or session.customer_id}",
    )

    model = BidiNovaSonicModel(
        model_id=os.environ.get("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        provider_config={
            "audio": {
                "input_rate": MODEL_INPUT_SAMPLE_RATE,
                "output_rate": MODEL_OUTPUT_SAMPLE_RATE,
                "channels": MODEL_CHANNELS,
                "voice": voice_id,
            },
            "turn_detection": {"endpointingSensitivity": "MEDIUM"},
        },
    )

    mcp_client, tools = _discover_tools(session.customer_id)

    try:
        rendered = await renderer_task
        resolved_prompt = rendered.system_prompt
        session.customer_name = rendered.customer_name
        session.is_loyalty = rendered.is_loyalty
    except Exception as exc:  # noqa: BLE001 - fall back to the baked template
        logger.warning(
            "prompt-renderer failed; using local template", extra={"err": str(exc)}
        )
        resolved_prompt = system_prompt.build(session)

    agent = BidiAgent(
        model=model,
        tools=tools,
        system_prompt=resolved_prompt,
        hooks=[mcp_tools.customer_id_hook(session.customer_id)],
    )
    await agent.start()
    await agent.send("Hi")  # Nova Sonic greets first (system-prompt greeting).
    logger.info("call bidi agent started + primed", extra={"call_id": session.call_id})
    return mcp_client, agent


def make_inbound_pump(agent: Any) -> Callable[[Any], Any]:
    """Return an aiortc ``on('track')`` handler that pumps caller audio to Sonic.

    Resamples each inbound frame to 16 kHz mono PCM and forwards it as a
    BidiAudioInputEvent. Runs until the track ends (pc closed)."""
    resampler = InboundResampler()

    async def on_track(track: Any) -> None:
        from strands.experimental.bidi.types.events import BidiAudioInputEvent  # lazy

        logger.info("inbound media track started kind=%s", getattr(track, "kind", "?"))
        try:
            while True:
                frame = await track.recv()
                for pcm in resampler.frame_to_pcm(frame):
                    if not pcm:
                        continue
                    await agent.send(
                        BidiAudioInputEvent(
                            audio=base64.b64encode(pcm).decode("ascii"),
                            format="pcm",
                            sample_rate=MODEL_INPUT_SAMPLE_RATE,
                            channels=MODEL_CHANNELS,
                        )
                    )
        except Exception as exc:  # noqa: BLE001 - track ended / pc closed
            logger.info("inbound pump ended: %s", exc)

    return on_track


async def receive_pump(agent: Any, output_track: Any, session: Session) -> None:
    """Drain agent.receive(): Sonic audio -> output track; barge-in -> clear.

    Never raises - logs and returns on close/error so handler teardown runs."""
    from strands.experimental.bidi.types.events import (  # lazy: container-only
        BidiAudioStreamEvent,
        BidiConnectionCloseEvent,
        BidiErrorEvent,
        BidiInterruptionEvent,
        BidiResponseCompleteEvent,
        BidiTranscriptStreamEvent,
    )
    from strands.types._events import ToolUseStreamEvent

    try:
        async for event in agent.receive():
            if isinstance(event, BidiAudioStreamEvent):
                try:
                    output_track.queue_pcm(base64.b64decode(event.audio))
                except Exception:  # noqa: BLE001
                    logger.debug("bad audio chunk from agent (ignored)")
            elif isinstance(event, BidiInterruptionEvent):
                # Barge-in: drop queued agent speech so the caller is heard now.
                output_track.clear_buffer()
                logger.info(
                    "agent interrupted (barge-in)",
                    extra={
                        "call_id": session.call_id,
                        "reason": getattr(event, "reason", None),
                    },
                )
            elif isinstance(event, BidiTranscriptStreamEvent):
                if getattr(event, "is_final", False):
                    logger.info(
                        "transcript",
                        extra={
                            "call_id": session.call_id,
                            "role": getattr(event, "role", "?"),
                            "text": (getattr(event, "text", "") or "")[:200],
                        },
                    )
            elif isinstance(event, ToolUseStreamEvent):
                logger.info("tool use", extra={"call_id": session.call_id})
            elif isinstance(event, BidiResponseCompleteEvent):
                logger.debug("response complete", extra={"call_id": session.call_id})
            elif isinstance(event, BidiErrorEvent):
                logger.warning(
                    "agent error event",
                    extra={
                        "call_id": session.call_id,
                        "err": str(getattr(event, "error", event)),
                    },
                )
            elif isinstance(event, BidiConnectionCloseEvent):
                logger.info("agent connection closed", extra={"call_id": session.call_id})
                return
    except Exception as exc:  # noqa: BLE001
        logger.info("receive pump ended: %s", exc)


async def keepalive_loop(agent: Any, interval_s: float = _KEEPALIVE_INTERVAL_S) -> None:
    """Send a 20 ms silence frame every ``interval_s`` to keep the bidi stream
    alive (Nova Sonic closes at ~55 s idle with error 532). Exits on cancel."""
    from strands.experimental.bidi.types.events import BidiAudioInputEvent  # lazy

    silence_b64 = base64.b64encode(_SILENCE_FRAME).decode("ascii")
    try:
        while True:
            await asyncio.sleep(interval_s)
            await agent.send(
                BidiAudioInputEvent(
                    audio=silence_b64,
                    format="pcm",
                    sample_rate=MODEL_INPUT_SAMPLE_RATE,
                    channels=MODEL_CHANNELS,
                )
            )
    except asyncio.CancelledError:  # pragma: no cover
        return
    except Exception as exc:  # noqa: BLE001
        logger.info("keepalive ended: %s", exc)
