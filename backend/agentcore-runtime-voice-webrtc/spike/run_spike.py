#!/usr/bin/env python3
"""Single-shot-ICE interop spike runner (Task 14.1).

Takes a Meta SDP OFFER, fetches KVS TURN credentials, produces a SINGLE-SHOT
SDP answer with the relay candidate embedded, and prints a deliverable report.

Usage:
    # offer SDP from a file captured from a Meta sandbox `calls` connect event:
    KVS_CHANNEL_NAME=wa-voice-spike python run_spike.py --offer offer.sdp

    # or piped on stdin:
    cat offer.sdp | KVS_CHANNEL_NAME=wa-voice-spike python run_spike.py

Requires aiortc + PyAV + boto3 (see requirements.txt) and live AWS credentials
with KVS WebRTC access. The four spike deliverables:

  (a) single-shot answer with embedded ICE candidates   -> asserted locally here
  (b) Meta completes ICE against the KVS TURN relay      -> observed when you
      POST this answer back to Meta (pre_accept/accept) and the call connects
  (c) DTLS setup-role negotiation (answerer active)      -> asserted locally here
  (d) Opus / G.711 codec negotiation                     -> asserted locally here

Exit code 0 iff the locally-checkable deliverables (a, c, d) pass. Deliverable
(b) is confirmed by the live call connecting end to end - see README.md.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

import kvs_turn
import sdp_inspect
from single_shot_answerer import create_single_shot_answer


def _read_offer(path: str | None) -> str:
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    return sys.stdin.read()


def _print_report(report: sdp_inspect.DeliverableReport) -> None:
    print("\n=== single-shot-ICE deliverable report ===", file=sys.stderr)
    print(f"(a) single-shot embedded candidates : {report.single_shot}", file=sys.stderr)
    print(f"    relay candidate present         : {report.has_relay}", file=sys.stderr)
    print(f"    relay-only (turnOnly)           : {report.only_relay}", file=sys.stderr)
    print(f"(c) DTLS answerer role committed    : {report.setup_role_ok} (a=setup:{report.answer_role})", file=sys.stderr)
    print(f"(d) codec negotiated (Opus/G.711)   : {report.codec_ok} ({report.answer_codecs})", file=sys.stderr)
    print(f"--> structural deliverables (a,c,d) : {'PASS' if report.structural_pass else 'FAIL'}", file=sys.stderr)
    print("(b) Meta ICE completion is confirmed only by a live call connecting.", file=sys.stderr)


async def _main_async(args: argparse.Namespace) -> int:
    offer_sdp = _read_offer(args.offer)
    if not sdp_inspect.has_audio_media(offer_sdp):
        print("ERROR: offer has no audio m-line", file=sys.stderr)
        return 2

    channel = args.channel or kvs_turn.channel_name_from_env()
    ice_servers = kvs_turn.get_ice_servers(channel, region=args.region)
    if not ice_servers:
        print("ERROR: KVS returned no TURN ice servers", file=sys.stderr)
        return 3

    result = await create_single_shot_answer(
        offer_sdp, "offer", ice_servers, turn_only=not args.allow_all_candidates
    )
    try:
        answer_sdp = result["sdp"]
        # The SDP answer goes to stdout so it can be piped to the Meta POST.
        print(answer_sdp)
        report = sdp_inspect.analyze_answer(offer_sdp, answer_sdp)
        _print_report(report)
        return 0 if report.structural_pass else 1
    finally:
        await result["pc"].close()


def main() -> int:
    parser = argparse.ArgumentParser(description="single-shot-ICE Meta interop spike")
    parser.add_argument("--offer", help="path to the Meta SDP offer (default: stdin)")
    parser.add_argument("--channel", help="KVS signaling channel name (default: $KVS_CHANNEL_NAME)")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument(
        "--allow-all-candidates",
        action="store_true",
        help="do NOT strip to relay-only (debug: keep host/srflx candidates too)",
    )
    args = parser.parse_args()
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
