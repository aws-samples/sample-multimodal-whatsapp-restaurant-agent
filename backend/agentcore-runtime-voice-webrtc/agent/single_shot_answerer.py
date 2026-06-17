"""Single-shot-ICE aiortc answerer for the WhatsApp Call Runtime (Task 15).

This is the heart of the spike: it reworks the official AgentCore WebRTC sample's
TRICKLE-ICE flow into a SINGLE-SHOT answer that Meta requires (Meta provides no
trickle return channel). The key adaptation:

  - aiortc gathers ICE candidates DURING ``setLocalDescription`` and embeds them
    in ``pc.localDescription.sdp`` - it is non-trickle by nature. We additionally
    wait for ``iceGatheringState == "complete"`` to be certain every candidate
    (including the TURN relay candidate) is present before we hand the answer
    back, so Meta receives one complete SDP with candidates baked in.
  - The peer connection is configured with the KVS TURN ice servers. The runtime
    has no public IP (VPC mode), so the only useful candidate is the relay one;
    ``turn_only`` additionally strips non-relay candidates from the returned SDP
    so the answer advertises ONLY the relay path (matching Meta's turnOnly hint).

aiortc + PyAV are imported lazily so the pure ``sdp_inspect`` analysis and its
tests run without them. This module runs live (against Meta's sandbox) via
``run_spike.py``; the structural shape of the answer it produces is asserted by
``sdp_inspect`` without a live peer.

Reference: awslabs/agentcore-samples 06-bi-directional-streaming-webrtc (the
sample whose trickle flow this replaces).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

# How long to wait for ICE gathering to reach "complete" before giving up. KVS
# relay candidates resolve quickly; this bounds a stuck gather well within
# Meta's 30-60 s accept window.
DEFAULT_GATHER_TIMEOUT_S = 15.0


def _build_configuration(ice_servers: list[dict]) -> Any:
    """Build an aiortc RTCConfiguration from the KVS iceServers list."""
    from aiortc import RTCConfiguration, RTCIceServer

    servers = []
    for s in ice_servers:
        urls = s.get("urls") or s.get("url")
        if not urls:
            continue
        servers.append(
            RTCIceServer(
                urls=urls,
                username=s.get("username"),
                credential=s.get("credential"),
            )
        )
    return RTCConfiguration(iceServers=servers)


async def _wait_ice_complete(pc: Any, timeout_s: float) -> None:
    """Await iceGatheringState == 'complete' (or timeout). aiortc usually
    completes gathering within setLocalDescription, but we guard explicitly so
    the returned SDP is guaranteed to carry every candidate."""
    if pc.iceGatheringState == "complete":
        return
    done = asyncio.Event()

    @pc.on("icegatheringstatechange")
    async def _on_change() -> None:  # pragma: no cover - event-driven
        if pc.iceGatheringState == "complete":
            done.set()

    try:
        await asyncio.wait_for(done.wait(), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.warning("ICE gathering did not reach 'complete' within %ss", timeout_s)


def _strip_to_relay(sdp: str) -> str:
    """Remove non-relay a=candidate lines so the answer advertises only the TURN
    relay path (turnOnly). Lines other than candidates pass through unchanged."""
    kept: list[str] = []
    for line in sdp.splitlines():
        if line.startswith("a=candidate:"):
            toks = line.split()
            # a=candidate:... typ <type> ...; keep only 'typ relay'.
            if "typ" in toks:
                typ = toks[toks.index("typ") + 1] if toks.index("typ") + 1 < len(toks) else ""
                if typ != "relay":
                    continue
        kept.append(line)
    # Preserve trailing CRLF convention of the original SDP.
    sep = "\r\n" if "\r\n" in sdp else "\n"
    return sep.join(kept) + (sep if sdp.endswith(("\n", "\r\n")) else "")


def _first_relay_endpoint(sdp: str) -> tuple[str, str] | None:
    """Return (ip, port) of the first ``typ relay`` candidate, or None.

    Candidate grammar: ``a=candidate:<foundation> <component> <transport>
    <priority> <connection-address> <port> typ relay ...`` - so the routable
    relay endpoint is tokens [4] and [5] after the ``a=candidate:`` prefix."""
    for line in sdp.splitlines():
        if line.startswith("a=candidate:") and " typ relay" in line:
            toks = line.split()
            if len(toks) >= 6:
                return toks[4], toks[5]
    return None


def _munge_for_meta(sdp: str) -> str:
    """Rewrite the aiortc answer SDP so Meta's Calling API accepts it (avoids
    error 138008 "SDP Validation error"). Three transforms, applied line by line:

      1. exactly ONE ``a=fingerprint:sha-256`` line - aiortc emits sha-256 +
         sha-384 + sha-512, but Meta requires a single sha-256 fingerprint;
      2. the media address must be ROUTABLE - the container has no public IP, so
         aiortc puts a link-local (169.254.x.x) in ``c=`` and the ``m=`` port.
         Rewrite both to the TURN relay candidate's public ip/port (the only
         address Meta can actually reach);
      3. ``a=recvonly`` -> ``a=sendrecv`` - the offer is sendrecv; answering
         recvonly invites teardown.

    If no relay candidate is present (should not happen in VPC mode), the c=/m=
    rewrite is skipped but the fingerprint + direction fixes still apply."""
    relay = _first_relay_endpoint(sdp)
    sep = "\r\n" if "\r\n" in sdp else "\n"
    trailing = sdp.endswith(("\n", "\r\n"))
    out: list[str] = []
    seen_sha256_fp = False
    for line in sdp.split(sep):
        if line.startswith("a=fingerprint:"):
            # Keep only the first sha-256 fingerprint; drop sha-384/sha-512/dupes.
            if "sha-256" in line.lower() and not seen_sha256_fp:
                seen_sha256_fp = True
                out.append(line)
            continue
        if relay is not None and line.startswith("m=audio "):
            # m=audio <port> <proto> <fmt...> -> swap <port> for the relay port.
            parts = line.split(" ")
            if len(parts) >= 2:
                parts[1] = relay[1]
                out.append(" ".join(parts))
                continue
        if relay is not None and line.startswith("c=IN IP4 "):
            out.append(f"c=IN IP4 {relay[0]}")
            continue
        if line in ("a=recvonly", "a=sendonly", "a=inactive"):
            out.append("a=sendrecv")
            continue
        out.append(line)
    return sep.join(out) + (sep if trailing else "")


async def create_single_shot_answer(
    offer_sdp: str,
    offer_type: str,
    ice_servers: list[dict],
    *,
    turn_only: bool = True,
    gather_timeout_s: float = DEFAULT_GATHER_TIMEOUT_S,
    on_track: Any = None,
) -> dict:
    """Produce a single-shot SDP answer for a Meta offer.

    Sets the remote offer, creates an answer, waits for ICE gathering to
    complete (so candidates are embedded), optionally strips to relay-only
    (turn_only), and returns ``{"pc_id", "sdp", "type": "answer", "pc"}``. The
    caller owns ``pc`` and must close it when the call ends. ``on_track`` (if
    given) is registered so inbound audio can be wired to the transcode/Sonic
    path - the spike uses it only to confirm media tracks negotiate."""
    from aiortc import RTCPeerConnection, RTCSessionDescription

    pc = RTCPeerConnection(configuration=_build_configuration(ice_servers))
    pc_id = f"pc-{id(pc):x}"

    if on_track is not None:
        pc.on("track")(on_track)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type=offer_type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await _wait_ice_complete(pc, gather_timeout_s)

    sdp = pc.localDescription.sdp
    if turn_only:
        sdp = _strip_to_relay(sdp)
    # Always reshape the answer to Meta's SDP validation rules (single sha-256
    # fingerprint, routable relay c=/m=, sendrecv). See _munge_for_meta.
    sdp = _munge_for_meta(sdp)

    logger.info(
        "single-shot answer ready pc_id=%s gathering=%s",
        pc_id,
        pc.iceGatheringState,
    )
    return {"pc_id": pc_id, "sdp": sdp, "type": "answer", "pc": pc}
