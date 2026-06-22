"""Property tests for the shared AgentCore Memory client's namespace keying.

These cover the keying guarantees of the ONE shared memory client imported by
all three runtimes (Call, VoiceNotes, Chat) - see
``backend/agentcore-runtime-voice-webrtc/agent/memory_client.py``.

What is proven here (and what is NOT):
  - PROVEN: ``SharedMemoryClient.insights_namespace`` / ``preferences_namespace``
    derive a namespace PURELY and DETERMINISTICALLY from ``customer_id``, embed
    that id verbatim, and never collide two distinct customers. This is the
    client-side property that BACKS cross-channel recall (same customer_id ->
    same namespace across all three runtimes) and cross-customer isolation
    (distinct customer_ids -> distinct, non-overlapping namespaces).
  - NOT PROVEN HERE: full data-plane retrieval isolation. AgentCore enforces
    that a record written under namespace A is only retrievable under namespace
    A; that is a service guarantee, not client logic. What we CAN prove without
    AWS is that the client never derives the SAME namespace for two distinct
    customers (a collision would be the only way the client could break the
    service-enforced isolation), and that one customer's id never appears inside
    another customer's namespace.

Hypothesis iteration count (>=100) comes from the ``wa-pbt`` profile registered
in this directory's ``conftest.py`` - no per-test ``@settings`` override.
"""
from __future__ import annotations

import pytest
from hypothesis import given, strategies as st

from memory_client import SharedMemoryClient


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------
# Realistic customer_id values: the production shape is
# ``"wa-" + sha256(E164 || Pepper)[:16]`` -> "wa-" followed by 16 lowercase hex
# chars. We generate that realistic shape AND a broader text strategy so the
# property is not over-fit to the hex shape.
_HEX = "0123456789abcdef"

realistic_customer_ids = st.builds(
    lambda h: "wa-" + h,
    st.text(alphabet=_HEX, min_size=16, max_size=16),
)

# Broader, still-nonempty text. Excludes the empty string (an empty customer_id
# is a degenerate key the client guards against elsewhere) but otherwise allows
# arbitrary unicode so the determinism/embedding guarantee is exercised widely.
broad_customer_ids = st.text(min_size=1).filter(lambda s: s != "")

any_customer_id = st.one_of(realistic_customer_ids, broad_customer_ids)


# ---------------------------------------------------------------------------
# Property 20: Shared memory keyed deterministically by Customer_Id
# ---------------------------------------------------------------------------
@pytest.mark.property
@given(cid=any_customer_id)
def test_property_20_shared_memory_keyed_deterministically_by_customer_id(cid):
    # Feature: whatsapp-restaurant-ai-host, Property 20: Shared memory keyed deterministically by Customer_Id
    # **Validates: Requirements 5.1, 18.2, 18.3**
    #
    # For ANY valid customer_id, the derived namespace is byte-for-byte
    # identical across repeated derivations (deterministic / pure), and the
    # customer_id is embedded verbatim in the namespace - so the SAME customer
    # resolves to the SAME memory namespace across all three runtimes.
    ns_a = SharedMemoryClient.insights_namespace(cid)
    ns_b = SharedMemoryClient.insights_namespace(cid)

    # Deterministic: repeated calls are byte-for-byte identical.
    assert ns_a == ns_b
    assert ns_a is not None and isinstance(ns_a, str)

    # The customer_id is embedded so the same cid -> same namespace everywhere.
    assert cid in ns_a

    # Preferences namespace is likewise deterministic and embeds the cid.
    pref_a = SharedMemoryClient.preferences_namespace(cid)
    pref_b = SharedMemoryClient.preferences_namespace(cid)
    assert pref_a == pref_b
    assert cid in pref_a


@pytest.mark.property
@given(pair=st.lists(any_customer_id, min_size=2, max_size=2, unique=True))
def test_property_20_distinct_customer_ids_yield_distinct_namespaces(pair):
    # Feature: whatsapp-restaurant-ai-host, Property 20: Shared memory keyed deterministically by Customer_Id
    # **Validates: Requirements 5.1, 18.2, 18.3**
    #
    # Distinctness arm of Property 20: for any two DISTINCT customer_ids the
    # derived namespaces are distinct (no two customers share a key).
    cid_a, cid_b = pair
    assert cid_a != cid_b
    assert (
        SharedMemoryClient.insights_namespace(cid_a)
        != SharedMemoryClient.insights_namespace(cid_b)
    )


# ---------------------------------------------------------------------------
# Property 21: Cross-customer memory isolation
# ---------------------------------------------------------------------------
@pytest.mark.property
@given(pair=st.lists(realistic_customer_ids, min_size=2, max_size=2, unique=True))
def test_property_21_cross_customer_memory_isolation(pair):
    # Feature: whatsapp-restaurant-ai-host, Property 21: Cross-customer memory isolation
    # **Validates: Requirements 5.4, 18.2**
    #
    # For any two distinct customer_ids A and B, the insights AND preferences
    # namespaces differ, and neither namespace contains the other customer's id.
    # This is the client-side namespace-isolation guarantee that backs full
    # cross-customer isolation: AgentCore enforces that a record written under
    # A's namespace is only retrievable under A's namespace, so the only way the
    # client could leak B's data to A is by deriving a colliding/overlapping
    # namespace - which this property proves cannot happen for distinct ids.
    #
    # The generator is intentionally constrained to the REALISTIC id shape
    # ("wa-" + 16 lowercase hex), which is the only shape the customer_id
    # derivation (R3) ever produces. The substring non-containment assertion is
    # meaningful precisely for that shape: arbitrary unicode ids (e.g. one id
    # being another id followed by "/") could be substrings of each other's
    # namespace without any real isolation breach, so testing them would assert
    # a guarantee the system never actually needs.
    cid_a, cid_b = pair
    assert cid_a != cid_b

    ins_a = SharedMemoryClient.insights_namespace(cid_a)
    ins_b = SharedMemoryClient.insights_namespace(cid_b)
    pref_a = SharedMemoryClient.preferences_namespace(cid_a)
    pref_b = SharedMemoryClient.preferences_namespace(cid_b)

    # Distinct namespaces for distinct customers (insights and preferences).
    assert ins_a != ins_b
    assert pref_a != pref_b

    # A's id is not a substring of B's namespace and vice versa, so no record
    # keyed by A could be addressed under B's namespace (no overlap / nesting).
    assert cid_b not in ins_a
    assert cid_a not in ins_b
    assert cid_b not in pref_a
    assert cid_a not in pref_b
