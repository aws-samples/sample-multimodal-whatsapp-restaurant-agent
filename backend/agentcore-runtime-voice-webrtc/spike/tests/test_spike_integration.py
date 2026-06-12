"""Headline single-shot-ICE interop integration test (Task 14.2).

Feature: whatsapp-restaurant-ai-host

The project's top-risk integration test: a working Meta <-> aiortc-over-KVS-TURN
offer/answer handshake proving single-shot answer, ICE completion, DTLS role
negotiation, and Opus/G.711 codec negotiation. 1-3 concrete examples, NOT a
property run.

This requires aiortc + PyAV + live AWS credentials with KVS WebRTC access, so it
SKIPS unless RUN_WEBRTC_SPIKE=1 and those deps/creds are present. It is a real
test for the spike environment, not a no-op:

  - Locally-checkable deliverables (a)(c)(d): asserted here via sdp_inspect over
    the answer the live answerer produces from a captured Meta offer.
  - Deliverable (b), Meta completing ICE against the KVS relay, is confirmed by
    POSTing the produced answer back to Meta and the call connecting (a manual
    loop documented in README.md) - it cannot be asserted from within this test.

Provide a captured Meta SDP offer via SPIKE_OFFER_SDP_PATH; otherwise the test
skips with a clear reason.
"""
from __future__ import annotations

import asyncio
import importlib.util
import os

import pytest

import sdp_inspect

RUN_FLAG = "RUN_WEBRTC_SPIKE"
OFFER_PATH_ENV = "SPIKE_OFFER_SDP_PATH"


def _have(mod: str) -> bool:
    return importlib.util.find_spec(mod) is not None


pytestmark = pytest.mark.skipif(
    os.environ.get(RUN_FLAG) != "1" or not _have("aiortc") or not _have("boto3"),
    reason=(
        f"set {RUN_FLAG}=1 with aiortc + boto3 + KVS WebRTC credentials to run the "
        "live single-shot-ICE interop spike"
    ),
)


def test_single_shot_handshake_against_kvs_turn():
    """Produce a single-shot answer from a captured Meta offer over live KVS
    TURN and assert the structural deliverables (a)(c)(d)."""
    offer_path = os.environ.get(OFFER_PATH_ENV)
    if not offer_path or not os.path.exists(offer_path):
        pytest.skip(f"set {OFFER_PATH_ENV} to a captured Meta SDP offer file")

    import kvs_turn
    from single_shot_answerer import create_single_shot_answer

    with open(offer_path, "r", encoding="utf-8") as fh:
        offer_sdp = fh.read()
    assert sdp_inspect.has_audio_media(offer_sdp), "offer has no audio m-line"

    channel = kvs_turn.channel_name_from_env()
    ice_servers = kvs_turn.get_ice_servers(channel)
    assert ice_servers, "KVS returned no TURN ice servers"

    async def _run() -> dict:
        result = await create_single_shot_answer(offer_sdp, "offer", ice_servers, turn_only=True)
        try:
            return {"sdp": result["sdp"]}
        finally:
            await result["pc"].close()

    answer = asyncio.run(_run())
    report = sdp_inspect.analyze_answer(offer_sdp, answer["sdp"])

    # (a) single-shot embedded candidates incl. a relay candidate (turnOnly).
    assert report.single_shot, "answer carries no embedded ICE candidates"
    assert report.has_relay, "answer carries no TURN relay candidate"
    # (c) DTLS answerer committed to a concrete role.
    assert report.setup_role_ok, f"answer setup role not committed: {report.answer_role}"
    # (d) Opus / G.711 negotiated.
    assert report.codec_ok, f"no accepted codec negotiated: {report.answer_codecs}"
    # NOTE: deliverable (b) - Meta completing ICE - is confirmed by the live call
    # connecting after this answer is POSTed back (README.md), not asserted here.
