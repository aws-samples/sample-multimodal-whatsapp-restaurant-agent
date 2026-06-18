"""Tests for the single-shot-ICE spike's pure SDP analysis (Task 14.1).

Feature: whatsapp-restaurant-ai-host

These assert the locally-checkable spike deliverables (a) single-shot embedded
candidates, (c) DTLS answerer role, (d) Opus/G.711 codec - over synthetic
offer/answer SDPs. Deliverable (b), live ICE completion against KVS TURN, is not
testable without a live peer and is exercised by run_spike.py against Meta's
sandbox.
"""
from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

import sdp_inspect

# A minimal Meta-style offer: actpass DTLS, Opus + PCMU offered, no candidates
# (Meta sends its own; the answerer embeds ours).
OFFER = (
    "v=0\r\n"
    "o=- 1 1 IN IP4 0.0.0.0\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\n"
    "a=rtpmap:111 opus/48000/2\r\n"
    "a=rtpmap:0 PCMU/8000\r\n"
    "a=setup:actpass\r\n"
    "a=sendrecv\r\n"
)

# A single-shot answer: one TURN relay candidate, answerer commits to active,
# Opus kept.
ANSWER_RELAY = (
    "v=0\r\n"
    "o=- 2 2 IN IP4 0.0.0.0\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "m=audio 54321 UDP/TLS/RTP/SAVPF 111\r\n"
    "a=rtpmap:111 opus/48000/2\r\n"
    "a=setup:active\r\n"
    "a=candidate:1 1 UDP 2130706431 52.1.2.3 54321 typ relay raddr 10.0.0.1 rport 5000\r\n"
    "a=sendrecv\r\n"
)


def test_deliverable_a_embedded_relay_candidate():
    """(a) single-shot: candidates embedded; turnOnly relay present."""
    assert sdp_inspect.has_embedded_candidates(ANSWER_RELAY) is True
    assert sdp_inspect.has_relay_candidate(ANSWER_RELAY) is True
    assert sdp_inspect.only_relay_candidates(ANSWER_RELAY) is True


def test_deliverable_c_setup_role_committed():
    """(c) answerer commits to active for an actpass offer."""
    assert sdp_inspect.extract_setup_role(OFFER) == "actpass"
    assert sdp_inspect.extract_setup_role(ANSWER_RELAY) == "active"
    assert sdp_inspect.setup_role_ok(OFFER, ANSWER_RELAY) is True


def test_deliverable_c_rejects_echoed_actpass():
    """An answer that echoes actpass (no committed role) fails (c)."""
    bad_answer = ANSWER_RELAY.replace("a=setup:active", "a=setup:actpass")
    assert sdp_inspect.setup_role_ok(OFFER, bad_answer) is False


def test_deliverable_d_codec_opus():
    """(d) Opus negotiated in the answer."""
    assert sdp_inspect.codec_ok(ANSWER_RELAY) is True
    assert "opus" in sdp_inspect.audio_codecs(ANSWER_RELAY)


def test_deliverable_d_g711_fallback():
    """(d) G.711 (PCMU) fallback is accepted when it is the only codec."""
    g711 = ANSWER_RELAY.replace("a=rtpmap:111 opus/48000/2", "a=rtpmap:0 PCMU/8000")
    assert sdp_inspect.codec_ok(g711) is True


def test_deliverable_d_rejects_unsupported_only():
    """(d) an answer advertising neither Opus nor G.711 fails the codec check."""
    bad = ANSWER_RELAY.replace("a=rtpmap:111 opus/48000/2", "a=rtpmap:96 G722/8000")
    assert sdp_inspect.codec_ok(bad) is False


def test_full_report_structural_pass():
    report = sdp_inspect.analyze_answer(OFFER, ANSWER_RELAY)
    assert report.structural_pass is True
    assert report.answer_role == "active"
    assert "opus" in report.answer_codecs


def test_host_only_answer_is_not_turnonly():
    """A host candidate (no relay) is single-shot but not turnOnly."""
    host_answer = ANSWER_RELAY.replace(
        "a=candidate:1 1 UDP 2130706431 52.1.2.3 54321 typ relay raddr 10.0.0.1 rport 5000",
        "a=candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host",
    )
    assert sdp_inspect.has_embedded_candidates(host_answer) is True
    assert sdp_inspect.has_relay_candidate(host_answer) is False
    assert sdp_inspect.only_relay_candidates(host_answer) is False


@given(
    n_relay=st.integers(min_value=0, max_value=4),
    n_host=st.integers(min_value=0, max_value=4),
)
def test_property_candidate_counts(n_relay, n_host):
    """Feature: whatsapp-restaurant-ai-host, Property (spike): candidate parsing
    counts relay and non-relay candidates exactly; only_relay holds iff there is
    >=1 candidate and none are non-relay."""
    lines = [
        "v=0\r\n",
        "m=audio 1 UDP/TLS/RTP/SAVPF 111\r\n",
        "a=rtpmap:111 opus/48000/2\r\n",
        "a=setup:active\r\n",
    ]
    for i in range(n_relay):
        lines.append(f"a=candidate:{i} 1 UDP 100 52.0.0.{i} 50000 typ relay\r\n")
    for i in range(n_host):
        lines.append(f"a=candidate:{i} 1 UDP 100 10.0.0.{i} 50000 typ host\r\n")
    sdp = "".join(lines)

    cands = sdp_inspect.parse_ice_candidates(sdp)
    assert len(cands) == n_relay + n_host
    assert sum(1 for c in cands if c.is_relay) == n_relay
    assert sdp_inspect.has_embedded_candidates(sdp) == (n_relay + n_host >= 1)
    assert sdp_inspect.has_relay_candidate(sdp) == (n_relay >= 1)
    assert sdp_inspect.only_relay_candidates(sdp) == (n_relay >= 1 and n_host == 0)


# --- Task 18: codec selection (select_offered_codec) ------------------------

def _audio_offer(*encodings: str) -> str:
    """Build a minimal offer SDP advertising the given rtpmap encodings."""
    lines = ["v=0", "o=- 1 1 IN IP4 0.0.0.0", "m=audio 9 UDP/TLS/RTP/SAVPF 96"]
    for i, enc in enumerate(encodings):
        lines.append(f"a=rtpmap:{96 + i} {enc}")
    return "\r\n".join(lines) + "\r\n"


def test_select_codec_prefers_opus_when_advertised():
    assert sdp_inspect.select_offered_codec(_audio_offer("opus/48000/2")) == "opus"
    # Opus is preferred even when G.711 is also offered.
    assert (
        sdp_inspect.select_offered_codec(_audio_offer("opus/48000/2", "PCMU/8000"))
        == "opus"
    )


def test_select_codec_falls_back_to_g711():
    assert sdp_inspect.select_offered_codec(_audio_offer("PCMU/8000")) == "g711"
    assert sdp_inspect.select_offered_codec(_audio_offer("PCMA/8000")) == "g711"
    assert (
        sdp_inspect.select_offered_codec(_audio_offer("PCMU/8000", "PCMA/8000")) == "g711"
    )


def test_select_codec_none_when_unsupported():
    # Neither Opus nor G.711 -> None (caller must reject, R8.7).
    assert sdp_inspect.select_offered_codec(_audio_offer("G729/8000")) is None
    assert (
        sdp_inspect.select_offered_codec(
            _audio_offer("G729/8000", "telephone-event/8000")
        )
        is None
    )
    # An audio m-line with no rtpmap advertises no codec -> None.
    assert sdp_inspect.select_offered_codec("v=0\r\nm=audio 9 RTP 96\r\n") is None
