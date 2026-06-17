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

import base64
import logging
import os

import bounded_sonic
import ogg_codec

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


async def run_voice_note_turn(payload: dict) -> dict:
    """Run one bounded voice-note turn end to end (Ogg in -> Ogg out).

    Returns a dict with either ``audio_b64`` (a spoken Ogg Opus reply) or
    ``fallback_text`` (the could-not-understand message, R7.6). Never raises:
    any failure degrades to the text fallback so the worker always has a reply."""
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

    # --- bounded Nova 2 Sonic speech-to-speech turn (reads/writes memory) ---
    result = await bounded_sonic.run_bounded_session(customer_id, input_pcm)
    if not result.has_audio:
        logger.info(
            "voice-note produced no usable audio for %s (ok=%s, err=%s)",
            customer_id, result.ok, result.error,
        )
        return {"fallback_text": COULD_NOT_UNDERSTAND}

    # --- encode the 24 kHz spoken reply back to Ogg Opus (R7.4 out) ---
    try:
        reply_ogg = ogg_codec.encode_pcm_to_ogg_opus(result.output_pcm)
    except ogg_codec.OggEncodeError as exc:
        logger.warning("voice-note reply encode failed for %s: %s", customer_id, exc)
        return {"fallback_text": COULD_NOT_UNDERSTAND}

    out = {"audio_b64": base64.b64encode(reply_ogg).decode("ascii")}
    if result.user_transcript:
        out["user_transcript"] = result.user_transcript
    if result.assistant_transcript:
        out["assistant_transcript"] = result.assistant_transcript
    return out


# --- AgentCore Runtime HTTP surface -----------------------------------------
try:
    from fastapi import FastAPI, Request

    app = FastAPI(title="whatsapp-voicenotes-runtime")

    @app.get("/ping")
    def ping() -> dict:
        """AgentCore Runtime health probe."""
        return {"status": "ok"}

    @app.post("/invocations")
    async def invocations(request: Request) -> dict:
        """AgentCore Runtime invocation endpoint: Ogg Opus in, Ogg Opus out."""
        payload = await request.json()
        try:
            return await run_voice_note_turn(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace
            logger.exception("voice-note turn failed")
            return {"error": "voice_note_turn_failed", "fallback_text": COULD_NOT_UNDERSTAND, "detail": str(exc)}

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "handler:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
