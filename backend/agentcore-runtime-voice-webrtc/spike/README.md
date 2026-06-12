# Single-shot-ICE + Meta WebRTC interop spike (Task 14)

This is the **GATE** for Phase 3 (voice calls). It resolves the design's #1
risk: Meta's Calling API provides **no trickle-ICE return channel**, so the SDP
answer handed back to Meta must be **single-shot** - every ICE candidate
(including the TURN relay candidate) embedded directly in the answer SDP.

No voice-call implementation task (15-19) should land until the four
deliverables below are confirmed.

## What this spike proves

| # | Deliverable | How it is verified |
|---|---|---|
| (a) | Single-shot answer with embedded ICE candidates | **Locally** by `sdp_inspect` (the produced answer has `a=candidate` lines, including a `typ relay`). |
| (b) | Meta completes ICE against the KVS TURN relay candidates | **Live only** - confirmed when the answer is POSTed back to Meta (`pre_accept`/`accept`) and the call connects with two-way media. |
| (c) | DTLS setup-role negotiation, runtime as answerer | **Locally** - an offer `a=setup:actpass` is answered with `a=setup:active`/`passive`. |
| (d) | Opus (or G.711 PCMU/PCMA fallback) codec negotiation | **Locally** - the answer's audio m-line keeps an accepted codec. |

`run_spike.py` asserts (a), (c), (d) and exits non-zero on any failure.
Deliverable (b) is observed by a real call connecting end to end.

## Why aiortc is already (mostly) single-shot

`aiortc` gathers ICE candidates **during `setLocalDescription`** and embeds them
in `pc.localDescription.sdp` - it does not trickle by default. The spike adds an
explicit wait for `iceGatheringState == "complete"` to guarantee the relay
candidate is present before the answer is returned, and (with `turnOnly`) strips
non-relay candidates so the answer advertises only the relay path. The runtime
has no public IP (VPC network mode), so the relay candidate is the only usable
one anyway.

## Running it

Prerequisites: `pip install -r requirements.txt`, AWS credentials with KVS
WebRTC access, and a Meta sandbox call whose `connect` event SDP offer you have
captured.

```bash
# 1. Capture the SDP offer from a Meta `calls` connect webhook (session.sdp)
#    into offer.sdp.
# 2. Produce the single-shot answer + deliverable report:
KVS_CHANNEL_NAME=wa-voice-spike python run_spike.py --offer offer.sdp > answer.sdp
# 3. POST answer.sdp back to Meta:
#      POST /<PHONE_NUMBER_ID>/calls  action=pre_accept (sdp=answer)
#      POST /<PHONE_NUMBER_ID>/calls  action=accept     (sdp=answer)
#    The call connecting with two-way audio confirms deliverable (b).
```

## The captured contract (input to Tasks 16-19)

Once the live run passes, these are the proven handshake parameters the Call
Runtime implementation (Tasks 16-19) must preserve:

- **Answer is single-shot**: wait for `iceGatheringState == "complete"`, never
  defer to a trickle channel (Task 16.2).
- **turnOnly**: advertise relay candidates only; the runtime has no public IP
  (Task 16.1 VPC mode, Task 16.2 answerer).
- **DTLS role**: runtime is the answerer and commits to `active`/`passive` for
  an `actpass` offer (Task 16.2 / Task 18).
- **Codec**: prefer Opus, accept G.711 (PCMU/PCMA) fallback; reject an offer
  advertising neither (Task 18.1, Property 12).
- **TURN creds**: `GetIceServerConfig(Service=TURN)` on a `SINGLE_MASTER` KVS
  channel (Task 15.1 promotes `kvs_turn.py` into `agent/`).

## Files

- `sdp_inspect.py` - pure SDP analysis (no aiortc/AWS); deliverables (a)(c)(d).
- `kvs_turn.py` - KVS `GetIceServerConfig` TURN-credential fetch (boto3, lazy).
- `single_shot_answerer.py` - the aiortc answerer reworked to single-shot ICE.
- `run_spike.py` - CLI: offer in -> single-shot answer + deliverable report.
- `tests/` - Hypothesis/unit tests for the pure SDP analysis.

This `spike/` directory is intentionally standalone and is **not** deployed; the
proven pieces are promoted into the Call Runtime (`agent/`) in Tasks 15-19.
