"""Outbound WhatsApp delivery via the Sender Lambda (async-reply-delivery).

The VoiceNotes Runtime no longer returns the audio reply to the worker; it
delivers the reply out-of-band by invoking the Sender Lambda (RequestResponse),
mirroring how the Chat Runtime delivers text. The runtime never holds the Meta
Access_Token or the recipient phone (PII) - it passes only
``{customer_id, ...}`` and the Lambda resolves the recipient wa_id from the
24-hour window table and sends via the shared delivery path.

The audio bytes travel IN the invoke payload (base64), never staged at rest
(R3.7). The synchronous Lambda invoke payload limit (6 MB) bounds the reply
size; the handler checks the size before invoking and falls back to text if a
reply would exceed it (R3.9).

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


def _invoke(payload: dict) -> bool:
    """Invoke the Sender Lambda with a delivery payload; return the Lambda's
    ``ok``. Never raises - any failure (missing ARN, invoke error, not-ok
    response) is logged and returns False so a delivery problem degrades
    gracefully rather than crashing the turn."""
    arn = os.environ.get(ENV_SENDER_ARN, "").strip()
    if not arn:
        logger.error("%s not set; cannot deliver via the Sender Lambda", ENV_SENDER_ARN)
        return False
    try:
        import boto3  # lazy: keeps the module importable without boto3

        client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        resp = client.invoke(
            FunctionName=arn,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        raw = resp.get("Payload")
        body = raw.read().decode("utf-8") if raw is not None else ""
        data = json.loads(body) if body else {}
        ok = bool(data.get("ok"))
        if not ok:
            logger.warning(
                "sender lambda reported not-ok (kind=%s): reason=%s",
                payload.get("kind"),
                data.get("reason"),
            )
        return ok
    except Exception as exc:  # noqa: BLE001 - delivery must never crash the turn
        logger.exception("sender lambda invoke failed (kind=%s): %s", payload.get("kind"), exc)
        return False


def send_audio(customer_id: str, audio_b64: str, channel: str = "voicenote") -> bool:
    """Deliver a voice-note (audio) reply. The Ogg Opus bytes travel base64 in
    the invoke payload; the Sender Lambda does the two-step Media upload + send."""
    if not customer_id or not audio_b64:
        logger.warning("refusing to send empty audio for %s", customer_id or "<no-customer>")
        return False
    return _invoke({"kind": "audio", "customer_id": customer_id, "audio_b64": audio_b64, "channel": channel})


def send_text(customer_id: str, text: str, channel: str = "voicenote") -> bool:
    """Deliver a text reply (the could-not-understand / error fallback)."""
    if not customer_id or not text or not text.strip():
        logger.warning("refusing to send empty text for %s", customer_id or "<no-customer>")
        return False
    return _invoke({"kind": "text", "customer_id": customer_id, "text": text, "channel": channel})


def send_typing(message_id: str) -> bool:
    """Relay the WhatsApp typing indicator for an inbound message (best-effort)."""
    if not message_id:
        return False
    return _invoke({"kind": "typing", "message_id": message_id})
