// Call-id -> runtime mapping store (Task 17.1, Property 10).
//
// The worker is the calls signaling proxy. A `connect` event creates a peer
// connection in the Call Runtime (identified by pc_id) on a specific
// runtimeSessionId; the later `terminate` event - which may be handled by a
// DIFFERENT worker Lambda invocation (the worker scales horizontally) - must
// recover the pc_id + session id to disconnect the right peer. So the mapping
// is externalized to DynamoDB (the {prefix}-wa-call-map table), never kept in
// memory. Keyed by the Meta call-id. TTL bounds orphaned rows from calls whose
// terminate never arrives.
//
// The table is gated behind the `enableCallMappingTable` CDK context flag; when
// absent (CALL_MAPPING_TABLE_NAME unset) these helpers degrade to no-ops so a
// text-only deploy still synthesizes and runs.

const TTL_SECONDS = 4 * 3600; // bound orphaned mappings to 4h

export interface CallMapping {
  pcId: string;
  sessionId: string;
  customerId: string; // '' when caller-phone derivation was unavailable
}

async function client() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  return new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
}

/** Record call-id -> {pc_id, session-id, customer_id}. Returns true on success;
 *  a failure is logged but never breaks call handling. No-op (false) when the
 *  mapping table is not configured. */
export async function putMapping(callId: string, m: CallMapping): Promise<boolean> {
  const name = process.env.CALL_MAPPING_TABLE_NAME;
  if (!name) {
    console.warn('CALL_MAPPING_TABLE_NAME not set; call-id mapping is disabled');
    return false;
  }
  try {
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    const now = Math.floor(Date.now() / 1000);
    await db.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          metaCallId: { S: callId },
          pcId: { S: m.pcId },
          sessionId: { S: m.sessionId },
          customerId: { S: m.customerId },
          ttl: { N: String(now + TTL_SECONDS) },
        },
      }),
    );
    return true;
  } catch (err) {
    console.warn(`call-map put failed for call ${callId}: ${String(err)}`);
    return false;
  }
}

/** Read the mapping for a call-id, or null if absent/failed/unconfigured. */
export async function getMapping(callId: string): Promise<CallMapping | null> {
  const name = process.env.CALL_MAPPING_TABLE_NAME;
  if (!name) return null;
  try {
    const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    const resp = await db.send(
      new GetItemCommand({ TableName: name, Key: { metaCallId: { S: callId } } }),
    );
    const item = resp.Item;
    if (!item?.pcId?.S) return null;
    return {
      pcId: item.pcId.S,
      sessionId: item.sessionId?.S ?? '',
      customerId: item.customerId?.S ?? '',
    };
  } catch (err) {
    console.warn(`call-map read failed for call ${callId}: ${String(err)}`);
    return null;
  }
}

/** Delete the mapping for a call-id (best-effort, after disconnect). */
export async function deleteMapping(callId: string): Promise<void> {
  const name = process.env.CALL_MAPPING_TABLE_NAME;
  if (!name) return;
  try {
    const { DeleteItemCommand } = await import('@aws-sdk/client-dynamodb');
    const db = await client();
    await db.send(
      new DeleteItemCommand({ TableName: name, Key: { metaCallId: { S: callId } } }),
    );
  } catch (err) {
    console.warn(`call-map delete failed for call ${callId}: ${String(err)}`);
  }
}
