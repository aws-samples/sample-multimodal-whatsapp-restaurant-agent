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

import asyncio
import base64
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import kvs_turn
import single_shot_answerer
import sonic_call
import transcode
import pstn_customer
from memory_client import Turn
from session import Session

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

# Live calls held open, keyed by pc_id. Each entry is a _CallBundle carrying the
# peer connection, the Nova Sonic agent + its MCP client, the outbound track, and
# the background pump tasks - everything run_disconnect must tear down. In-process
# per microVM; session affinity (same runtime_session_id for offer + disconnect)
# keeps a call's offer and hangup on the same microVM. See module docstring.
_PCS: Dict[str, "_CallBundle"] = {}


@dataclass
class _CallBundle:
    """Everything tied to one live call's held peer connection."""

    pc: Any
    agent: Any = None
    mcp_client: Any = None
    output_track: Any = None
    tasks: List[Any] = field(default_factory=list)
    # Identity + memory: ``session`` carries the customer_id, ``memory`` is the
    # shared AgentCore Memory client, and ``transcript`` accumulates (role, text)
    # turns that run_disconnect writes back at call end (Task 16.4).
    session: Any = None
    memory: Any = None
    transcript: List[Any] = field(default_factory=list)

    async def teardown(self) -> None:
        """Best-effort teardown: cancel pumps, stop the agent, close MCP + pc."""
        for task in self.tasks:
            task.cancel()
        if self.agent is not None:
            try:
                await self.agent.stop()
            except Exception:  # noqa: BLE001
                logger.debug("agent stop raised (ignored)")
        if self.mcp_client is not None:
            try:
                self.mcp_client.__exit__(None, None, None)
            except Exception:  # noqa: BLE001
                logger.debug("mcp client exit raised (ignored)")
        if self.pc is not None:
            try:
                await self.pc.close()
            except Exception:  # noqa: BLE001
                logger.debug("pc close raised (ignored)")


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


async def run_offer(payload: dict) -> dict:
    """Answer a Meta offer, wire Nova 2 Sonic to the media, and HOLD the pc open.

    Reads the design contract ``data: {sdp, type, turnOnly}``. Builds a Nova
    Sonic BidiAgent, attaches the inbound pump + outbound SonicOutputTrack so the
    answer negotiates sendrecv, spawns the receive + keepalive pumps, and
    registers the whole bundle by pc_id in ``_PCS`` so ``disconnect`` can tear it
    down. Never raises: failures degrade to an ``{"error": ...}`` dict.

    Identity: the webhook worker threads the caller's pseudonymous ``wa-``
    customer_id in ``data.customer_id`` (never the raw phone - that is PII). When
    present the Sonic session is built identified, so shared AgentCore Memory
    reads the caller's insights at start and writes the transcript at end. With
    no customer_id the session stays anonymous (no memory)."""
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

    # Identity: prefer the worker-derived wa- customer_id (identified caller);
    # otherwise fall back to an anonymous session (no memory continuity).
    data_customer_id = (data.get("customer_id") or "").strip()
    if data_customer_id:
        customer_id, anonymous, from_last4 = data_customer_id, False, ""
    else:
        try:
            customer_id, anonymous, from_last4 = pstn_customer.derive_for_session("")
        except Exception:  # noqa: BLE001
            customer_id, anonymous, from_last4 = pstn_customer.derive("", b"")
    session = Session(
        call_id=call_id,
        raw_from="",
        from_last4=from_last4,
        anonymous=anonymous,
        customer_id=customer_id,
    )

    # Build + start the Nova Sonic agent (model + MCP tools + prompt + memory).
    try:
        mcp_client, agent, memory = await sonic_call.build_agent(session)
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: agent build failed", call_id or "?")
        return {"error": "agent_failed", "call_id": call_id, "detail": str(exc)}

    output_track = transcode.SonicOutputTrack()
    on_track = sonic_call.make_inbound_pump(agent)
    bundle = _CallBundle(
        pc=None,
        agent=agent,
        mcp_client=mcp_client,
        output_track=output_track,
        session=session,
        memory=memory,
    )

    try:
        result = await single_shot_answerer.create_single_shot_answer(
            offer_sdp,
            offer_type,
            ice_servers,
            turn_only=turn_only,
            on_track=on_track,
            output_track=output_track,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("call %s: answer creation failed", call_id or "?")
        await bundle.teardown()
        return {"error": "answer_failed", "call_id": call_id, "detail": str(exc)}

    bundle.pc = result["pc"]
    pc_id = result["pc_id"]
    # Spawn the outbound (Sonic -> track) pump and the idle keepalive.
    bundle.tasks = [
        asyncio.create_task(
            sonic_call.receive_pump(agent, output_track, session, bundle.transcript),
            name=f"recv-{pc_id}",
        ),
        asyncio.create_task(sonic_call.keepalive_loop(agent), name=f"keepalive-{pc_id}"),
    ]
    _PCS[pc_id] = bundle
    logger.info(
        "call %s: answer ready, Sonic wired, pc held open pc_id=%s (live pcs=%d)",
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


async def _maybe_write_memory(bundle: "_CallBundle") -> None:
    """Write the call's transcript to shared AgentCore Memory at call end.

    Identified callers only (an anonymous call has no stable id to persist
    against). session_id == customer_id mirrors the Chat/VoiceNotes convention
    (R5.1) so consolidation groups all of a customer's interactions together.
    Best-effort: a write failure never breaks teardown (R18.7). The blocking
    boto3 call is offloaded so it does not stall the event loop."""
    session = getattr(bundle, "session", None)
    memory = getattr(bundle, "memory", None)
    if memory is None or session is None:
        return
    if getattr(session, "anonymous", True) or not getattr(session, "customer_id", ""):
        return
    if not getattr(memory, "configured", False):
        return
    turns = [
        Turn(role=role, text=text)
        for (role, text) in (bundle.transcript or [])
        if text and text.strip()
    ]
    if not turns:
        return
    try:
        await asyncio.to_thread(
            memory.write_events, session.customer_id, session.customer_id, turns
        )
        logger.info(
            "call: wrote %d transcript turns to shared memory", len(turns)
        )
    except Exception as exc:  # noqa: BLE001 - memory write never breaks teardown
        logger.warning("call memory write failed (ignored): %s", exc)


async def run_disconnect(payload: dict) -> dict:
    """Tear down the held call for a pc_id (Task 17 terminate path).

    Writes the conversation transcript back to shared memory (identified
    callers) before tearing down the agent + peer connection."""
    data = payload.get("data") or {}
    pc_id = (data.get("pc_id") or "").strip()
    if not pc_id:
        return {"error": "bad_disconnect", "detail": "missing data.pc_id"}

    bundle = _PCS.pop(pc_id, None)
    if bundle is None:
        # Idempotent: a duplicate terminate or a pc on another microVM.
        logger.info("disconnect: pc_id=%s not found (already closed?)", pc_id)
        return {"pc_id": pc_id, "status": "not_found"}

    await _maybe_write_memory(bundle)
    await bundle.teardown()
    logger.info("disconnect: pc %s torn down (live pcs=%d)", pc_id, len(_PCS))
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
