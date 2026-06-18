"""Unit tests for the VoiceNotes memory-id resolution helper.

The bug this guards against: the VoiceNotes runtime used to construct
``SharedMemoryClient()`` with no id while the stack threads only
``SHARED_MEMORY_ARN`` (not ``WA_MEMORY_ID``), so the client was never
``configured`` and read/write silently no-opped. ``_resolve_memory_id`` derives
the bare id (preferring WA_MEMORY_ID, else parsing the ARN) so memory actually
works - matching the Chat and Call runtimes. Pure env logic, no AWS deps.
"""
from __future__ import annotations

import bounded_sonic


def test_resolve_memory_id_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("WA_MEMORY_ID", "mem-explicit-123")
    monkeypatch.setenv(
        "SHARED_MEMORY_ARN", "arn:aws:bedrock-agentcore:us-east-1:111:memory/mem-from-arn"
    )
    assert bounded_sonic._resolve_memory_id() == "mem-explicit-123"


def test_resolve_memory_id_parses_arn_when_no_explicit(monkeypatch):
    monkeypatch.delenv("WA_MEMORY_ID", raising=False)
    monkeypatch.setenv(
        "SHARED_MEMORY_ARN",
        "arn:aws:bedrock-agentcore:us-east-1:111111111111:memory/wa-shared-AbC123",
    )
    assert bounded_sonic._resolve_memory_id() == "wa-shared-AbC123"


def test_resolve_memory_id_empty_when_nothing_set(monkeypatch):
    monkeypatch.delenv("WA_MEMORY_ID", raising=False)
    monkeypatch.delenv("SHARED_MEMORY_ARN", raising=False)
    assert bounded_sonic._resolve_memory_id() == ""
