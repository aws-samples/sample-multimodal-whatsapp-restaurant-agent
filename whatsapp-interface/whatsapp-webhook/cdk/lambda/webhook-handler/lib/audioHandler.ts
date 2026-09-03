// Voice-note branch for the VoiceNotes Runtime (async-reply-delivery Move A/B).
//
// Handles one inbound WhatsApp voice note (type: audio) as a DISPATCH-ONLY step:
// derive Customer_Id (R3), update the 24-hour window (R6.3), download the Ogg
// Opus via the Media API with bounded timeouts (the worker holds the Access
// Token, so inbound download stays here), show the initial typing indicator,
// and DISPATCH the turn to the VoiceNotes Runtime. The runtime acknowledges
// immediately and processes the turn asynchronously, DELIVERING the audio reply
// out-of-band via the Sender Lambda - the worker no longer receives the audio,
// selects the reply, or sends anything back to the customer (async-reply
// R1.3/R3.2).
//
// Reliability split (R1.5/R4.4): a transport-level dispatch failure (the runtime
// did not accept the turn) THROWS, so the SQS event-source redelivers and the
// message reaches the DLQ after maxReceiveCount. There is NO immediate customer
// fallback on a dispatch failure - a retry that succeeds would double-send; the
// runtime owns the could-not-understand / error fallbacks for an accepted turn.
//
// A failed inbound download does not block dispatch: the turn is dispatched with
// empty audio, and the runtime returns/delivers the could-not-understand text
// fallback (R7.6), keeping the worker delivery-free.
//
// This runs in the WORKER (off the SQS queue), never on the ingest request path.

import {
  PepperUnavailableError,
  PhoneNormalizationError,
  deriveForEvent,
} from './customerId.js';
import type { InboundMessage } from './dispatch.js';
import { ROUTE_VOICENOTE, routeOf } from './dispatch.js';
import { downloadVoiceNote } from './mediaApi.js';
import { invokeVoiceNote } from './runtimeClient.js';
import { sendTypingIndicator } from './whatsappClient.js';
import { updateInbound } from './windowTable.js';

export interface HandleResult {
  status: string;
  customerId?: string;
  reason?: string;
}

/** Orchestrate one VoiceNotes-Runtime DISPATCH. Customer-facing delivery (the
 *  audio reply or a text fallback) is owned by the runtime via the Sender
 *  Lambda; this returns a status for metrics/tests only. Throws on a
 *  transport-level dispatch failure so SQS retries (R1.5/R4.4). */
export async function handleVoiceNote(
  msg: InboundMessage,
  accessToken: string,
): Promise<HandleResult> {
  if (routeOf(msg) !== ROUTE_VOICENOTE) {
    return { status: 'ignored', reason: 'not_voicenote_route' };
  }

  // 1. Derive Customer_Id (R3). Non-normalizable sender -> do nothing (R3.5).
  let customerId: string;
  try {
    customerId = await deriveForEvent(msg.sender);
  } catch (err) {
    if (err instanceof PhoneNormalizationError) {
      console.warn('sender could not be normalized to E.164; dropping voice note');
      return { status: 'rejected', reason: 'bad_sender' };
    }
    if (err instanceof PepperUnavailableError) {
      console.error('pepper unavailable; cannot derive Customer_Id (R3.6)');
      return { status: 'error', reason: 'pepper_unavailable' };
    }
    throw err;
  }

  // 2. Update the 24-hour window on this inbound (R6.3). This also keeps the
  //    window open so the runtime's voice reply can be sent free-form (R7.5),
  //    and records the sender's wa_id so the Sender Lambda can resolve the
  //    recipient when it delivers the reply.
  if (msg.timestamp !== null) {
    await updateInbound(customerId, msg.timestamp, msg.sender);
  }

  // Show the "typing..." indicator now (the Cloud API has no "recording audio"
  // variant, so "typing..." is the only option). Best-effort: never blocks or
  // fails dispatch. The runtime refreshes it across a long turn (R7.2).
  await sendTypingIndicator(msg.messageId, accessToken);

  // 3. Download the Ogg Opus voice note (bounded timeouts; the worker holds the
  //    token). A failure -> empty audio; the runtime then delivers the
  //    could-not-understand fallback (R7.6) rather than the worker sending it.
  const ogg = msg.mediaId ? await downloadVoiceNote(msg.mediaId, accessToken) : null;

  // 4. DISPATCH the turn (session_id == customer_id, R5.1). The runtime acks
  //    immediately and processes + delivers asynchronously.
  const ack = await invokeVoiceNote({
    session_id: customerId,
    customer_id: customerId,
    audio_b64: ogg ? ogg.toString('base64') : '',
    message_id: msg.messageId,
  });

  if (!ack) {
    // Transport-level dispatch failure: throw so SQS redelivers and the DLQ
    // applies. No immediate fallback (would double-send across retries).
    throw new Error(`VoiceNotes Runtime dispatch failed for ${customerId}`);
  }
  if (ack.accepted === false) {
    // Permanent reject (e.g. missing_customer_id) - do not retry.
    console.warn(`VoiceNotes Runtime rejected the turn for ${customerId}: ${ack.error ?? 'unknown'}`);
    return { status: 'rejected', customerId, reason: ack.error };
  }

  return { status: 'accepted', customerId };
}
