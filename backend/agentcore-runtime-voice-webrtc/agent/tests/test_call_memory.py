"""Unit tests for the call-runtime memory wiring helpers (Task 16.4).

Covers the two PURE pieces added for shared-memory recall on voice calls:
  - system_prompt.append_insights: additive prompt augmentation (the call
    runtime resolves its base prompt remotely, so insights are appended);
  - sonic_call._resolve_memory_id: bare memory-id resolution from WA_MEMORY_ID
    or by parsing SHARED_MEMORY_ARN (the env var the Call stack actually sets).

Neither touches Strands/aiortc/boto3, so they run in the plain dev env.
"""
from __future__ import annotations

import system_prompt
import sonic_call


# --- system_prompt.append_insights -----------------------------------------
def test_append_insights_none_or_empty_returns_prompt_unchanged():
    base = "BASE PROMPT"
    assert system_prompt.append_insights(base, None) == base
    assert system_prompt.append_insights(base, []) == base
    # A list of only-blank strings is also the no-context path.
    assert system_prompt.append_insights(base, ["", "   "]) == base


def test_append_insights_appends_bulleted_block():
    base = "BASE PROMPT"
    out = system_prompt.append_insights(base, ["likes extra spicy", "usual: #3 combo"])
    assert out.startswith(base)
    assert "- likes extra spicy" in out
    assert "- usual: #3 combo" in out
    # The base prompt is preserved verbatim (additive, not rewritten).
    assert len(out) > len(base)


def test_append_insights_skips_blank_entries():
    out = system_prompt.append_insights("P", ["keep", "  ", ""])
    assert "- keep" in out
    # No empty bullet lines for the blank entries.
    assert "- \n" not in out


# --- sonic_call._resolve_memory_id ------------------------------------------
def test_resolve_memory_id_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("WA_MEMORY_ID", "mem-explicit-123")
    monkeypatch.setenv("SHARED_MEMORY_ARN", "arn:aws:bedrock-agentcore:us-east-1:111:memory/mem-from-arn")
    assert sonic_call._resolve_memory_id() == "mem-explicit-123"


def test_resolve_memory_id_parses_arn_when_no_explicit(monkeypatch):
    monkeypatch.delenv("WA_MEMORY_ID", raising=False)
    monkeypatch.setenv(
        "SHARED_MEMORY_ARN",
        "arn:aws:bedrock-agentcore:us-east-1:111111111111:memory/wa-shared-AbC123",
    )
    assert sonic_call._resolve_memory_id() == "wa-shared-AbC123"


def test_resolve_memory_id_empty_when_nothing_set(monkeypatch):
    monkeypatch.delenv("WA_MEMORY_ID", raising=False)
    monkeypatch.delenv("SHARED_MEMORY_ARN", raising=False)
    assert sonic_call._resolve_memory_id() == ""
