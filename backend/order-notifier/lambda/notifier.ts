// Proactive order-status notifier (Task 27).
//
// Triggered by the Orders table DynamoDB Stream. On a status transition INTO a
// notify-worthy status (in-preparation, ready), it sends the customer a
// free-form WhatsApp update. Reacting to status changes (rather than the demo
// kitchen-sim sending directly) is the production-realistic pattern: a real
// POS/kitchen advances the order status and this notifier just delivers.
//
// REUSE (no duplication, per Task 27): the actual send + 24-hour-window routing
// + retry/backoff is the webhook's Reply Delivery core (`deliverWithRouting`),
// the window/contact lookup is its `windowTable`, and the message text is its
// `orderConfirmation.renderStatusUpdate`. We import them across the project
// boundary so there is ONE implementation of the send logic. The relative path
// below is the single point of that cross-project coupling; esbuild bundles the
// imported modules into this Lambda at deploy time.
//
// Identity note: the `wa-` customer_id is a non-reversible hash, so the
// recipient phone (wa_id) is read from the window table where the webhook
// worker recorded it on the customer's inbound. Notifications are always within
// the 24-hour window (orders are minutes old), so this is free-form only - no
// Utility template (out of scope, per project decision).
import {
  deliverWithRouting,
} from '../../../whatsapp-interface/whatsapp-webhook/cdk/lambda/webhook-handler/lib/whatsappClient.js';
import {
  getContact,
  isWindowOpen,
} from '../../../whatsapp-interface/whatsapp-webhook/cdk/lambda/webhook-handler/lib/windowTable.js';
import {
  renderStatusUpdate,
} from '../../../whatsapp-interface/whatsapp-webhook/cdk/lambda/webhook-handler/lib/orderConfirmation.js';
import { isNotifiableTransition } from './lifecycle.js';

// Cache the access token across warm invocations (loaded from Secrets Manager).
let tokenCache: string | null = null;

async function loadToken(): Promise<string | null> {
  if (tokenCache) return tokenCache;
  const name = process.env.ACCESS_TOKEN_SECRET_NAME;
  if (!name) {
    console.error('ACCESS_TOKEN_SECRET_NAME not set; notifier cannot send');
    return null;
  }
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    tokenCache = resp.SecretString ?? null;
    return tokenCache;
  } catch (err) {
    console.warn(`notifier: failed to load access token: ${String(err)}`);
    return null;
  }
}

interface StreamRecord {
  eventName?: string;
  dynamodb?: {
    OldImage?: Record<string, { S?: string; N?: string }>;
    NewImage?: Record<string, { S?: string; N?: string }>;
  };
}

export async function handler(event: { Records?: StreamRecord[] }): Promise<void> {
  const records = event?.Records ?? [];
  for (const rec of records) {
    if (rec.eventName !== 'MODIFY') continue;
    const oldImg = rec.dynamodb?.OldImage ?? {};
    const newImg = rec.dynamodb?.NewImage ?? {};
    const oldStatus = oldImg.status?.S;
    const newStatus = newImg.status?.S;

    if (!isNotifiableTransition(oldStatus, newStatus)) continue;

    const customerId = newImg.customerId?.S ?? '';
    const orderId = newImg.orderId?.S ?? '';
    if (!customerId || !orderId || !newStatus) continue;

    const text = renderStatusUpdate(orderId, newStatus);
    if (!text) continue; // not a customer-facing status

    // Resolve the recipient phone (wa_id) the worker stored at inbound time.
    const contact = await getContact(customerId);
    if (!contact.waId) {
      console.info(`notifier: no wa_id on file for ${customerId}; skipping ${newStatus} update`);
      continue;
    }
    // Within-24h only (free-form). An order is minutes old, so this is
    // effectively always open; guard anyway to avoid a pointless send attempt.
    if (!isWindowOpen(contact.lastInboundTs, Math.floor(Date.now() / 1000))) {
      console.info(`notifier: window closed for ${customerId}; skipping ${newStatus} update`);
      continue;
    }

    const token = await loadToken();
    if (!token) continue;

    const r = await deliverWithRouting(contact.waId, text, token, customerId);
    if (r.ok) {
      console.info(`notifier: sent "${newStatus}" update for order ${orderId} (customer ${customerId})`);
    } else {
      console.warn(
        `notifier: failed to send "${newStatus}" update for order ${orderId} (customer ${customerId}): ` +
          `${r.configError ? 'config_unavailable' : `status_${r.outcome?.last.status}`}`,
      );
    }
  }
}
