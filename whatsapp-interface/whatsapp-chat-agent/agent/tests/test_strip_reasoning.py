"""Unit tests for strip_internal_reasoning - the <thinking> leak guard.

Amazon Nova Pro can wrap chain-of-thought in <thinking>...</thinking> tags. That
internal reasoning must NEVER reach the customer, so the chat runtime strips it
deterministically before returning the reply.
"""
from __future__ import annotations

from chat_agent import strip_internal_reasoning


def test_strips_complete_thinking_block():
    raw = (
        "<thinking> To find the nearest locations to Sergio, I need coordinates. "
        "I'll ask for his address. </thinking>"
        "Could you please share your current location or address?"
    )
    out = strip_internal_reasoning(raw)
    assert "thinking" not in out.lower()
    assert out == "Could you please share your current location or address?"


def test_strips_dangling_open_tag_to_end():
    # An unterminated <thinking> must not leak the reasoning tail.
    raw = "Sure!\n<thinking> internal notes that never close..."
    out = strip_internal_reasoning(raw)
    assert out == "Sure!"
    assert "thinking" not in out.lower()


def test_strips_stray_tags_and_is_case_insensitive():
    raw = "<THINKING>x</THINKING>Hello there </thinking>"
    out = strip_internal_reasoning(raw)
    assert out == "Hello there"


def test_passthrough_when_no_thinking():
    raw = "Your order total is $12.50. Confirm?"
    assert strip_internal_reasoning(raw) == raw


def test_empty_input():
    assert strip_internal_reasoning("") == ""
    assert strip_internal_reasoning(None) is None
