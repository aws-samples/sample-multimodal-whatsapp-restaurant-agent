// 24-hour customer service window state (Task 8.1 update; Task 9 routing).
//
// The webhook stack creates the "Last Inbound" DynamoDB table (partition key
// customerId, attributes lastInboundTs epoch seconds + ttl). Refresh the window
// on every inbound message (R6.3); the reply layer (Task 9) reads it to choose
// free-form vs Utility template (R6.1/R6.2). Keyed only by customer_id.

export const WINDOW_SECONDS = 86400; // 24h (R6.3)
const TTL_SECONDS = WINDOW_SECONDS + 3600;

/** Pure: window open iff a prior inbound exists and now - ts < 86400
 *  (R6.1/R6.2/R6.5). Never-opened (null) -> closed. */
export function isWindowOpen(lastInboundTs: number | null, now: number): boolean {
  if (lastInboundTs === null) return false;
  const delta = now - lastInboundTs;
  return delta >= 0 && delta < WINDOW_SECONDS;
}

async function client() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  return new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
}

/** Set the window start for a customer to ts (R6.3), and record the recipient
 *  `waId` (the WhatsApp wa_id / E.164) so a proactive notifier (Task 27) can
 *  message the customer later - the `wa-` customer_id is a non-reversible hash,
 *  so the destination phone must be persisted at inbound time. The phone lives
 *  ONLY here (encrypted at rest, TTL'd) to keep the PII surface minimal.
 *  Returns true on success; a failure is logged but never breaks handling. */
export async function updateInbound(customerId: string, ts: number, waId?: string): Promise<boolean> {
  const name = process.env.WINDOW_TABLE_NAME;
  if (!name) return false;
  try {
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    const item: Record<string, { S: string } | { N: string }> = {
      customerId: { S: customerId },
      lastInboundTs: { N: String(ts) },
      ttl: { N: String(ts + TTL_SECONDS) },
    };
    if (waId) {
      item.waId = { S: waId };
    }
    await db.send(new PutItemCommand({ TableName: name, Item: item }));
    return true;
  } catch (err) {
    console.warn(`window update failed for ${customerId}: ${String(err)}`);
    return false;
  }
}

/** Customer contact + window state read by the proactive notifier (Task 27). */
export interface CustomerContact {
  /** Recipient wa_id / E.164 to send to, or null if not recorded. */
  waId: string | null;
  /** Epoch seconds of the last inbound, or null if never opened. */
  lastInboundTs: number | null;
}

/** Read the recipient `waId` + `lastInboundTs` for a customer, so the notifier
 *  can decide window state and address the message. Returns nulls on
 *  absent/failed reads (the notifier then skips - never throws). */
export async function getContact(customerId: string): Promise<CustomerContact> {
  const name = process.env.WINDOW_TABLE_NAME;
  if (!name) return { waId: null, lastInboundTs: null };
  try {
    const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    const resp = await db.send(
      new GetItemCommand({ TableName: name, Key: { customerId: { S: customerId } } }),
    );
    const n = resp.Item?.lastInboundTs?.N;
    return {
      waId: resp.Item?.waId?.S ?? null,
      lastInboundTs: n ? Number(n) : null,
    };
  } catch (err) {
    console.warn(`window contact read failed for ${customerId}: ${String(err)}`);
    return { waId: null, lastInboundTs: null };
  }
}

/** Read the stored window start for a customer, or null if absent/failed. */
export async function getLastInboundTs(customerId: string): Promise<number | null> {
  const name = process.env.WINDOW_TABLE_NAME;
  if (!name) return null;
  try {
    const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    const resp = await db.send(
      new GetItemCommand({ TableName: name, Key: { customerId: { S: customerId } } }),
    );
    const n = resp.Item?.lastInboundTs?.N;
    return n ? Number(n) : null;
  } catch (err) {
    console.warn(`window read failed for ${customerId}: ${String(err)}`);
    return null;
  }
}
