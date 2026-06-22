// DEMO kitchen simulator (Task 27) - a scheduled stand-in for a real kitchen/POS.
//
// Runs on an EventBridge schedule (rate(1 minute)). Each invocation scans the
// Orders table for in-flight orders (status confirmed | in-preparation) and
// advances each ONE step if it is old enough (see lifecycle.nextStatus):
//
//     confirmed --(>=1 min)--> in-preparation --(>=2 min)--> ready
//
// The status write uses an optimistic ConditionExpression on the current
// status so concurrent invocations never double-advance an order, and so each
// successful write emits exactly one DynamoDB Stream MODIFY for the notifier.
//
// This is DEMO SIMULATION CODE: a real deployment would replace it with the
// restaurant's POS/kitchen system advancing order status. It is gated behind
// the `enableKitchenSimulator` context flag in the stack so production deploys
// can omit it. It never touches orders for a customer it was not asked to - it
// only advances status along the valid lifecycle, nothing else.

import { nextStatus } from './lifecycle.js';

const IN_FLIGHT = new Set(['confirmed', 'in-preparation']);

export async function handler(): Promise<{ scanned: number; advanced: number }> {
  const tableName = process.env.ORDERS_TABLE_NAME;
  if (!tableName) {
    console.error('ORDERS_TABLE_NAME not set; kitchen simulator cannot run');
    return { scanned: 0, advanced: 0 };
  }

  const { DynamoDBClient, ScanCommand, UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  const now = Date.now();
  let scanned = 0;
  let advanced = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const resp: any = await db.send(
      new ScanCommand({
        TableName: tableName,
        // Only in-flight orders; `status` is a DynamoDB reserved word.
        FilterExpression: '#s IN (:confirmed, :inprep)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':confirmed': { S: 'confirmed' },
          ':inprep': { S: 'in-preparation' },
        },
        ExclusiveStartKey: startKey as any,
      }),
    );

    for (const item of resp.Items ?? []) {
      scanned++;
      const current = item.status?.S;
      const tsMs = item.timestamp?.N ? Number(item.timestamp.N) : NaN;
      if (!current || !IN_FLIGHT.has(current) || !Number.isFinite(tsMs)) continue;

      const next = nextStatus(current, now - tsMs);
      if (!next) continue;

      try {
        await db.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET #s = :next',
            // Optimistic: only advance if the status is still what we read, so
            // concurrent scans emit exactly one MODIFY per real transition.
            ConditionExpression: '#s = :current',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':next': { S: next }, ':current': { S: current } },
          }),
        );
        advanced++;
        console.info(`kitchen-sim: order ${item.orderId?.S ?? '?'} ${current} -> ${next}`);
      } catch (err: any) {
        // ConditionalCheckFailedException = another invocation already advanced
        // it; anything else is logged and skipped (best-effort demo).
        if (err?.name !== 'ConditionalCheckFailedException') {
          console.warn(`kitchen-sim: update failed for ${item.orderId?.S ?? '?'}: ${String(err)}`);
        }
      }
    }
    startKey = resp.LastEvaluatedKey;
  } while (startKey);

  console.info(`kitchen-sim: scanned=${scanned} advanced=${advanced}`);
  return { scanned, advanced };
}
