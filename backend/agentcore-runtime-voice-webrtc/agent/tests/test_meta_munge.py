"""Tests for the Meta answer-SDP munge (Task 17 fix for error 138008).

Feature: whatsapp-restaurant-ai-host

single_shot_answerer imports aiortc/av lazily (only inside
create_single_shot_answer), so the pure SDP helpers _munge_for_meta and
_first_relay_endpoint import and test without the native media deps.
"""
from __future__ import annotations

import single_shot_answerer as ssa

# A representative aiortc answer (CRLF), exactly the shape Meta rejected with
# 138008: three fingerprints, a link-local c=, a link-local m= port, recvonly,
# and a single typ relay candidate carrying the routable endpoint.
ANSWER = (
    "v=0\r\n"
    "o=- 3990726499 3990726499 IN IP4 0.0.0.0\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "a=group:BUNDLE audio\r\n"
    "m=audio 60618 UDP/TLS/RTP/SAVPF 111\r\n"
    "c=IN IP4 169.254.0.2\r\n"
    "a=recvonly\r\n"
    "a=mid:audio\r\n"
    "a=rtcp-mux\r\n"
    "a=rtpmap:111 opus/48000/2\r\n"
    "a=candidate:b394 1 udp 16777215 203.0.113.10 55056 typ relay raddr 169.254.1.2 rport 34499\r\n"
    "a=end-of-candidates\r\n"
    "a=ice-ufrag:CHDm\r\n"
    "a=ice-pwd:E5lIgkU5tA1hd766NZpwSz\r\n"
    "a=fingerprint:sha-256 00:68:0C:7F\r\n"
    "a=fingerprint:sha-384 29:89:80:9B\r\n"
    "a=fingerprint:sha-512 5B:03:A6:DA\r\n"
    "a=setup:active\r\n"
)


def test_first_relay_endpoint():
    assert ssa._first_relay_endpoint(ANSWER) == ("203.0.113.10", "55056")


def test_first_relay_endpoint_none_when_no_relay():
    no_relay = ANSWER.replace("typ relay", "typ host")
    assert ssa._first_relay_endpoint(no_relay) is None


def test_munge_single_sha256_fingerprint():
    out = ssa._munge_for_meta(ANSWER)
    fps = [l for l in out.split("\r\n") if l.startswith("a=fingerprint:")]
    assert fps == ["a=fingerprint:sha-256 00:68:0C:7F"]


def test_munge_rewrites_connection_and_port_to_relay():
    out = ssa._munge_for_meta(ANSWER)
    assert "c=IN IP4 203.0.113.10" in out
    assert "c=IN IP4 169.254.0.2" not in out
    m = [l for l in out.split("\r\n") if l.startswith("m=audio ")][0]
    # port (2nd token) is now the relay port; codecs preserved.
    assert m == "m=audio 55056 UDP/TLS/RTP/SAVPF 111"


def test_munge_forces_sendrecv():
    out = ssa._munge_for_meta(ANSWER)
    assert "a=sendrecv" in out
    assert "a=recvonly" not in out


def test_munge_preserves_other_lines_and_trailing():
    out = ssa._munge_for_meta(ANSWER)
    for keep in (
        "a=group:BUNDLE audio",
        "a=mid:audio",
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        "a=ice-ufrag:CHDm",
        "a=setup:active",
        "a=candidate:b394 1 udp 16777215 203.0.113.10 55056 typ relay raddr 169.254.1.2 rport 34499",
    ):
        assert keep in out
    assert out.endswith("\r\n")


def test_munge_without_relay_still_fixes_fingerprint_and_direction():
    no_relay = ANSWER.replace("typ relay", "typ host")
    out = ssa._munge_for_meta(no_relay)
    fps = [l for l in out.split("\r\n") if l.startswith("a=fingerprint:")]
    assert fps == ["a=fingerprint:sha-256 00:68:0C:7F"]
    assert "a=sendrecv" in out
    # c=/m= left untouched when there is no relay endpoint to point at.
    assert "c=IN IP4 169.254.0.2" in out
