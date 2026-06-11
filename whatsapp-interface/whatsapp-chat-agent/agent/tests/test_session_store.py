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
    expected = [to_text_only(m) for m in turns][-MAX_TURNS:]
    assert loaded == expected
    assert len(loaded) == min(len(turns), MAX_TURNS)


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
        expected = [to_text_only(m) for m in turns][-MAX_TURNS:]
        assert loaded == expected

    # Cross-check: when two distinct customers stored DIFFERENT content, their
    # loaded contexts must also differ. Equal loads can only arise from
    # identical stored content, never from shared storage (no leakage).
    def _ctx(turns: list) -> list:
        return [to_text_only(m) for m in turns][-MAX_TURNS:]

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
    expected_b = [to_text_only(m) for m in turns][-MAX_TURNS:]
    assert store.load_prior(cid_b, now=100.0) == expected_b
