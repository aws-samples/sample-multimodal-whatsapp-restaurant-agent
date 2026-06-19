"""Property-based tests for the Chat Runtime session model (Tasks 8.4 / 8.5).

Feature: whatsapp-restaurant-ai-host

Covers the runtime-managed session model (R5) implemented in session_store.py:

  - Property 5: Session retention and inactivity reset (R5.2, R5.3)
      context contains exactly the most recent min(N, 50) turns, and the next
      message starts a fresh session iff the idle gap is >= 1800 s.

  - Property 6: Session isolation across customers (R5.4)
      for any interleaving of messages from distinct Customer_Id values, each
      customer's context contains only its own turns.

These exercise the pure decision helpers (should_reset, trim_turns) and the
InProcessSessionStore that composes them, all without touching AWS or a model.
"""
from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from session_store import (
    IDLE_RESET_SECONDS,
    MAX_TURNS,
    InProcessSessionStore,
    merge_consecutive_roles,
    should_reset,
    to_text_only,
    trim_turns,
)

# A turn is a Converse-style message. We generate text-only turns here (the
# store reduces multimodal blocks to placeholders; that reduction is covered by
# the to_text_only invariants below).
_text = st.text(min_size=0, max_size=40)


def _turn(role: str, text: str) -> dict:
    return {"role": role, "content": [{"text": text}]}


_turns = st.lists(
    st.builds(_turn, st.sampled_from(["user", "assistant"]), _text),
    min_size=0,
    max_size=140,  # exceed MAX_TURNS so trimming is actually exercised
)

# Customer ids look like the derived "wa-<hex16>" identifiers but any distinct
# non-empty strings suffice for the isolation property.
_customer_id = st.text(
    alphabet="abcdef0123456789", min_size=4, max_size=16
).map(lambda s: f"wa-{s}")


def _expected_ctx(turns: list) -> list:
    """Mirror InProcessSessionStore.save's reduction pipeline so tests compare
    a load against the SAME transform the store applies: reduce to text-only
    (dropping tool blocks and empties), merge consecutive same-role messages,
    trim to MAX_TURNS, then drop any leading non-user message."""
    reduced = [m for m in (to_text_only(t) for t in turns) if m is not None]
    reduced = merge_consecutive_roles(reduced)
    reduced = trim_turns(reduced, MAX_TURNS)
    while reduced and reduced[0].get("role") != "user":
        reduced.pop(0)
    return reduced


# ---------------------------------------------------------------------------
# Property 5: Session retention and inactivity reset
# ---------------------------------------------------------------------------

@given(turns=_turns)
def test_property5_trim_keeps_most_recent_min_n_50(turns):
    """Feature: whatsapp-restaurant-ai-host, Property 5: Session retention and
    inactivity reset - trim_turns retains exactly the most recent min(N, 50)
    turns, in order (a suffix of the input)."""
    kept = trim_turns(turns, MAX_TURNS)
    assert len(kept) == min(len(turns), MAX_TURNS)
    assert kept == turns[len(turns) - len(kept):]  # exact suffix, order preserved


@given(
    last=st.floats(min_value=0.0, max_value=1_000_000.0),
    gap=st.floats(min_value=0.0, max_value=10_000.0),
)
def test_property5_reset_iff_gap_at_least_1800(last, gap):
    """Feature: whatsapp-restaurant-ai-host, Property 5: Session retention and
    inactivity reset - a fresh session starts iff the idle gap is >= 1800 s
    (and a never-seen session - last_activity <= 0 - always resets)."""
    now = last + gap
    if last <= 0:
        assert should_reset(last, now) is True
        return
    assert should_reset(last, now) == (gap >= IDLE_RESET_SECONDS)


@given(turns=_turns, t0=st.integers(min_value=1, max_value=1_000_000))
def test_property5_store_retains_min_n_50_within_window(turns, t0):
    """Feature: whatsapp-restaurant-ai-host, Property 5: Session retention and
    inactivity reset - after saving N turns, an immediate load (within the idle
    window) returns exactly the most recent min(N, 50) turns, text-reduced."""
    store = InProcessSessionStore()
    cid = "wa-deadbeef"
    store.save(cid, turns, now=t0)

    # Load just before the reset boundary: prior turns are retained.
    loaded = store.load_prior(cid, now=t0 + IDLE_RESET_SECONDS - 1)
    expected = _expected_ctx(turns)
    assert loaded == expected
    assert len(loaded) <= MAX_TURNS


@given(turns=_turns, t0=st.integers(min_value=1, max_value=1_000_000))
def test_property5_store_resets_after_idle(turns, t0):
    """Feature: whatsapp-restaurant-ai-host, Property 5: Session retention and
    inactivity reset - a load at or past the 1800 s idle boundary starts a
    fresh session (no prior turns)."""
    store = InProcessSessionStore()
    cid = "wa-cafebabe"
    store.save(cid, turns, now=t0)
    assert store.load_prior(cid, now=t0 + IDLE_RESET_SECONDS) == []


@given(cid=_customer_id, now=st.floats(min_value=0.0, max_value=1_000_000.0))
def test_property5_new_session_has_no_prior(cid, now):
    """Feature: whatsapp-restaurant-ai-host, Property 5: Session retention and
    inactivity reset - a never-seen customer has no prior context."""
    store = InProcessSessionStore()
    assert store.load_prior(cid, now=now) == []


# ---------------------------------------------------------------------------
# Property 6: Session isolation across customers
# ---------------------------------------------------------------------------

@given(
    ops=st.lists(
        st.tuples(_customer_id, _turns),
        min_size=1,
        max_size=20,
    ),
    t0=st.integers(min_value=1, max_value=100_000),
)
def test_property6_isolation_across_customers(ops, t0):
    """Feature: whatsapp-restaurant-ai-host, Property 6: Session isolation
    across customers - for any interleaving of saves from distinct Customer_Id
    values, each customer's loaded context contains only its OWN most recent
    min(N, 50) turns, never another customer's."""
    store = InProcessSessionStore()

    # Replay the interleaved saves; remember the LAST turns saved per customer.
    last_saved: dict[str, list] = {}
    for cid, turns in ops:
        store.save(cid, turns, now=t0)
        last_saved[cid] = turns

    # Each customer sees only its own last save, text-reduced + trimmed.
    for cid, turns in last_saved.items():
        loaded = store.load_prior(cid, now=t0)
        expected = _expected_ctx(turns)
        assert loaded == expected

    # Cross-check: when two distinct customers stored DIFFERENT content, their
    # loaded contexts must also differ. Equal loads can only arise from
    # identical stored content, never from shared storage (no leakage).
    def _ctx(turns: list) -> list:
        return _expected_ctx(turns)

    for cid_a, turns_a in last_saved.items():
        loaded_a = store.load_prior(cid_a, now=t0)
        for cid_b, turns_b in last_saved.items():
            if cid_a == cid_b:
                continue
            if _ctx(turns_a) != _ctx(turns_b):
                assert loaded_a != _ctx(turns_b)


@given(cid_a=_customer_id, cid_b=_customer_id, turns=_turns)
def test_property6_reset_one_customer_leaves_other_intact(cid_a, cid_b, turns):
    """Feature: whatsapp-restaurant-ai-host, Property 6: Session isolation
    across customers - resetting one customer never disturbs another distinct
    customer's retained context."""
    if cid_a == cid_b:
        return
    store = InProcessSessionStore()
    store.save(cid_a, turns, now=100.0)
    store.save(cid_b, turns, now=100.0)

    store.reset(cid_a)

    assert store.load_prior(cid_a, now=100.0) == []
    expected_b = _expected_ctx(turns)
    assert store.load_prior(cid_b, now=100.0) == expected_b


# ---------------------------------------------------------------------------
# Regression: tool blocks must NOT be stored as a "[tool]" placeholder. Doing so
# poisoned the model's retained context and made it imitate "[tool]" as a reply.
# ---------------------------------------------------------------------------

def test_to_text_only_drops_pure_tool_turns():
    """A message whose only blocks are toolUse / toolResult yields None (dropped),
    never a "[tool]" placeholder."""
    assert to_text_only({"role": "assistant", "content": [{"toolUse": {"name": "GetMenu", "input": {}}}]}) is None
    assert to_text_only({"role": "user", "content": [{"toolResult": {"status": "success", "content": []}}]}) is None


def test_to_text_only_keeps_text_drops_tooluse_in_mixed_turn():
    """A mixed turn (narration + toolUse) keeps the text, drops the toolUse."""
    out = to_text_only({
        "role": "assistant",
        "content": [{"text": "Let me check the menu"}, {"toolUse": {"name": "GetMenu", "input": {}}}],
    })
    assert out == {"role": "assistant", "content": [{"text": "Let me check the menu"}]}


def test_to_text_only_never_emits_tool_placeholder():
    """No reduction path ever produces the literal '[tool]' text."""
    samples = [
        {"role": "assistant", "content": [{"toolUse": {"name": "X", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"status": "success", "content": [{"text": "{}"}]}}]},
        {"role": "assistant", "content": [{"text": "hi"}, {"toolUse": {"name": "X", "input": {}}}]},
    ]
    for m in samples:
        out = to_text_only(m)
        blocks = (out or {}).get("content", [])
        assert all(b.get("text") != "[tool]" for b in blocks)


def test_merge_consecutive_roles_merges_adjacent_same_role():
    msgs = [
        {"role": "user", "content": [{"text": "a"}]},
        {"role": "assistant", "content": [{"text": "b"}]},
        {"role": "assistant", "content": [{"text": "c"}]},
        {"role": "user", "content": [{"text": "d"}]},
    ]
    merged = merge_consecutive_roles(msgs)
    assert [m["role"] for m in merged] == ["user", "assistant", "user"]
    assert merged[1]["content"] == [{"text": "b"}, {"text": "c"}]


def test_save_produces_clean_transcript_without_tool_pollution():
    """End-to-end: a realistic tool-using turn sequence stored + loaded yields a
    clean alternating user/assistant text transcript with NO '[tool]' anywhere."""
    store = InProcessSessionStore()
    cid = "wa-deadbeef00000000"
    # user asks -> assistant calls a tool -> tool result -> assistant answers.
    raw = [
        {"role": "user", "content": [{"text": "What is the menu?"}]},
        {"role": "assistant", "content": [{"toolUse": {"name": "qsr___GetMenu", "input": {"locationId": "loc-1"}}}]},
        {"role": "user", "content": [{"toolResult": {"status": "success", "content": [{"text": "{...menu...}"}]}}]},
        {"role": "assistant", "content": [{"text": "Here is the menu: Burger $5.99..."}]},
    ]
    store.save(cid, raw, now=100.0)
    loaded = store.load_prior(cid, now=100.0)
    # No "[tool]" anywhere, and a valid alternating user/assistant transcript.
    flat = " ".join(b.get("text", "") for m in loaded for b in m["content"])
    assert "[tool]" not in flat
    assert [m["role"] for m in loaded] == ["user", "assistant"]
    assert loaded[0]["content"] == [{"text": "What is the menu?"}]
    assert loaded[1]["content"] == [{"text": "Here is the menu: Burger $5.99..."}]
