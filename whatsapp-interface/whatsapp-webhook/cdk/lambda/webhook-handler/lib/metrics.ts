// CloudWatch metrics via the Embedded Metric Format (EMF) - Task 9 / R12, R15.
//
// Emitting metrics as a structured EMF log line (rather than a PutMetricData API
// call) means the Lambda needs NO extra IAM and no synchronous CloudWatch call
// on the reply path: CloudWatch extracts the metric from the log automatically.
// Metric VALUES carry no PII; the Customer_Id is attached as a (non-dimension)
// property so logs are searchable by customer without creating a high-cardinality
// metric dimension. The raw phone number is never emitted.

const NAMESPACE = 'WhatsAppRestaurantAiHost';

/** Emit one count metric in EMF. `dimensions` become CloudWatch dimensions
 *  (keep them low-cardinality, e.g. Channel); `properties` are searchable log
 *  fields only (e.g. customerId), never dimensions. */
export function emitCount(
  metricName: string,
  dimensions: Record<string, string> = {},
  properties: Record<string, string | number> = {},
): void {
  const dimensionKeys = Object.keys(dimensions);
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: [{ Name: metricName, Unit: 'Count' }],
        },
      ],
    },
    ...dimensions,
    ...properties,
    [metricName]: 1,
  };
  // EMF must be a single JSON line on stdout.
  console.log(JSON.stringify(emf));
}

/** Reply delivered successfully (R12 success metric). */
export function emitDeliverySuccess(channel: string, customerId: string): void {
  emitCount('ReplyDelivered', { Channel: channel }, { customerId });
}

/** Reply delivery failed after retries / token unavailable (R12 failure metric).
 *  `reason` is a low-cardinality cause for searchability. */
export function emitDeliveryFailure(channel: string, customerId: string, reason: string): void {
  emitCount('ReplyDeliveryFailure', { Channel: channel }, { customerId, reason });
}
