// Voice-note branch for the VoiceNotes Runtime (Task 12.5, R7).
//
// Handles one inbound WhatsApp voice note (type: audio): derive Customer_Id
// (R3), update the 24-hour window (R6.3), download the Ogg Opus via the Media
// API with bounded timeouts (R7.1/R7.2), invoke the VoiceNotes Runtime with
// session_id = customer_id (R7.3), and reply with a WhatsApp AUDIO (voice)
// message (R7.5). Failure modes:
//   - Media URL/download failure, timeout, or oversize (R7.7/R7.8): discard any
//     partial data and ask the customer to resend or send text.
//   - The bounded Sonic session yields no usable audio (R7.6): send the
//     could-not-understand TEXT fallback.
//   - The audio reply send fails: fall back to the could-not-understand TEXT.
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
import type { VoiceNoteResult } from './runtimeClient.js';
import { sendAudio, sendText } from './whatsappClient.js';
import { updateInbound } from './windowTable.js';

const CHANNEL = 'voicenote';

// R7.6: the model could not understand / produced no usable audio.
export const COULD_NOT_UNDERSTAND =
  'Sorry, I could not understand that voice note. Please try again, or send your order as a text message.';
// R7.7/R7.8: we could not fetch the note's audio at all.
export const COULD_NOT_DOWNLOAD =
  'Sorry, I could not get that voice note. Please resend it, or send your order as a text message.';

/** The reply the voice-note path should produce: a voice (audio) message, or a
 *  text fallback with a reason. */
export type VoiceReply =
  | { kind: 'audio'; oggB64: string }
  | { kind: 'text'; text: string; reason: string };

/** Pure reply-selection (Task 12.5 / 12.7, R7.6/R7.7/R7.8): given whether the
 *  note had media, whether the download succeeded, and the runtime's invoke
 *  result, decide the reply. Audio iff the runtime returned audio bytes;
 *  otherwise a text fallback (download message when the note could not be
 *  fetched, could-not-understand or the runtime's fallback otherwise). Never
 *  returns audio for a missing/failed download or an empty invoke result. */
export function chooseVoiceReply(input: {
  hasMedia: boolean;
  downloaded: boolean;
  invoke: VoiceNoteResult | null;
}): VoiceReply {
  if (!input.hasMedia) return { kind: 'text', text: COULD_NOT_DOWNLOAD, reason: 'no_media' };
  if (!input.downloaded) return { kind: 'text', text: COULD_NOT_DOWNLOAD, reason: 'download_failed' };
  const inv = input.invoke;
  if (!inv || !inv.audio_b64) {
    return {
      kind: 'text',
      text: (inv && inv.fallback_text) || COULD_NOT_UNDERSTAND,
      reason: 'no_audio',
    };
  }
  return { kind: 'audio', oggB64: inv.audio_b64 };
}

export interface HandleResult {
  status: string;
  customerId?: string;
  reason?: string;
}

/** Orchestrate one VoiceNotes-Runtime turn. Customer-facing output goes via the
 *  Messages API (audio reply, or a text fallback); the returned status is for
 *  metrics/tests. */
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
  //    window open so the voice reply can be sent free-form (R7.5).
  if (msg.timestamp !== null) {
    await updateInbound(customerId, msg.timestamp);
  }

  // 3. Download the Ogg Opus voice note (R7.1/R7.2). Any failure/oversize ->
  //    null (R7.7/R7.8). 4. Invoke the VoiceNotes Runtime only if we have audio
  //    (R7.3): Ogg in, Ogg out, session = customer (R5.1).
  const ogg = msg.mediaId ? await downloadVoiceNote(msg.mediaId, accessToken) : null;
  const invoke = ogg
    ? await invokeVoiceNote({
        session_id: customerId, // R5.1
        customer_id: customerId,
        audio_b64: ogg.toString('base64'),
      })
    : null;

  // 5. Decide the reply (pure): audio reply, or a text fallback (R7.6/R7.7/R7.8).
  const reply = chooseVoiceReply({ hasMedia: !!msg.mediaId, downloaded: !!ogg, invoke });
  if (reply.kind === 'text') {
    await sendText(msg.sender, reply.text, accessToken, customerId, CHANNEL);
    return { status: reply.reason, customerId };
  }

  // 6. Voice reply (R7.5): send the Ogg Opus as a WhatsApp audio message; on a
  //    send failure fall back to the could-not-understand text.
  const replyOgg = Buffer.from(reply.oggB64, 'base64');
  const sent = await sendAudio(msg.sender, replyOgg, accessToken, customerId, CHANNEL);
  if (!sent) {
    await sendText(msg.sender, COULD_NOT_UNDERSTAND, accessToken, customerId, CHANNEL);
    return { status: 'audio_send_failed', customerId };
  }
  return { status: 'ok', customerId };
}
