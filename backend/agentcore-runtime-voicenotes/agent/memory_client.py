"""Shared AgentCore Memory client for the WhatsApp variant.

CANONICAL SOURCE: this file is a VERBATIM COPY of
`backend/agentcore-runtime-voice-webrtc/agent/memory_client.py`. By project
decision (see the spec discussion for Task 7.2) each runtime's `agent/` dir
carries its own copy so the sub-project is self-contained and reusable in
isolation, rather than importing across sub-project folders. If you change the
behavior here, update the copy in every runtime dir (Call, VoiceNotes, Chat)
to keep cross-channel memory keying identical.

This is the ONE memory client (by contract) imported by all three runtimes
(Call, VoiceNotes, Chat). It talks to the single shared Amazon Bedrock
AgentCore Memory resource provisioned by backend/agentcore-memory (MemoryStack),
whose id/ARN are passed into each runtime as environment variables sourced from
CloudFormation parameters (R18.1).

Keying model (R18.2, R18.3):
  - Every operation is keyed by ``customer_id`` (the pseudonymous
    ``"wa-" + sha256(E164 || Pepper)[:16]`` value) used as the AgentCore
    ``actorId``. The raw phone number is NEVER used as a key and never stored.
  - Long-term consolidated insights are namespaced by ``{actorId}`` via the
    strategy namespaces ``/insights/{actorId}/`` and ``/preferences/{actorId}/``
    defined on the memory resource, so the SAME customer resolves to the SAME
    memory across all three runtimes -> cross-channel recall (R18.5).

Two operations, identical across modalities:
  - ``read_long_term(customer_id, query)`` at session START -> returns
    consolidated insight strings to inject into the agent's system context.
  - ``write_events(customer_id, session_id, turns)`` at session END -> appends
    raw conversation turns to short-term memory; the managed consolidation
    pipeline distills them into long-term insights asynchronously (R18.5).

Failure posture (R18.7): a read failure at session start NEVER hard-fails the
customer interaction. ``read_long_term`` returns an empty list and records the
failure; the runtime proceeds with no prior insights.

Data plane: boto3 client ``bedrock-agentcore`` (NOT ``bedrock-agentcore-control``,
which is the control plane used only by the CDK/provisioning path).
  - write: ``create_event``
  - read:  ``retrieve_memory_records``

Gotcha (documented for callers): long-term retrieval is EVENTUALLY CONSISTENT.
Consolidation runs asynchronously after ``create_event``, so a turn written this
session is not retrievable until consolidation completes. Read at session start
(prior sessions' insights), not mid-session expecting same-turn data.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Environment variable names threaded in from the runtime stack (CfnParameter ->
# container env). MEMORY_ID is required for data-plane calls; the ARN is used
# only for IAM scoping at deploy time, not by this client.
ENV_MEMORY_ID = "WA_MEMORY_ID"
ENV_REGION = "AWS_REGION"

# Default semantic-search query used when a runtime does not supply its own.
# Broad enough to surface name, dietary notes, and ordering preferences.
DEFAULT_INSIGHT_QUERY = (
    "customer name, dietary restrictions and allergies, usual order, "
    "delivery or pickup preferences, recent order context"
)

# Long-term namespaces, templated by {actorId} on the memory resource. The
# concrete namespace is resolved here by substituting the customer_id.
NS_INSIGHTS = "/insights/{actor}/"
NS_PREFERENCES = "/preferences/{actor}/"

# Conversation roles accepted by AgentCore create_event payloads.
ROLE_USER = "USER"
ROLE_ASSISTANT = "ASSISTANT"
ROLE_TOOL = "TOOL"
ROLE_OTHER = "OTHER"

# AgentCore caps a single conversational content block at 9000 characters.
_MAX_TEXT_CHARS = 9000


@dataclass
class Turn:
    """One conversation turn to persist into short-term memory."""

    role: str
    text: str


@dataclass
class MemoryReadResult:
    """Result of a long-term read. ``ok`` is False when the read failed; the
    runtime still proceeds (insights empty) per R18.7."""

    insights: list[str] = field(default_factory=list)
    ok: bool = True
    error: Optional[str] = None


class SharedMemoryClient:
    """Thin wrapper over the AgentCore Memory data plane, keyed by customer_id.

    Construct once per runtime process and reuse. The boto3 client is created
    lazily so importing this module never requires AWS credentials (keeps unit
    and property tests dependency-light).
    """

    def __init__(
        self,
        memory_id: Optional[str] = None,
        region: Optional[str] = None,
        client: Any = None,
    ) -> None:
        self._memory_id = memory_id or os.environ.get(ENV_MEMORY_ID, "")
        self._region = region or os.environ.get(ENV_REGION, "us-east-1")
        # Injected client is used by tests; otherwise created lazily.
        self._client = client

    # ----------------------------------------------------------------- helpers
    @staticmethod
    def insights_namespace(customer_id: str) -> str:
        """Concrete long-term insights namespace for a customer_id.

        Pure and deterministic: the same customer_id always yields the same
        namespace, and distinct customer_ids yield distinct namespaces
        (Property 20 / Property 21 rely on this)."""
        return NS_INSIGHTS.format(actor=customer_id)

    @staticmethod
    def preferences_namespace(customer_id: str) -> str:
        """Concrete long-term preferences namespace for a customer_id."""
        return NS_PREFERENCES.format(actor=customer_id)

    @property
    def configured(self) -> bool:
        """True when a memory id is available; runtimes can degrade gracefully
        if memory is not yet wired (e.g. the memory stack not deployed)."""
        return bool(self._memory_id)

    def _data_plane(self) -> Any:
        if self._client is None:
            import boto3  # local import: no AWS dependency at module import time

            self._client = boto3.client(
                "bedrock-agentcore", region_name=self._region
            )
        return self._client

    # -------------------------------------------------------------- public API
    def read_long_term(
        self,
        customer_id: str,
        query: str = DEFAULT_INSIGHT_QUERY,
        top_k: int = 10,
    ) -> MemoryReadResult:
        """Retrieve consolidated long-term insights for a customer at session
        start. Never raises: on any failure returns ok=False with empty
        insights so the runtime proceeds with no prior context (R18.7)."""
        if not self.configured:
            return MemoryReadResult(insights=[], ok=False, error="memory-not-configured")
        if not customer_id:
            return MemoryReadResult(insights=[], ok=False, error="empty-customer-id")

        namespace = self.insights_namespace(customer_id)
        try:
            resp = self._data_plane().retrieve_memory_records(
                memoryId=self._memory_id,
                namespace=namespace,
                searchCriteria={"searchQuery": query, "topK": top_k},
            )
            records = resp.get("memoryRecordSummaries", []) or []
            insights: list[str] = []
            for rec in records:
                text = (rec.get("content") or {}).get("text")
                if text:
                    insights.append(text)
            return MemoryReadResult(insights=insights, ok=True)
        except Exception as exc:  # noqa: BLE001 - graceful degradation by design
            # Log keyed by customer_id only (never the raw phone number).
            logger.warning(
                "shared-memory read failed for %s: %s", customer_id, exc
            )
            return MemoryReadResult(insights=[], ok=False, error=str(exc))

    def write_events(
        self,
        customer_id: str,
        session_id: str,
        turns: list[Turn],
    ) -> bool:
        """Append conversation turns to short-term memory at session end. The
        consolidation pipeline later distills them into long-term insights.

        Returns True on success, False on failure (a write failure is recorded
        but does not break the customer-facing reply)."""
        if not self.configured or not customer_id or not session_id or not turns:
            return False

        payload = []
        for turn in turns:
            text = (turn.text or "")[:_MAX_TEXT_CHARS]
            if not text.strip():
                continue
            payload.append(
                {
                    "conversational": {
                        "role": turn.role,
                        "content": {"text": text},
                    }
                }
            )
        if not payload:
            return False

        try:
            self._data_plane().create_event(
                memoryId=self._memory_id,
                actorId=customer_id,
                sessionId=session_id,
                eventTimestamp=datetime.now(timezone.utc),
                payload=payload,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "shared-memory write failed for %s: %s", customer_id, exc
            )
            return False
