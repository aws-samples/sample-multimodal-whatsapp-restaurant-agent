"""WhatsApp VoiceNotes Runtime - invoke entrypoint (PLACEHOLDER for Task 12.1).

This is a minimal FastAPI surface so the CDK stack (Task 12.1) has a coherent
container build context and the Docker import smoke test passes. The real
implementation lands in:

  - Task 12.2  agent/ogg_codec.py     (Ogg Opus <-> 16/24 kHz PCM)
  - Task 12.3  agent/bounded_sonic.py (bounded Nova 2 Sonic speech-to-speech)
  - Task 12.4  agent/handler.py        (this file: wire codec + bounded_sonic,
                                        Ogg Opus bytes + session_id in, Ogg Opus
                                        bytes out)

Invoke contract (the webhook worker - Task 12.5 - builds this payload):

    POST /invocations
    {
      "session_id":  "wa-1f0c3a9b2e4d6f80",   # == customer_id (R5.1)
      "customer_id": "wa-1f0c3a9b2e4d6f80",
      "audio_b64":   "<base64 Ogg Opus bytes>"
    }

    200 -> { "audio_b64": "<base64 Ogg Opus reply>" }   # voice-in / voice-out
        or { "error": "...", "fallback_text": "..." }   # no usable audio (R7.6)

Heavy deps (fastapi) are guarded so a bare `python -c "import handler"` smoke
test in the Docker build works even before the web framework is installed.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def run_voice_note_turn(payload: dict) -> dict:
    """PLACEHOLDER (Task 12.4). Returns a not-implemented marker for now."""
    customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
    if not customer_id:
        return {"error": "missing_customer_id"}
    return {
        "error": "not_implemented",
        "fallback_text": "Voice notes are not available yet.",
    }


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
        """AgentCore Runtime invocation endpoint (PLACEHOLDER until Task 12.4)."""
        payload = await request.json()
        try:
            return run_voice_note_turn(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace
            logger.exception("voice-note turn failed")
            return {"error": "voice_note_turn_failed", "detail": str(exc)}

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "handler:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
