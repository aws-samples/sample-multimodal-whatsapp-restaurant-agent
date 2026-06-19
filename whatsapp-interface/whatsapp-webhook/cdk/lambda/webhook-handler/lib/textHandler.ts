// Text / multimodal branch for the Chat Runtime (Task 8.1).
//
// Handles one inbound text / image / document message: derive Customer_Id (R3),
// gate input (R4.2), update the 24-hour window (R6.3), download supported
// attachments via the Media API (R4.8) and nudge a resend for unsupported ones
// (R4.9), invoke the Chat Runtime with session_id = customer_id (R5.1), and
// relay the reply (R4.4). Pure helpers (textWithinBounds, novaFormatFor,
// shouldInvoke) are separated so the routing/gate property test (Property 4)
// needs no AWS.

import {
  PepperUnavailableError,
  PhoneNormalizationError,
  deriveForEvent,
} from './customerId.js';
import type { InboundMessage } from './dispatch.js';
import { ROUTE_CHAT, routeOf } from './dispatch.js';
import { downloadMedia } from './mediaApi.js';
import { invokeChat } from './runtimeClient.js';
import { sendText, sendTypingIndicator } from './whatsappClient.js';
import { updateInbound } from './windowTable.js';

export const MAX_TEXT_CHARS = 4096; // R4.2

const COULD_NOT_PROCESS =
  'Sorry, I could not process that message. Please send your order as text, a photo, or a PDF.';
const RESEND_UNSUPPORTED =
  'I could not open that attachment. Please resend it as a photo (JPG/PNG) or a PDF, and I will help with the rest of your message.';

// mime_type -> Nova Pro Converse format. Missing => unsupported (R4.9).
const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const DOCUMENT_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Pure gate (R4.2 / Property 4): >= 1 non-whitespace char and <= 4096 chars. */
export function textWithinBounds(text: string | undefined): boolean {
  if (text === undefined || text === null) return false;
  if (text.length > MAX_TEXT_CHARS) return false;
  return text.trim().length > 0;
}

/** Map an attachment mime type to a Nova Pro Converse format, or null if
 *  unsupported (R4.9). kind is 'image' | 'document'. */
export function novaFormatFor(kind: string, mimeType: string): string | null {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (kind === 'image') return IMAGE_MIME[mime] ?? null;
  if (kind === 'document') return DOCUMENT_MIME[mime] ?? null;
  return null;
}

/** Pure routing gate: invoke iff there is usable content. Over-long text is
 *  always rejected (R4.2); a supported attachment counts as content. */
export function shouldInvoke(msg: InboundMessage): boolean {
  if ((msg.text ?? '').length > MAX_TEXT_CHARS) return false;
  if ((msg.msgType === 'image' || msg.msgType === 'document') && novaFormatFor(msg.msgType, msg.mimeType)) {
    return true;
  }
  return textWithinBounds(msg.text);
}

export interface HandleResult {
  status: string;
  customerId?: string;
  unsupported?: boolean;
  reason?: string;
}

/** Orchestrate one Chat-Runtime turn. Customer-facing output goes via the
 *  Messages API; the returned status is for metrics/tests. */
export async function handleChatMessage(
  msg: InboundMessage,
  accessToken: string,
): Promise<HandleResult> {
  if (routeOf(msg) !== ROUTE_CHAT) {
    return { status: 'ignored', reason: 'not_chat_route' };
  }

  // 1. Derive Customer_Id (R3). Non-normalizable sender -> do nothing (R3.5).
  let customerId: string;
  try {
    customerId = await deriveForEvent(msg.sender);
  } catch (err) {
    if (err instanceof PhoneNormalizationError) {
      console.warn('sender could not be normalized to E.164; dropping message');
      return { status: 'rejected', reason: 'bad_sender' };
    }
    if (err instanceof PepperUnavailableError) {
      console.error('pepper unavailable; cannot derive Customer_Id (R3.6)');
      return { status: 'error', reason: 'pepper_unavailable' };
    }
    throw err;
  }

  // 2. Input gate (R4.2): no usable content -> could-not-process, no invoke.
  if (!shouldInvoke(msg)) {
    await sendText(msg.sender, COULD_NOT_PROCESS, accessToken, customerId);
    return { status: 'gated', customerId };
  }

  // 3. Update the 24-hour window on this inbound (R6.3), recording the sender's
  //    wa_id so the order-notifier (Task 27) can message them proactively.
  if (msg.timestamp !== null) {
    await updateInbound(customerId, msg.timestamp, msg.sender);
  }

  // Show the "typing..." indicator now that we know we will invoke the runtime,
  // so the customer sees activity during the (few-second) model turn. Best-
  // effort: never blocks or fails the reply.
  await sendTypingIndicator(msg.messageId, accessToken);

  // 4. Build the multimodal payload; download supported attachments (R4.8),
  //    flag unsupported ones for a resend nudge (R4.9).
  const images: Array<{ format: string; bytes_b64: string }> = [];
  const documents: Array<{ format: string; name: string; bytes_b64: string }> = [];
  let unsupported = false;
  if ((msg.msgType === 'image' || msg.msgType === 'document') && msg.mediaId) {
    const fmt = novaFormatFor(msg.msgType, msg.mimeType);
    if (fmt === null) {
      unsupported = true;
    } else {
      const data = await downloadMedia(msg.mediaId, accessToken);
      if (data === null) {
        unsupported = true; // a failed download is treated like an unusable attachment
      } else {
        const b64 = data.toString('base64');
        if (msg.msgType === 'image') {
          images.push({ format: fmt, bytes_b64: b64 });
        } else {
          documents.push({ format: fmt, name: msg.filename || 'document', bytes_b64: b64 });
        }
      }
    }
  }

  if (unsupported) {
    await sendText(msg.sender, RESEND_UNSUPPORTED, accessToken, customerId);
  }

  // 5. Invoke the Chat Runtime and relay the reply (R4.4).
  const result = await invokeChat({
    session_id: customerId, // R5.1
    customer_id: customerId,
    text: msg.text ?? '',
    images,
    documents,
  });
  if (!result || !result.reply) {
    console.warn(`no reply from Chat Runtime for ${customerId}`);
    await sendText(msg.sender, COULD_NOT_PROCESS, accessToken, customerId);
    return { status: 'no_reply', customerId };
  }

  await sendText(msg.sender, result.reply, accessToken, customerId);
  return { status: 'ok', customerId, unsupported };
}
