"""Outbound WhatsApp delivery via the Sender Lambda (Option C).

The chat runtime never holds the Meta Access_Token or the recipient phone
(PII). To send a message it invokes the Sender Lambda (RequestResponse) with
only ``{customer_id, text, channel}``; the Lambda resolves the recipient wa_id
from the 24-hour window table and sends via the shared delivery path.

The Lambda is addressed by its ARN, threaded in as ``SENDER_LAMBDA_ARN`` (the
runtime stack constructs it deterministically from the deployment prefix, so
there is no cross-stack import - see the webhook stack's sender naming).

boto3 is imported lazily so a bare ``import sender_client`` smoke test works in
build/lint environments without it.
"""
from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

ENV_SENDER_ARN = "SENDER_LAMBDA_ARN"


def send_message(customer_id: str, text: str, channel: str = "chat") -> bool:
    """Invoke the Sender Lambda to deliver one WhatsApp message.

    Returns True iff the Lambda reports a successful send (``{"ok": true}``).
    Never raises - any failure (missing ARN, invoke error, not-ok response) is
    logged and returns False, so a delivery problem degrades gracefully rather
    than crashing the turn.
    """
    arn = os.environ.get(ENV_SENDER_ARN, "").strip()
    if not arn:
        logger.error("%s not set; cannot send WhatsApp message", ENV_SENDER_ARN)
        return False
    if not customer_id or not text or not text.strip():
        logger.warning("refusing to send empty message for %s", customer_id or "<no-customer>")
        return False
    try:
        import boto3  # lazy: keeps the module importable without boto3

        client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        resp = client.invoke(
            FunctionName=arn,
            InvocationType="RequestResponse",
            Payload=json.dumps(
                {"customer_id": customer_id, "text": text, "channel": channel}
            ).encode("utf-8"),
        )
        raw = resp.get("Payload")
        body = raw.read().decode("utf-8") if raw is not None else ""
        data = json.loads(body) if body else {}
        ok = bool(data.get("ok"))
        if not ok:
            logger.warning(
                "sender lambda reported not-ok for %s: reason=%s",
                customer_id,
                data.get("reason"),
            )
        return ok
    except Exception as exc:  # noqa: BLE001 - delivery must never crash the turn
        logger.exception("sender lambda invoke failed for %s: %s", customer_id, exc)
        return False


def send_typing(message_id: str) -> bool:
    """Relay the WhatsApp typing indicator for an inbound message (best-effort).

    Invokes the Sender Lambda with kind='typing' so the indicator is refreshed
    across a long async turn (async-reply-delivery R7). Needs only the inbound
    message id (no recipient resolution). Never raises - returns False on any
    problem so a refresh failure never disturbs the turn.
    """
    if not message_id:
        return False
    arn = os.environ.get(ENV_SENDER_ARN, "").strip()
    if not arn:
        logger.error("%s not set; cannot relay the typing indicator", ENV_SENDER_ARN)
        return False
    try:
        import boto3  # lazy: keeps the module importable without boto3

        client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        resp = client.invoke(
            FunctionName=arn,
            InvocationType="RequestResponse",
            Payload=json.dumps({"kind": "typing", "message_id": message_id}).encode("utf-8"),
        )
        raw = resp.get("Payload")
        body = raw.read().decode("utf-8") if raw is not None else ""
        data = json.loads(body) if body else {}
        return bool(data.get("ok"))
    except Exception as exc:  # noqa: BLE001 - typing indicator must never crash the turn
        logger.debug("typing relay invoke failed for message %s: %s", message_id, exc)
        return False
