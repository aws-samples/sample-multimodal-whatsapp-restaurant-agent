// Proactive order confirmations (Task 10, R14).
//
// When an order reaches the confirmed state, send the customer a confirmation
// within 30 s (R14.1). It routes by the 24-hour window (free-form vs Utility
// template - R14.2/R14.3) and retries per R12, reusing the Reply Delivery core.
// Every confirmation includes the order reference id and a system-defined status
// (R14.4); any estimated readiness time is rendered as an absolute local
// timestamp WITH timezone (R14.5). On retry exhaustion it emits a delivery-
// failure metric naming the order reference and leaves the order record
// UNMODIFIED (R14.7).
//
// renderConfirmation is pure (the Property 14 test seam): no I/O, deterministic
// given the order + timezone.

import { emitCount } from './metrics.js';
import { deliverWithRouting } from './whatsappClient.js';

/** System-defined order statuses (R14.4). */
export const ORDER_STATUSES = ['received', 'in-preparation', 'ready', 'completed'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderConfirmation {
  orderRef: string;
  status: OrderStatus;
  /** Optional estimated readiness time as epoch milliseconds. */
  estimatedReadyAtMs?: number;
}

const DEFAULT_TIMEZONE = process.env.RESTAURANT_TIMEZONE || 'America/New_York';

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Format an epoch-ms instant as an absolute local timestamp INCLUDING the
 *  timezone (R14.5), e.g. "Jan 14, 2025, 3:45 PM EST". Pure given the IANA
 *  timezone. */
export function formatReadiness(epochMs: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short', // the timezone is always present (R14.5)
  }).format(new Date(epochMs));
}

/** Pure (Property 14): render the confirmation text. Always contains the order
 *  reference id and a system-defined status; if a readiness time is supplied it
 *  is an absolute local timestamp with timezone. */
export function renderConfirmation(order: OrderConfirmation, timeZone: string = DEFAULT_TIMEZONE): string {
  const status: OrderStatus = isOrderStatus(order.status) ? order.status : 'received';
  let text = `Your order ${order.orderRef} is confirmed. Status: ${status}.`;
  if (order.estimatedReadyAtMs !== undefined && Number.isFinite(order.estimatedReadyAtMs)) {
    text += ` Estimated ready: ${formatReadiness(order.estimatedReadyAtMs, timeZone)}.`;
  }
  return text;
}

/** Statuses the proactive notifier (Task 27) sends an update for. A freshly
 *  placed order is `confirmed`; the kitchen simulator advances it
 *  `confirmed -> in-preparation -> ready`, and each of these transitions is
 *  worth a customer-facing message. (`received`/`completed` are not notified.) */
export const NOTIFIABLE_STATUSES: readonly OrderStatus[] = ['in-preparation', 'ready'];

export function isNotifiableStatus(value: string): value is OrderStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(value);
}

/** Pure: the proactive status-update text for a kitchen-lifecycle transition
 *  (Task 27). Deterministic given (orderRef, status). Returns null for a status
 *  that should not trigger a customer message, so callers can guard on it. */
export function renderStatusUpdate(orderRef: string, status: string): string | null {
  switch (status) {
    case 'in-preparation':
      return `Good news! Your order ${orderRef} is now being prepared in the kitchen.`;
    case 'ready':
      return `Your order ${orderRef} is ready for pickup. See you soon!`;
    default:
      return null;
  }
}

/** Send an order confirmation. Returns true on a 2xx. Never mutates `order`
 *  (R14.7) and never throws. On exhaustion emits a delivery-failure metric that
 *  names the order reference. */
export async function sendOrderConfirmation(
  recipient: string,
  order: OrderConfirmation,
  token: string,
  customerId = '',
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<boolean> {
  const text = renderConfirmation(order, timeZone);
  const r = await deliverWithRouting(recipient, text, token, customerId);

  if (r.ok) {
    emitCount('OrderConfirmationSent', { Channel: 'confirmation' }, { customerId, orderRef: order.orderRef });
    return true;
  }

  // R14.7: emit a delivery-failure metric identifying the order reference; the
  // order record is preserved (this function never modifies `order`).
  const reason = r.configError ? 'token_or_config_unavailable' : `status_${r.outcome?.last.status}`;
  console.warn(
    `order confirmation delivery failed for order ${order.orderRef} (customer ${customerId}): ${reason}`,
  );
  emitCount('OrderConfirmationDeliveryFailure', { Channel: 'confirmation' }, {
    customerId,
    orderRef: order.orderRef,
    reason,
  });
  return false;
}
