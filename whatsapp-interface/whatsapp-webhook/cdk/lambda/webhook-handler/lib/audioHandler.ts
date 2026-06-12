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
import { sendAudio, sendText } from './whatsappClient.js';
import { updateInbound } from './windowTable.js';

const CHANNEL = 'voicenote';

// R7.6: the model could not understand / produced no usable audio.
const COULD_NOT_UNDERSTAND =
  'Sorry, I could not understand that voice note. Please try again, or send your order as a text message.';
// R7.7/R7.8: we could not fetch the note's audio at all.
const COULD_NOT_DOWNLOAD =
  'Sorry, I could not get that voice note. Please resend it, or send your order as a text message.';

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
  //    discard and ask for a resend or text (R7.7/R7.8).
  if (!msg.mediaId) {
    await sendText(msg.sender, COULD_NOT_DOWNLOAD, accessToken, customerId, CHANNEL);
    return { status: 'no_media', customerId };
  }
  const ogg = await downloadVoiceNote(msg.mediaId, accessToken);
  if (!ogg) {
    await sendText(msg.sender, COULD_NOT_DOWNLOAD, accessToken, customerId, CHANNEL);
    return { status: 'download_failed', customerId };
  }

  // 4. Invoke the VoiceNotes Runtime (R7.3): Ogg in, Ogg out. session=customer.
  const result = await invokeVoiceNote({
    session_id: customerId, // R5.1
    customer_id: customerId,
    audio_b64: ogg.toString('base64'),
  });

  // 5a. No usable audio reply (R7.6): send the runtime's fallback text, or our
  //     default could-not-understand message.
  if (!result || !result.audio_b64) {
    const fallback = (result && result.fallback_text) || COULD_NOT_UNDERSTAND;
    await sendText(msg.sender, fallback, accessToken, customerId, CHANNEL);
    return { status: 'no_audio', customerId };
  }

  // 5b. Voice reply (R7.5): send the Ogg Opus as a WhatsApp audio message; on a
  //     send failure fall back to the could-not-understand text.
  const replyOgg = Buffer.from(result.audio_b64, 'base64');
  const sent = await sendAudio(msg.sender, replyOgg, accessToken, customerId, CHANNEL);
  if (!sent) {
    await sendText(msg.sender, COULD_NOT_UNDERSTAND, accessToken, customerId, CHANNEL);
    return { status: 'audio_send_failed', customerId };
  }
  return { status: 'ok', customerId };
}
