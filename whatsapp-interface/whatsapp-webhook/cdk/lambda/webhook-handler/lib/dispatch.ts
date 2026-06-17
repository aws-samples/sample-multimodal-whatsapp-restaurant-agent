// Pure parsing + classification of the Meta webhook (Task 8.1 / 8.7 / 3.3).
//
// Side-effect-free. The Ingest Lambda stays generic: it does NOT parse business
// fields, it only splits the validated webhook into per-event envelopes
// (messages + calls) and enqueues them. The Worker Lambda then NORMALIZES and
// ROUTES each envelope: text/image/document -> Chat Runtime; audio -> VoiceNotes
// Runtime; calls -> the calls signaling proxy (Task 17, in the worker). This
// keeps the front door to "authenticate -> enqueue -> 200" only.

export const ROUTE_CHAT = 'chat';
export const ROUTE_VOICENOTE = 'voicenote';
export const ROUTE_CALL = 'call';
export const ROUTE_IGNORE = 'ignore';

const CHAT_TYPES = new Set(['text', 'image', 'document']);

/** A tagged raw event the ingest enqueues; the worker routes by `kind`. */
export interface RawEvent {
  kind: 'message' | 'call';
  data: any;
}

export interface InboundMessage {
  msgType: string;
  sender: string;
  messageId: string;
  timestamp: number | null;
  text: string;
  mediaId: string;
  mimeType: string;
  filename: string;
}

export function routeOf(msg: InboundMessage): string {
  if (CHAT_TYPES.has(msg.msgType)) return ROUTE_CHAT;
  if (msg.msgType === 'audio') return ROUTE_VOICENOTE;
  return ROUTE_IGNORE;
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Yield tagged raw events (messages + calls) from a parsed webhook body, with
 *  no normalization. This is the ingest's only "parsing": it separates the
 *  delivery into per-event envelopes so the worker can route each one and the
 *  SQS DLQ can isolate a single poison event. */
export function iterRawEvents(body: any): RawEvent[] {
  const out: RawEvent[] = [];
  const entries = body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const field = change?.field;
      const value = change?.value ?? {};
      if (field === 'messages') {
        for (const msg of value?.messages ?? []) out.push({ kind: 'message', data: msg });
      } else if (field === 'calls') {
        // Meta delivers calls events (connect / pre_accept / accept / reject /
        // terminate) on the `calls` field. The worker runs the signaling proxy.
        for (const call of value?.calls ?? []) out.push({ kind: 'call', data: call });
      }
    }
  }
  return out;
}

/** A parsed WhatsApp `calls` webhook event (pure projection of the raw object).
 *  `sdp`/`sdpType` are populated for `connect` events (the offer); empty
 *  otherwise. Phone numbers are intentionally captured but callers must treat
 *  them as PII (never log above DEBUG, per the privacy posture). */
export interface CallEvent {
  id: string;
  event: string; // connect | terminate | ... (Meta's `event` field)
  from: string;
  to: string;
  sdpType: string; // "offer" on connect
  sdp: string; // RFC 8866 SDP, present on connect
  status: string; // present on terminate (COMPLETED | FAILED)
}

/** Pure: project a raw Meta `calls[]` object into a CallEvent. The connect
 *  event carries the caller's SDP offer at `session.sdp` (`session.sdp_type ==
 *  "offer"`); terminate carries a `status`. */
export function parseCallEvent(call: any): CallEvent {
  const session = call?.session ?? {};
  return {
    id: call?.id ?? '',
    event: call?.event ?? '',
    from: call?.from ?? '',
    to: call?.to ?? '',
    sdpType: session?.sdp_type ?? '',
    sdp: session?.sdp ?? '',
    status: call?.status ?? '',
  };
}

/** Normalize a single raw WhatsApp message into an InboundMessage. Public so
 *  the Worker Lambda can normalize a message it dequeued from SQS. */
export function normalizeMessage(msg: any): InboundMessage {
  const msgType: string = msg?.type ?? '';
  const im: InboundMessage = {
    msgType,
    sender: msg?.from ?? '',
    messageId: msg?.id ?? '',
    timestamp: toInt(msg?.timestamp),
    text: '',
    mediaId: '',
    mimeType: '',
    filename: '',
  };
  if (msgType === 'text') {
    im.text = msg?.text?.body ?? '';
  } else if (msgType === 'image') {
    im.mediaId = msg?.image?.id ?? '';
    im.mimeType = msg?.image?.mime_type ?? '';
    im.text = msg?.image?.caption ?? '';
  } else if (msgType === 'document') {
    im.mediaId = msg?.document?.id ?? '';
    im.mimeType = msg?.document?.mime_type ?? '';
    im.text = msg?.document?.caption ?? '';
    im.filename = msg?.document?.filename ?? '';
  } else if (msgType === 'audio') {
    im.mediaId = msg?.audio?.id ?? '';
    im.mimeType = msg?.audio?.mime_type ?? '';
  }
  return im;
}

/** Convenience for callers that have the whole body (e.g. tests): the message
 *  envelopes only, normalized. */
export function parseMessages(body: any): InboundMessage[] {
  return iterRawEvents(body)
    .filter((e) => e.kind === 'message')
    .map((e) => normalizeMessage(e.data));
}
