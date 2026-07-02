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

import { ROUTE_CHAT, ROUTE_VOICENOTE, normalizeMessage, parseCallEvent, routeOf } from './lib/dispatch.js';
import type { RawEvent } from './lib/dispatch.js';
import { handleChatMessage } from './lib/textHandler.js';
import { handleVoiceNote } from './lib/audioHandler.js';
import { handleCallEvent } from './lib/callsSignaling.js';
import { claimMessage, releaseMessage } from './lib/windowTable.js';

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
    // connect -> relay offer to the Call Runtime, return the single-shot answer
    // to Meta (pre_accept then accept), and map call-id -> pc_id; terminate ->
    // disconnect the mapped runtime pc. handleCallEvent never throws (a call is
    // not safely redeliverable mid-handshake), so it is not added to
    // batchItemFailures.
    const ev = parseCallEvent(envelope.data);
    await handleCallEvent(ev, accessToken);
    return;
  }

  // message events: normalize + route to the Chat / VoiceNotes runtime.
  const msg = normalizeMessage(envelope.data);
  const route = routeOf(msg);
  if (route !== ROUTE_CHAT && route !== ROUTE_VOICENOTE) {
    console.debug(`ignoring message of type ${msg.msgType}`);
    return;
  }
  if (!accessToken) {
    throw new Error(`access token unavailable; cannot serve ${route} message`);
  }

  // Idempotency (async-reply-delivery R6): claim the WhatsApp message id BEFORE
  // dispatch so an SQS at-least-once redelivery does not produce a second turn.
  // A duplicate is skipped; a dispatch failure RELEASES the claim so the retry
  // can re-claim and re-dispatch.
  const claim = await claimMessage(msg.messageId);
  if (claim === 'duplicate') {
    console.info(`skipping duplicate delivery of message ${msg.messageId}`);
    return;
  }

  try {
    if (route === ROUTE_CHAT) {
      await handleChatMessage(msg, accessToken);
    } else {
      await handleVoiceNote(msg, accessToken);
    }
  } catch (err) {
    // Dispatch failed (the runtime did not accept the turn). Release the claim
    // so the SQS redelivery can re-claim, then rethrow so this record is
    // reported as a batch item failure and redelivered / DLQ'd.
    await releaseMessage(msg.messageId);
    throw err;
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
