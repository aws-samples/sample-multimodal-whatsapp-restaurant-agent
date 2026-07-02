"""WhatsApp VoiceNotes Runtime - invoke entrypoint (Task 12.4).

Wires the Ogg Opus codec (Task 12.2) and the bounded Nova 2 Sonic session
(Task 12.3) into the AgentCore Runtime request/response surface: Ogg Opus bytes
in, Ogg Opus bytes out (voice-in / voice-out, R7.3 / R7.4 / R7.5).

Invoke contract (the webhook worker - Task 12.5 - builds this payload):

    POST /invocations
    {
      "session_id":  "wa-1f0c3a9b2e4d6f80",   # == customer_id (R5.1)
      "customer_id": "wa-1f0c3a9b2e4d6f80",
      "audio_b64":   "<base64 Ogg Opus bytes>"
    }

    200 (voice reply) -> { "audio_b64": "<base64 Ogg Opus reply>",
                           "user_transcript": "...",
                           "assistant_transcript": "..." }

    200 (no usable audio, R7.6) -> { "fallback_text": "<could-not-understand>" }

When the bounded session yields no usable audio - the note could not be decoded,
the model produced nothing, or the session failed - the runtime returns a
``fallback_text`` (and no ``audio_b64``) so the worker sends the
could-not-understand TEXT message instead of a voice reply (R7.6). The path
never returns a text reply for a voice note that DID produce audio.

Heavy deps (fastapi, strands, av) are imported lazily / guarded so a bare
``python -c "import handler"`` smoke test in the Docker build works without them.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Awaitable, Callable, Optional

import async_dispatch
import bounded_sonic
import ogg_codec
import sender_client

# Configure root logging to INFO (force=True overrides uvicorn's handler config)
# so the bounded-Sonic diagnostics in bounded_sonic surface in the runtime log.
# Override with LOG_LEVEL=DEBUG/WARNING via the runtime env.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    force=True,
)
logger = logging.getLogger(__name__)

# Could-not-understand fallback text (R7.6). The worker sends this as a normal
# WhatsApp text message when no usable audio reply is produced.
COULD_NOT_UNDERSTAND = (
    "Sorry, I could not understand that voice note. Please try again, or send "
    "your order as a text message."
)


# --- Runtime-owned per-segment delivery (async-reply-delivery Move B / Step 2) -
# Each spoken SEGMENT is delivered as its own WhatsApp voice note (mirrors how
# the chat runtime sends each message separately): the model narrates ("let me
# check your cart"), calls a tool, then speaks the answer -> two notes. The
# synchronous Lambda invoke payload limit is 6 MB; base64 inflates raw audio by
# ~1/3, so ~4.5 MB of Ogg Opus fits per note. A segment that would exceed the
# limit degrades to a text note (R3.9) rather than failing the invoke.
MAX_AUDIO_B64_CHARS = 6_000_000


async def run_voice_note_turn(
    payload: dict,
    deliver_audio: Optional[Callable[[str], Awaitable[None]]] = None,
) -> dict:
    """Run one bounded voice-note turn. The Sonic session splits the reply into
    one or more speech SEGMENTS (narration before a tool, the answer after it);
    each 24 kHz PCM segment is encoded to Ogg Opus and handed to ``deliver_audio``
    (which sends it as its own voice note). Returns ``{"delivered": n}`` on
    success, or ``{"fallback_text": ...}`` when no usable audio was produced
    (R7.6). Never raises: failures degrade to the text fallback."""
    customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
    if not customer_id:
        return {"error": "missing_customer_id"}

    audio_b64 = payload.get("audio_b64") or ""
    if not audio_b64:
        return {"fallback_text": COULD_NOT_UNDERSTAND}

    # --- decode the inbound Ogg Opus voice note to 16 kHz PCM (R7.4 in) ---
    try:
        ogg_bytes = base64.b64decode(audio_b64, validate=True)
        input_pcm = ogg_codec.decode_ogg_opus_to_pcm(ogg_bytes)
    except (ValueError, ogg_codec.OggDecodeError) as exc:
        logger.info("voice-note decode failed for %s: %s", customer_id, exc)
        return {"fallback_text": COULD_NOT_UNDERSTAND}

    # Per-segment sink: encode one 24 kHz PCM segment to Ogg Opus (R7.4 out) and
    # deliver it. A single segment that fails to encode is skipped, not fatal.
    async def _on_segment(pcm: bytes) -> None:
        try:
            reply_ogg = ogg_codec.encode_pcm_to_ogg_opus(pcm)
        except ogg_codec.OggEncodeError as exc:
            logger.warning("voice segment encode failed for %s: %s", customer_id, exc)
            return
        b64 = base64.b64encode(reply_ogg).decode("ascii")
        if deliver_audio is not None:
            await deliver_audio(b64)

    result = await bounded_sonic.run_bounded_session(
        customer_id,
        input_pcm,
        on_segment=_on_segment if deliver_audio is not None else None,
    )
    if result.segments_delivered == 0:
        logger.info(
            "voice-note produced no usable audio for %s (ok=%s, err=%s)",
            customer_id, result.ok, result.error,
        )
        return {"fallback_text": COULD_NOT_UNDERSTAND}

    out: dict = {"delivered": result.segments_delivered}
    if result.user_transcript:
        out["user_transcript"] = result.user_transcript
    if result.assistant_transcript:
        out["assistant_transcript"] = result.assistant_transcript
    return out


async def _run_voice_turn_guarded(payload: dict) -> None:
    """Run one voice-note turn and DELIVER each segment out-of-band as its own
    voice note, owning reliability (R4): on no usable audio, send the
    could-not-understand text; on an unexpected failure, send it and record
    async_turn_failed, so no acknowledged message is left without a reply or a
    recorded failure."""
    customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
    if not customer_id:
        return
    async_dispatch.turn_started("voicenote", customer_id)

    async def deliver_audio(b64: str) -> None:
        if len(b64) > MAX_AUDIO_B64_CHARS:
            logger.warning(
                "[async] voice segment too large for %s (%d b64 chars > %d); sending text",
                customer_id, len(b64), MAX_AUDIO_B64_CHARS,
            )
            await asyncio.to_thread(sender_client.send_text, customer_id, COULD_NOT_UNDERSTAND, "voicenote")
            return
        await asyncio.to_thread(sender_client.send_audio, customer_id, b64, "voicenote")

    try:
        result = await run_voice_note_turn(payload, deliver_audio=deliver_audio)
        if result.get("fallback_text"):
            await asyncio.to_thread(
                sender_client.send_text, customer_id, result["fallback_text"], "voicenote"
            )
        async_dispatch.turn_completed("voicenote", customer_id)
    except Exception:  # noqa: BLE001 - never let a turn die silently
        async_dispatch.turn_failed("voicenote", customer_id)
        logger.exception("[async] voice-note turn failed for %s", customer_id)
        try:
            await asyncio.to_thread(
                sender_client.send_text, customer_id, COULD_NOT_UNDERSTAND, "voicenote"
            )
        except Exception:  # noqa: BLE001 - best-effort fallback notify
            logger.exception("failed to send the voice error fallback for %s", customer_id)


# --- AgentCore Runtime surface (asynchronous processing) --------------------
# async-reply-delivery Move A: acknowledge each invocation immediately and run
# the turn in the background (serialized per customer, Component 2a), so the
# webhook worker Lambda is never blocked for the Nova Sonic turn. The runtime
# OWNS delivery (Move B): it sends the audio reply via the Sender Lambda rather
# than returning it to the worker. bedrock_agentcore is import-guarded so the
# Docker smoke test / unit tests import this module without the SDK.
try:
    from bedrock_agentcore import BedrockAgentCoreApp

    app = BedrockAgentCoreApp()

    @app.entrypoint
    def invoke(payload: dict) -> dict:
        """AgentCore async entrypoint: ack immediately, run the voice-note turn
        in the background (serialized per customer) and deliver the reply
        out-of-band. The worker reads only the ack."""
        payload = payload or {}
        customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
        if not customer_id:
            return {"accepted": False, "error": "missing_customer_id"}
        message_id = (payload.get("message_id") or "").strip()
        return async_dispatch.dispatch_turn(
            app,
            "voicenote_turn",
            customer_id,
            lambda: async_dispatch.with_typing_refresh(
                lambda: _run_voice_turn_guarded(payload), message_id, sender_client.send_typing
            ),
        )

except ImportError:  # pragma: no cover - smoke-test path without the SDK
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    if app is None:
        raise SystemExit("bedrock_agentcore is not installed; cannot start the runtime")
    app.run()
