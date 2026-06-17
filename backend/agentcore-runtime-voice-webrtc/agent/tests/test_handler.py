"""Tests for the Call Runtime invoke handler (Task 15, Step 2a).

Feature: whatsapp-restaurant-ai-host

aiortc + av have native deps that do not build on a dev Mac, so these tests
mock the two boundaries the handler crosses: kvs_turn.get_ice_servers (AWS) and
single_shot_answerer.create_single_shot_answer (aiortc). We assert payload
parsing (raw vs base64 offer, missing offer, bad action), that the fetched ICE
servers are threaded into the answerer, that the answer SDP is returned, and
that the peer connection is always closed (no media held open in 2a).
"""
from __future__ import annotations

import base64

import pytest
from hypothesis import given
from hypothesis import strategies as st

import handler


class _FakePC:
    """Stand-in for an aiortc RTCPeerConnection: records that close() ran."""

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def _install_answerer(monkeypatch, *, sdp="v=0\r\nANSWER\r\n", pc=None, capture=None):
    """Patch create_single_shot_answer to a coroutine returning a canned result.
    ``capture`` (a dict) records the ice_servers / kwargs it was called with."""
    pc = pc or _FakePC()

    async def _fake_answer(offer_sdp, offer_type, ice_servers, **kwargs):
        if capture is not None:
            capture["offer_sdp"] = offer_sdp
            capture["offer_type"] = offer_type
            capture["ice_servers"] = ice_servers
            capture["kwargs"] = kwargs
        return {"pc_id": "pc-deadbeef", "sdp": sdp, "type": "answer", "pc": pc}

    monkeypatch.setattr(handler.single_shot_answerer, "create_single_shot_answer", _fake_answer)
    return pc


def _install_turn(monkeypatch, ice_servers):
    monkeypatch.setattr(handler.kvs_turn, "get_ice_servers", lambda *a, **k: ice_servers)


SAMPLE_ICE = [{"urls": ["turn:1.2.3.4:443"], "username": "u", "credential": "c"}]
OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"


@pytest.mark.asyncio
async def test_answer_with_raw_offer(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)
    capture: dict = {}
    pc = _install_answerer(monkeypatch, sdp="v=0\r\nGOOD\r\n", capture=capture)

    out = await handler.run_answer_turn(
        {"action": "answer", "call_id": "call-1", "offer_sdp": OFFER_SDP}
    )

    assert out["answer_sdp"] == "v=0\r\nGOOD\r\n"
    assert out["call_id"] == "call-1"
    assert out["type"] == "answer"
    assert out["pc_id"] == "pc-deadbeef"
    # The fetched ICE servers must be threaded into the answerer, turn_only set.
    assert capture["ice_servers"] == SAMPLE_ICE
    assert capture["kwargs"].get("turn_only") is True
    assert capture["offer_sdp"] == OFFER_SDP
    # No media held open in 2a.
    assert pc.closed is True


@pytest.mark.asyncio
async def test_answer_with_base64_offer(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)
    capture: dict = {}
    _install_answerer(monkeypatch, capture=capture)
    b64 = base64.b64encode(OFFER_SDP.encode("utf-8")).decode("ascii")

    out = await handler.run_answer_turn(
        {"action": "answer", "call_id": "c", "offer_sdp_b64": b64}
    )

    assert "answer_sdp" in out
    # The handler must have decoded the base64 back to the raw SDP.
    assert capture["offer_sdp"] == OFFER_SDP


@pytest.mark.asyncio
async def test_missing_offer_returns_error(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn({"action": "answer", "call_id": "c"})
    assert out["error"] == "bad_offer"
    assert out["call_id"] == "c"


@pytest.mark.asyncio
async def test_bad_base64_returns_error(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn(
        {"action": "answer", "offer_sdp_b64": "!!!not base64!!!"}
    )
    assert out["error"] == "bad_offer"


@pytest.mark.asyncio
async def test_unsupported_action_returns_error(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn({"action": "hangup", "offer_sdp": OFFER_SDP})
    assert out["error"] == "unsupported_action"


@pytest.mark.asyncio
async def test_no_turn_servers_returns_error(monkeypatch):
    _install_turn(monkeypatch, [])
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn({"action": "answer", "offer_sdp": OFFER_SDP})
    assert out["error"] == "no_turn_servers"


@pytest.mark.asyncio
async def test_turn_fetch_failure_is_caught(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("kvs down")

    monkeypatch.setattr(handler.kvs_turn, "get_ice_servers", _boom)
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn({"action": "answer", "offer_sdp": OFFER_SDP})
    assert out["error"] == "turn_fetch_failed"
    assert "kvs down" in out["detail"]


@pytest.mark.asyncio
async def test_answerer_failure_closes_nothing_and_reports(monkeypatch):
    _install_turn(monkeypatch, SAMPLE_ICE)

    async def _boom(*a, **k):
        raise RuntimeError("aiortc exploded")

    monkeypatch.setattr(handler.single_shot_answerer, "create_single_shot_answer", _boom)
    out = await handler.run_answer_turn({"action": "answer", "offer_sdp": OFFER_SDP})
    assert out["error"] == "answer_failed"
    assert "aiortc exploded" in out["detail"]


@pytest.mark.asyncio
async def test_default_action_is_answer(monkeypatch):
    """Omitting 'action' defaults to answer (the only 2a action)."""
    _install_turn(monkeypatch, SAMPLE_ICE)
    _install_answerer(monkeypatch)
    out = await handler.run_answer_turn({"offer_sdp": OFFER_SDP, "call_id": "c"})
    assert "answer_sdp" in out


def test_channel_name_env_precedence(monkeypatch):
    monkeypatch.setenv("KVS_CHANNEL_NAME", "explicit-chan")
    assert handler._channel_name() == "explicit-chan"
    monkeypatch.delenv("KVS_CHANNEL_NAME", raising=False)
    monkeypatch.setenv("DEPLOYMENT_PREFIX", "qsr-wa")
    assert handler._channel_name() == "qsr-wa-voice-call"
    monkeypatch.delenv("DEPLOYMENT_PREFIX", raising=False)
    assert handler._channel_name() == handler.DEFAULT_CHANNEL


@given(
    call_id=st.text(
        alphabet=st.characters(min_codepoint=33, max_codepoint=126), min_size=0, max_size=40
    ),
    use_b64=st.booleans(),
)
def test_property_call_id_roundtrips_and_pc_closed(call_id, use_b64):
    """Feature: whatsapp-restaurant-ai-host, Property (Step 2a): for any call_id
    and either offer encoding, a successful answer echoes the call_id verbatim
    and always closes the peer connection (no leaked media sessions)."""
    import asyncio

    pcs: list[_FakePC] = []

    async def _fake_answer(offer_sdp, offer_type, ice_servers, **kwargs):
        pc = _FakePC()
        pcs.append(pc)
        return {"pc_id": "pc-x", "sdp": "v=0\r\nA\r\n", "type": "answer", "pc": pc}

    orig_turn = handler.kvs_turn.get_ice_servers
    orig_answer = handler.single_shot_answerer.create_single_shot_answer
    handler.kvs_turn.get_ice_servers = lambda *a, **k: SAMPLE_ICE  # type: ignore[assignment]
    handler.single_shot_answerer.create_single_shot_answer = _fake_answer  # type: ignore[assignment]
    try:
        payload = {"action": "answer", "call_id": call_id}
        if use_b64:
            payload["offer_sdp_b64"] = base64.b64encode(OFFER_SDP.encode()).decode("ascii")
        else:
            payload["offer_sdp"] = OFFER_SDP

        out = asyncio.run(handler.run_answer_turn(payload))
        assert out["call_id"] == call_id
        assert out["answer_sdp"] == "v=0\r\nA\r\n"
        assert len(pcs) == 1 and pcs[0].closed is True
    finally:
        handler.kvs_turn.get_ice_servers = orig_turn  # type: ignore[assignment]
        handler.single_shot_answerer.create_single_shot_answer = orig_answer  # type: ignore[assignment]
