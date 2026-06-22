"""Pure SDP analysis for the single-shot-ICE spike (Task 14.1).

These helpers parse an SDP string with NOTHING but the stdlib, so the spike's
STRUCTURAL deliverables can be asserted without aiortc, KVS, or a live peer:

  (a) single-shot answer carries ICE candidates embedded in the SDP,
  (c) DTLS setup-role negotiation (offer actpass -> answer active/passive),
  (d) codec negotiation resolves to Opus or the G.711 (PCMU/PCMA) fallback.

Deliverable (b) - Meta actually COMPLETING ICE against the KVS TURN relay - can
only be observed by running ``run_spike.py`` against Meta's sandbox with live
KVS credentials; it is not inspectable from a locally-produced answer.

SDP grammar references: RFC 4566 (SDP), RFC 8839 (ICE SDP / a=candidate),
RFC 8842 (a=setup / DTLS-SRTP), RFC 4568.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Codecs this design accepts on the audio m-line: Opus (preferred) and the
# G.711 fallback (selectable since Meta added it in March 2026). Compared
# case-insensitively against the rtpmap encoding name.
ACCEPTED_AUDIO_CODECS = ("opus", "pcmu", "pcma")

_CANDIDATE_RE = re.compile(r"^a=candidate:(.+)$", re.MULTILINE)
_SETUP_RE = re.compile(r"^a=setup:(actpass|active|passive|holdconn)\s*$", re.MULTILINE)
_RTPMAP_RE = re.compile(r"^a=rtpmap:\d+\s+([A-Za-z0-9._-]+)/\d+", re.MULTILINE)
_AUDIO_MLINE_RE = re.compile(r"^m=audio\s+\d+\s+\S+\s+(.+)$", re.MULTILINE)


@dataclass
class IceCandidate:
    """The fields of an a=candidate line we care about for the spike."""

    foundation: str
    component: int
    transport: str
    priority: int
    ip: str
    port: int
    typ: str  # host | srflx | prflx | relay

    @property
    def is_relay(self) -> bool:
        return self.typ == "relay"


def parse_ice_candidates(sdp: str) -> list[IceCandidate]:
    """Parse every a=candidate line into an IceCandidate.

    a=candidate:<foundation> <component> <transport> <priority> <ip> <port>
                typ <type> [...]. Malformed lines are skipped rather than
    raising - the spike report counts what parsed."""
    out: list[IceCandidate] = []
    for raw in _CANDIDATE_RE.findall(sdp):
        toks = raw.split()
        if len(toks) < 8 or toks[6] != "typ":
            continue
        try:
            out.append(
                IceCandidate(
                    foundation=toks[0],
                    component=int(toks[1]),
                    transport=toks[2],
                    priority=int(toks[3]),
                    ip=toks[4],
                    port=int(toks[5]),
                    typ=toks[7],
                )
            )
        except (ValueError, IndexError):
            continue
    return out


def has_embedded_candidates(sdp: str) -> bool:
    """Deliverable (a): the answer is single-shot - >= 1 ICE candidate is
    embedded directly in the SDP (no trickle/return channel needed)."""
    return len(parse_ice_candidates(sdp)) >= 1


def has_relay_candidate(sdp: str) -> bool:
    """turnOnly check: at least one embedded candidate is a TURN relay
    candidate (the runtime has no public IP, so media must relay)."""
    return any(c.is_relay for c in parse_ice_candidates(sdp))


def only_relay_candidates(sdp: str) -> bool:
    """Strict turnOnly: every embedded candidate is a relay candidate."""
    cands = parse_ice_candidates(sdp)
    return bool(cands) and all(c.is_relay for c in cands)


def extract_setup_role(sdp: str) -> Optional[str]:
    """Return the a=setup role (actpass | active | passive | holdconn) or None."""
    m = _SETUP_RE.search(sdp)
    return m.group(1) if m else None


def audio_codecs(sdp: str) -> list[str]:
    """Lower-cased rtpmap encoding names advertised on the audio m-line."""
    return [name.lower() for name in _RTPMAP_RE.findall(sdp)]


def has_audio_media(sdp: str) -> bool:
    return _AUDIO_MLINE_RE.search(sdp) is not None


def setup_role_ok(offer_sdp: str, answer_sdp: str) -> bool:
    """Deliverable (c): with the runtime as the ANSWERER, an offer that says
    a=setup:actpass must be answered with a=setup:active or :passive (the
    answerer commits to a concrete DTLS role; it must not echo actpass)."""
    offer_role = extract_setup_role(offer_sdp)
    answer_role = extract_setup_role(answer_sdp)
    if offer_role != "actpass":
        # Not the actpass case; just require the answer commits to a role.
        return answer_role in ("active", "passive")
    return answer_role in ("active", "passive")


def codec_ok(answer_sdp: str) -> bool:
    """Deliverable (d): the negotiated audio codec is Opus or the G.711
    (PCMU/PCMA) fallback - at least one accepted codec survives in the answer."""
    return any(c in ACCEPTED_AUDIO_CODECS for c in audio_codecs(answer_sdp))


@dataclass
class DeliverableReport:
    """The locally-inspectable spike deliverables (a), (c), (d). Deliverable
    (b) - live ICE completion against KVS TURN - is reported separately by the
    live run, not here."""

    single_shot: bool  # (a) candidates embedded
    has_relay: bool  # (a)/turnOnly relay candidate present
    only_relay: bool  # strict turnOnly
    setup_role_ok: bool  # (c) DTLS answerer role committed
    codec_ok: bool  # (d) Opus / G.711 negotiated
    answer_role: Optional[str]
    answer_codecs: list[str]

    @property
    def structural_pass(self) -> bool:
        """True when every LOCALLY-checkable deliverable holds (a, c, d). Live
        ICE completion (b) is still required from the sandbox run."""
        return self.single_shot and self.has_relay and self.setup_role_ok and self.codec_ok


def analyze_answer(offer_sdp: str, answer_sdp: str) -> DeliverableReport:
    """Produce the structural deliverable report for an offer/answer pair."""
    return DeliverableReport(
        single_shot=has_embedded_candidates(answer_sdp),
        has_relay=has_relay_candidate(answer_sdp),
        only_relay=only_relay_candidates(answer_sdp),
        setup_role_ok=setup_role_ok(offer_sdp, answer_sdp),
        codec_ok=codec_ok(answer_sdp),
        answer_role=extract_setup_role(answer_sdp),
        answer_codecs=audio_codecs(answer_sdp),
    )
