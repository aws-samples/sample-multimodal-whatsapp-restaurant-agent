"""WhatsApp Call Runtime - invoke entrypoint (Tasks 15-17).

The Call Runtime is the WebRTC signaling surface for WhatsApp voice calls. It
runs aiortc INSIDE the AgentCore Runtime container, which is why the runtime
must be deployed in VPC network mode (PUBLIC mode blocks the outbound UDP that
WebRTC media needs). See:
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-webrtc.html

There is NO Nova 2 Sonic on the media path yet - that arrives in Tasks 18/19.
Today the runtime answers a Meta offer, HOLDS the peer connection open so media
actually connects (the caller hears silence until Sonic lands), and closes the
connection on disconnect. The flow per offer:

  1. receive a Meta SDP offer (the webhook worker relays the `calls` connect
     event - Task 17),
  2. fetch KVS managed TURN credentials (kvs_turn.get_ice_servers) - the
     container has no public IP, so the relay candidate is the only viable ICE
     path,
  3. build a SINGLE-SHOT SDP answer with the relay candidate embedded
     (single_shot_answerer.create_single_shot_answer, turn_only=True) - Meta is
     ice-lite / single-shot and gives no trickle return channel,
  4. register the live peer connection by pc_id and return the answer SDP for
     the worker to POST back to Meta (pre_accept / accept).

Invoke contract (the webhook worker - Task 17 - builds these payloads):

    # connect: relay the Meta offer, hold the pc open, return the answer
    POST /invocations
    { "action": "offer",
      "call_id": "<meta call id>",              # opaque, echoed back
      "data": { "sdp": "<raw Meta offer SDP>",
                "type": "offer",
                "turnOnly": true } }
    200 -> { "call_id": "...", "pc_id": "pc-...", "type": "answer",
             "sdp": "<single-shot answer SDP>" }

    # terminate/hangup: close the held pc for this call
    POST /invocations
    { "action": "disconnect", "data": { "pc_id": "pc-..." } }
    200 -> { "pc_id": "pc-...", "status": "disconnected" }

    200 (error) -> { "error": "<code>", "call_id": "...", "detail": "..." }

A legacy ``action: "answer"`` shape (offer_sdp / offer_sdp_b64 in, answer_sdp
out, pc CLOSED immediately) is retained for the Task 15 structural smoke test
and unit tests - it does NOT hold media open.

Session affinity: the worker invokes ``offer`` and the later ``disconnect`` with
the SAME runtime_session_id, so both land on the same microVM and the in-process
``_PCS`` registry resolves the pc_id. The worker externalizes call-id ->
pc_id/session-id to DynamoDB because IT scales horizontally; the runtime side
only needs the per-microVM registry.

aiortc + av are imported lazily (inside single_shot_answerer) so a bare
``python -c "import handler"`` smoke test in the Docker build works without the
native media deps, and the unit tests mock the answerer + TURN fetch entirely.
"""
from __future__ import annotations

import base64
import logging
import os
from typing import Any, Dict

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
# kvs_turn). Name is env-driven so the CDK pins it per deployment.
DEFAULT_CHANNEL = "wa-voice-call"

# Live peer connections held open for in-flight calls, keyed by pc_id. Populated
# by the `offer` action and drained by `disconnect`. In-process per microVM;
# session affinity (same runtime_session_id for offer + disconnect) keeps a
# call's offer and hangup on the same microVM. See module docstring.
_PCS: Dict[str, Any] = {}


def _channel_name() -> str:
    """KVS channel name: KVS_CHANNEL_NAME, else <DEPLOYMENT_PREFIX>-voice-call,
    else the bare default. Keeps the channel namespaced per deployment."""
    explicit = os.environ.get("KVS_CHANNEL_NAME")
    if explicit:
        return explicit
    prefix = os.environ.get("DEPLOYMENT_PREFIX")
    return f"{prefix}-voice-call" if prefix else DEFAULT_CHANNEL


def _decode_offer(payload: dict) -> str:
    """Extract the raw offer SDP for the LEGACY ``answer`` action.

    Accepts either ``offer_sdp`` (raw SDP text) or ``offer_sdp_b64`` (base64).
    Raises ValueError if neither is present or the base64 is malformed."""
    raw = payload.get("offer_sdp")
    if raw:
        return raw
    b64 = payload.get("offer_sdp_b64")
    if b64:
        return base64.b64decode(b64, validate=True).decode("utf-8")
    raise ValueError("missing offer_sdp / offer_sdp_b64")


async def _drain_track(track: Any) -> None:
    """Continuously read and discard inbound media frames.

    Until Nova 2 Sonic is wired in (Tasks 18/19) the agent does not consume
    audio, but an unread receiver can stall the transport. Draining keeps the
    media path healthy so the call stays connected. Exits when the track ends
    (the pc closed), swallowing the resulting exception."""
    try:
        while True:
            await track.recv()
    except Exception:  # noqa: BLE001 - track ended / pc closed
        return


async def run_offer(payload: dict) -> dict:
    """Answer a Meta offer and HOLD the peer connection open (Task 17).

    Reads the design contract ``data: {sdp, type, turnOnly}``. Registers the
    live pc by pc_id in ``_PCS`` so a later ``disconnect`` can close it. Never
    raises: failures degrade to an ``{"error": ...}`` dict."""
    call_id = (payload.get("call_id") or "").strip()
    data = payload.get("data") or {}
    offer_sdp = data.get("sdp")
    if not offer_sdp:
        return {"error": "bad_offer", "call_id": call_id, "detail": "missing data.sdp"}
    offer_type = (data.get("type") or "offer").strip()
    turn_only = data.get("turnOnly", True)

    try:
        ice_servers = kvs_turn.get_ice_servers(_channel_name())
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: TURN fetch failed", call_id or "?")
        return {"error": "turn_fetch_failed", "call_id": call_id, "detail": str(exc)}
    if not ice_servers:
        return {"error": "no_turn_servers", "call_id": call_id}

    try:
        result = await single_shot_answerer.create_single_shot_answer(
            offer_sdp, offer_type, ice_servers, turn_only=turn_only, on_track=_drain_track
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: answer creation failed", call_id or "?")
        return {"error": "answer_failed", "call_id": call_id, "detail": str(exc)}

    pc_id = result["pc_id"]
    # HOLD the pc open: register it instead of closing. disconnect() closes it.
    _PCS[pc_id] = result["pc"]
    logger.info(
        "call %s: answer ready, pc held open pc_id=%s (live pcs=%d)",
        call_id or "?",
        pc_id,
        len(_PCS),
    )
    return {
        "call_id": call_id,
        "pc_id": pc_id,
        "type": result["type"],
        "sdp": result["sdp"],
    }


async def run_disconnect(payload: dict) -> dict:
    """Close the held peer connection for a call (Task 17 terminate path)."""
    data = payload.get("data") or {}
    pc_id = (data.get("pc_id") or "").strip()
    if not pc_id:
        return {"error": "bad_disconnect", "detail": "missing data.pc_id"}

    pc = _PCS.pop(pc_id, None)
    if pc is None:
        # Idempotent: a duplicate terminate or a pc on another microVM.
        logger.info("disconnect: pc_id=%s not found (already closed?)", pc_id)
        return {"pc_id": pc_id, "status": "not_found"}

    try:
        await pc.close()
    except Exception:  # noqa: BLE001 - best-effort teardown
        logger.debug("disconnect: pc %s close raised (ignored)", pc_id)
    logger.info("disconnect: pc %s closed (live pcs=%d)", pc_id, len(_PCS))
    return {"pc_id": pc_id, "status": "disconnected"}


async def run_answer_turn(payload: dict) -> dict:
    """LEGACY (Task 15 smoke / unit tests): single-shot answer, pc CLOSED.

    Retained so the structural smoke test and unit tests keep exercising the
    answer path without holding media open. New call traffic uses ``offer``."""
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

    try:
        ice_servers = kvs_turn.get_ice_servers(_channel_name())
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: TURN fetch failed", call_id or "?")
        return {"error": "turn_fetch_failed", "call_id": call_id, "detail": str(exc)}
    if not ice_servers:
        return {"error": "no_turn_servers", "call_id": call_id}

    result = None
    try:
        result = await single_shot_answerer.create_single_shot_answer(
            offer_sdp, offer_type, ice_servers, turn_only=True
        )
        logger.info("call %s: single-shot answer ready (%s)", call_id or "?", result["pc_id"])
        return {
            "call_id": call_id,
            "pc_id": result["pc_id"],
            "type": result["type"],
            "answer_sdp": result["sdp"],
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: answer creation failed", call_id or "?")
        return {"error": "answer_failed", "call_id": call_id, "detail": str(exc)}
    finally:
        if result is not None and result.get("pc") is not None:
            try:
                await result["pc"].close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.debug("call %s: pc close raised (ignored)", call_id or "?")


async def handle_invocation(payload: dict) -> dict:
    """Route an invocation by ``action``: offer | disconnect | answer (legacy).

    Never raises: an unknown action returns an ``unsupported_action`` error."""
    action = (payload.get("action") or "offer").strip()
    if action == "offer":
        return await run_offer(payload)
    if action == "disconnect":
        return await run_disconnect(payload)
    if action == "answer":
        return await run_answer_turn(payload)
    return {
        "error": "unsupported_action",
        "call_id": (payload.get("call_id") or "").strip(),
        "detail": action,
    }


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
        """AgentCore Runtime invocation endpoint: dispatch by action."""
        payload = await request.json()
        try:
            return await handle_invocation(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace
            logger.exception("invocation failed")
            return {"error": "invocation_failed", "detail": str(exc)}

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "handler:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
