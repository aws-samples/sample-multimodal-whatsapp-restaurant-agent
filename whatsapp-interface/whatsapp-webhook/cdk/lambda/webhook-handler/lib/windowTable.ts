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

/** Set the window start for a customer to ts (R6.3). Returns true on success;
 *  a failure is logged but never breaks message handling. */
export async function updateInbound(customerId: string, ts: number): Promise<boolean> {
  const name = process.env.WINDOW_TABLE_NAME;
  if (!name) return false;
  try {
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    await db.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          customerId: { S: customerId },
          lastInboundTs: { N: String(ts) },
          ttl: { N: String(ts + TTL_SECONDS) },
        },
      }),
    );
    return true;
  } catch (err) {
    console.warn(`window update failed for ${customerId}: ${String(err)}`);
    return false;
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
