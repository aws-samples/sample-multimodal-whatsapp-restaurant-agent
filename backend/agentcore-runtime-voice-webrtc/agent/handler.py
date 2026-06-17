"""WhatsApp Call Runtime - invoke entrypoint (Task 15, Step 2a).

The Call Runtime is the WebRTC signaling surface for WhatsApp voice calls. It
runs aiortc INSIDE the AgentCore Runtime container, which is why the runtime
must be deployed in VPC network mode (PUBLIC mode blocks the outbound UDP that
WebRTC media needs). See:
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-webrtc.html

Step 2a scope: answer a Meta offer and prove media negotiates. There is NO Nova
2 Sonic on the media path yet - that arrives in Tasks 18/19. This handler:

  1. receives a Meta SDP offer (the webhook worker relays the `calls` connect
     event - Task 2c),
  2. fetches KVS managed TURN credentials (kvs_turn.get_ice_servers) - the
     container has no public IP, so the relay candidate is the only viable ICE
     path,
  3. builds a SINGLE-SHOT SDP answer with the relay candidate embedded
     (single_shot_answerer.create_single_shot_answer, turn_only=True) - Meta is
     ice-lite / single-shot and gives no trickle return channel,
  4. returns the answer SDP for the worker to POST back to Meta
     (pre_accept / accept).

Invoke contract (the webhook worker - Task 2c - builds this payload):

    POST /invocations
    {
      "action":       "answer",                 # only action in 2a
      "call_id":      "<meta call id>",          # opaque, echoed back
      "offer_sdp_b64":"<base64 Meta offer SDP>", # OR "offer_sdp" raw
      "offer_type":   "offer"                    # default "offer"
    }

    200 -> { "call_id": "...", "pc_id": "pc-...", "type": "answer",
             "answer_sdp": "<single-shot answer SDP>" }

    200 (error) -> { "error": "<code>", "call_id": "...", "detail": "..." }

In 2a the peer connection is CLOSED immediately after the answer is produced -
we are proving the answer is structurally valid and the TURN path resolves, not
holding media open. Holding the pc open and wiring audio to Sonic is Task 18.

aiortc + av are imported lazily (inside single_shot_answerer) so a bare
``python -c "import handler"`` smoke test in the Docker build works without the
native media deps, and the unit tests mock the answerer + TURN fetch entirely.
"""
from __future__ import annotations

import base64
import logging
import os

import kvs_turn
import single_shot_answerer

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    force=True,
)
logger = logging.getLogger(__name__)

# KVS signaling channel that mints the TURN credentials. One shared channel is
# fine: KVS uses it only as a credential source, not a media/signaling hop (see
# kvs_turn). Name is env-driven so the CDK (Task 2b) can pin it per deployment.
DEFAULT_CHANNEL = "wa-voice-call"


def _channel_name() -> str:
    """KVS channel name: KVS_CHANNEL_NAME, else <DEPLOYMENT_PREFIX>-voice-call,
    else the bare default. Keeps the channel namespaced per deployment."""
    explicit = os.environ.get("KVS_CHANNEL_NAME")
    if explicit:
        return explicit
    prefix = os.environ.get("DEPLOYMENT_PREFIX")
    return f"{prefix}-voice-call" if prefix else DEFAULT_CHANNEL


def _decode_offer(payload: dict) -> str:
    """Extract the raw offer SDP from the payload.

    Accepts either ``offer_sdp`` (raw SDP text) or ``offer_sdp_b64`` (base64,
    how the webhook worker relays it to keep the SDP single-line in JSON/logs).
    Raises ValueError if neither is present or the base64 is malformed."""
    raw = payload.get("offer_sdp")
    if raw:
        return raw
    b64 = payload.get("offer_sdp_b64")
    if b64:
        return base64.b64decode(b64, validate=True).decode("utf-8")
    raise ValueError("missing offer_sdp / offer_sdp_b64")


async def run_answer_turn(payload: dict) -> dict:
    """Produce a single-shot SDP answer for a Meta offer (Step 2a).

    Never raises: any failure degrades to an ``{"error": ...}`` dict so the
    worker can decide whether to reject the call. The peer connection is closed
    before returning (no media is held open in 2a)."""
    action = (payload.get("action") or "answer").strip()
    call_id = (payload.get("call_id") or "").strip()

    if action != "answer":
        return {"error": "unsupported_action", "call_id": call_id, "detail": action}

    try:
        offer_sdp = _decode_offer(payload)
    except (ValueError, base64.binascii.Error) as exc:
        logger.info("call %s: bad offer payload: %s", call_id or "?", exc)
        return {"error": "bad_offer", "call_id": call_id, "detail": str(exc)}

    offer_type = (payload.get("offer_type") or "offer").strip()

    # --- KVS managed TURN credentials (relay is the only viable candidate) ---
    try:
        ice_servers = kvs_turn.get_ice_servers(_channel_name())
    except Exception as exc:  # noqa: BLE001 - surface as a clean error code
        logger.exception("call %s: TURN fetch failed", call_id or "?")
        return {"error": "turn_fetch_failed", "call_id": call_id, "detail": str(exc)}
    if not ice_servers:
        return {"error": "no_turn_servers", "call_id": call_id}

    # --- single-shot answer with the relay candidate embedded ---------------
    result = None
    try:
        result = await single_shot_answerer.create_single_shot_answer(
            offer_sdp, offer_type, ice_servers, turn_only=True
        )
        out = {
            "call_id": call_id,
            "pc_id": result["pc_id"],
            "type": result["type"],
            "answer_sdp": result["sdp"],
        }
        logger.info("call %s: single-shot answer ready (%s)", call_id or "?", result["pc_id"])
        return out
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: answer creation failed", call_id or "?")
        return {"error": "answer_failed", "call_id": call_id, "detail": str(exc)}
    finally:
        # 2a holds no media open: close the pc as soon as the answer is built.
        if result is not None and result.get("pc") is not None:
            try:
                await result["pc"].close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.debug("call %s: pc close raised (ignored)", call_id or "?")


# --- AgentCore Runtime HTTP surface -----------------------------------------
try:
    from fastapi import FastAPI, Request

    app = FastAPI(title="whatsapp-call-runtime")

    @app.get("/ping")
    def ping() -> dict:
        """AgentCore Runtime health probe."""
        return {"status": "ok"}

    @app.post("/invocations")
    async def invocations(request: Request) -> dict:
        """AgentCore Runtime invocation endpoint: Meta offer in, answer out."""
        payload = await request.json()
        try:
            return await run_answer_turn(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace
            logger.exception("answer turn failed")
            return {"error": "answer_turn_failed", "detail": str(exc)}

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "handler:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
