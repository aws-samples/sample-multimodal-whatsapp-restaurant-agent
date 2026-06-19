// WhatsApp Calls signaling proxy (Task 17.1, R8).
//
// Runs in the WORKER (consuming `calls` SQS envelopes), NOT on the API Gateway
// request path. Meta delivers `calls` events (connect | pre_accept | accept |
// reject | terminate); the SDP answer is returned to Meta via a separate
// POST /<PHONE_NUMBER_ID>/calls, so the calls path is fully async.
//
// connect (offer):
//   1. relay the offer to the Call Runtime (action=offer, turnOnly) -> a
//      single-shot answer {pc_id, sdp};
//   2. record call-id -> {pc_id, session-id} in the DynamoDB mapping table (the
//      worker scales horizontally, so the mapping is NOT in memory);
//   3. return the answer to Meta via POST /calls pre_accept then accept (pre_accept
//      first begins media setup early and avoids first-word clipping).
// terminate (hangup) / failure:
//   look up the mapping and tell the runtime to disconnect the pc, then delete
//   the mapping.
//
// Session affinity: the runtimeSessionId is derived from the Meta call-id
// (callSessionId), so the connect offer and the later disconnect land on the
// same microVM regardless of which worker invocation handles each event.
//
// Deps are injected (defaulting to the real impls) so Property 10 and the unit
// tests drive the orchestration without AWS or the network.

import type { CallEvent } from './dispatch.js';
import { deriveForEvent } from './customerId.js';
import {
  callSessionId,
  invokeCallOffer,
  invokeCallDisconnect,
  type CallAnswer,
} from './runtimeClient.js';
import { sendCallAction, type CallAction } from './whatsappClient.js';
import { putMapping, getMapping, deleteMapping, type CallMapping } from './callMap.js';
import { updateInbound } from './windowTable.js';

export interface CallDeps {
  invokeCallOffer: (sessionId: string, callId: string, offerSdp: string, customerId?: string) => Promise<CallAnswer | null>;
  invokeCallDisconnect: (sessionId: string, pcId: string) => Promise<void>;
  sendCallAction: (callId: string, action: CallAction, token: string, answerSdp?: string) => Promise<boolean>;
  putMapping: (callId: string, m: CallMapping) => Promise<boolean>;
  getMapping: (callId: string) => Promise<CallMapping | null>;
  deleteMapping: (callId: string) => Promise<void>;
  deriveCustomerId: (from: string) => Promise<string>;
}

const defaultDeps: CallDeps = {
  invokeCallOffer,
  invokeCallDisconnect,
  sendCallAction,
  putMapping,
  getMapping,
  deleteMapping,
  deriveCustomerId: deriveForEvent,
};

/** Handle one parsed Meta `calls` event. Never throws (the worker treats a
 *  throw as a batch failure -> SQS redelivery; calls are not safely
 *  redeliverable mid-handshake, so we swallow and log). */
export async function handleCallEvent(
  ev: CallEvent,
  token: string,
  deps: CallDeps = defaultDeps,
): Promise<void> {
  try {
    if (ev.event === 'connect') {
      await handleConnect(ev, token, deps);
    } else if (ev.event === 'terminate') {
      await handleTerminate(ev, deps);
    } else {
      // pre_accept/accept echoes, reject, or unknown: nothing to do.
      console.debug(`calls: ignoring event=${ev.event || 'unknown'} call_id=${ev.id}`);
    }
  } catch (err) {
    console.error(`calls: handler error for call ${ev.id} event ${ev.event}: ${String(err)}`);
  }
}

async function handleConnect(ev: CallEvent, token: string, deps: CallDeps): Promise<void> {
  if (ev.sdpType !== 'offer' || !ev.sdp) {
    console.warn(`calls: connect for call ${ev.id} has no offer SDP (sdp_type=${ev.sdpType}); ignoring`);
    return;
  }

  // customer_id is best-effort here: it is threaded into the offer so the
  // runtime can build an identified Sonic session with shared-memory recall.
  // Session affinity does NOT depend on it - that is derived from the call-id.
  let customerId = '';
  try {
    customerId = await deps.deriveCustomerId(ev.from);
  } catch {
    console.warn(`calls: customer_id derivation failed for call ${ev.id} (continuing without it)`);
  }

  // Record the caller's wa_id + open the 24-hour window (best-effort) so the
  // order-notifier (Task 27) can send proactive "order ready" updates for an
  // order placed during this call. Direct call (not via deps) like the message
  // handlers; in unit tests WINDOW_TABLE_NAME is unset so this no-ops.
  if (customerId) {
    try {
      await updateInbound(customerId, Math.floor(Date.now() / 1000), ev.from);
    } catch {
      /* best-effort: never block call signaling on the window write */
    }
  }

  const sessionId = callSessionId(ev.id);
  const answer = await deps.invokeCallOffer(sessionId, ev.id, ev.sdp, customerId || undefined);

  if (!answer || answer.error || !answer.sdp || !answer.pc_id) {
    console.error(
      `calls: Call Runtime did not return an answer for call ${ev.id} ` +
        `(error=${answer?.error ?? 'null'} detail=${answer?.detail ?? '-'}); terminating`,
    );
    await deps.sendCallAction(ev.id, 'terminate', token);
    return;
  }

  // Persist the mapping BEFORE accepting, so a terminate that races the accept
  // can still find the pc to disconnect.
  await deps.putMapping(ev.id, { pcId: answer.pc_id, sessionId, customerId });

  // Go straight to accept with the SDP answer. (pre_accept is skipped: it is an
  // optional early-media optimization, and sending it risks a divergent-SDP
  // rejection; a single accept is the confirmed-working path.)
  //
  // FUTURE OPTIMIZATION (open-source contributors welcome): Meta's `pre_accept`
  // action lets the device begin ICE/DTLS/SRTP media setup ~one signaling
  // round-trip EARLIER than `accept`, which can shave first-word latency and
  // reduce greeting clipping. Today's experience is already good (~1s from
  // answer to the agent speaking - that gap is dominated by the DTLS handshake
  // through the TURN relay plus Nova Sonic's first token, not by this signaling
  // step), so we ship the simpler single-`accept` path. To try the
  // optimization: send `pre_accept` with the EXACT SAME munged answer SDP first,
  // then `accept` with the same SDP (sending an identical SDP in both is what
  // avoids the divergent-SDP rejection that motivated skipping it). Measure
  // first-word latency before/after on a real call and revert if it does not
  // help. See spec task 19 (R10) - intentionally descoped for this sample.
  const accepted = await deps.sendCallAction(ev.id, 'accept', token, answer.sdp);
  if (!accepted) {
    console.error(`calls: accept failed for call ${ev.id}; disconnecting the runtime pc`);
    await deps.invokeCallDisconnect(sessionId, answer.pc_id);
    await deps.deleteMapping(ev.id);
    return;
  }
  console.info(`calls: call ${ev.id} accepted (pc_id=${answer.pc_id})`);
}

async function handleTerminate(ev: CallEvent, deps: CallDeps): Promise<void> {
  const m = await deps.getMapping(ev.id);
  if (!m) {
    // No mapping: a terminate for a call we never accepted, a duplicate, or the
    // mapping already expired. Nothing to disconnect.
    console.info(`calls: terminate for call ${ev.id} with no active mapping; nothing to disconnect`);
    return;
  }
  await deps.invokeCallDisconnect(m.sessionId, m.pcId);
  await deps.deleteMapping(ev.id);
  console.info(`calls: call ${ev.id} terminated; runtime pc ${m.pcId} disconnected`);
}
