// WhatsApp Webhook Worker Lambda - SQS-triggered (Task 8.7, async R2.5).
//
// Consumes the messages the Ingest Lambda enqueued and does the slow per-message
// work off the request path: dispatch by type (text/image/document -> Chat
// Runtime; audio -> VoiceNotes Runtime, Task 12; other -> ignore), derive
// Customer_Id, update the 24-hour window, download attachments, invoke the
// runtime, send the reply (inside textHandler).
//
// Partial-batch failure: the SQS event-source mapping uses
// reportBatchItemFailures, so this returns the message ids it could not process
// under batchItemFailures. SQS redelivers only those; after maxReceiveCount (3)
// a poison message lands in the DLQ. The Access_Token is loaded once and never
// logged.

import { ROUTE_CHAT, ROUTE_VOICENOTE, normalizeMessage, routeOf } from './lib/dispatch.js';
import type { RawEvent } from './lib/dispatch.js';
import { handleChatMessage } from './lib/textHandler.js';
import { handleVoiceNote } from './lib/audioHandler.js';

let accessTokenCache: string | undefined;

async function loadAccessToken(): Promise<string> {
  if (accessTokenCache !== undefined) return accessTokenCache;
  const name = process.env.ACCESS_TOKEN_SECRET_NAME;
  if (!name) {
    console.error('ACCESS_TOKEN_SECRET_NAME not set; cannot load the Access_Token');
    return '';
  }
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const resp = await client.send(new GetSecretValueCommand({ SecretId: name }));
    accessTokenCache = resp.SecretString ?? '';
  } catch (err) {
    console.error(`failed to load the Access_Token from secret ${name}: ${String(err)}`);
    return '';
  }
  return accessTokenCache;
}

async function processRecord(record: any, accessToken: string): Promise<void> {
  const envelope = JSON.parse(record.body) as RawEvent;

  // calls events: the signaling proxy runs HERE in the worker (Task 17), not in
  // the ingest. The SDP answer is delivered via a separate POST /calls
  // (pre_accept/accept), so calls can be handled fully async off the queue.
  if (envelope.kind === 'call') {
    console.info('calls event received; the calls signaling proxy is Task 17 (worker)');
    // TODO(Task 17): relay offer to the Call Runtime (action=offer, turnOnly),
    // return the single-shot answer to Meta via POST /<phone-number-id>/calls
    // pre_accept then accept; on terminate, disconnect the runtime session.
    return;
  }

  // message events: normalize + route to the Chat / VoiceNotes runtime.
  const msg = normalizeMessage(envelope.data);
  const route = routeOf(msg);
  if (route === ROUTE_CHAT) {
    if (!accessToken) throw new Error('access token unavailable; cannot serve chat message');
    await handleChatMessage(msg, accessToken);
  } else if (route === ROUTE_VOICENOTE) {
    if (!accessToken) throw new Error('access token unavailable; cannot serve voice note');
    await handleVoiceNote(msg, accessToken);
  } else {
    console.debug(`ignoring message of type ${msg.msgType}`);
  }
}

interface BatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

export async function handler(event: any): Promise<BatchResponse> {
  const records: any[] = event?.Records ?? [];
  if (records.length === 0) return { batchItemFailures: [] };

  const accessToken = await loadAccessToken();
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    const messageId = record?.messageId ?? '';
    try {
      await processRecord(record, accessToken);
    } catch (err) {
      console.error(`failed to process SQS record ${messageId}: ${String(err)}`);
      failures.push({ itemIdentifier: messageId });
    }
  }
  return { batchItemFailures: failures };
}

/** Test helper - clears the module-level access-token cache. */
export function resetAccessTokenForTests(): void {
  accessTokenCache = undefined;
}
