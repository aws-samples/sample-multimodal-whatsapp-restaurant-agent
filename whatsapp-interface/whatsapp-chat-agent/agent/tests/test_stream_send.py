"""Unit tests for the streaming send path (Option C, chat runtime).

Covers the two new pure-with-injection pieces:
  - extract_assistant_text: text blocks only, never tool-use (the "[tool]" leak
    guard);
  - _process_stream: sends each completed ASSISTANT message's text in order via
    an injected async `send`, skips tool-use-only turns, strips <thinking>, and
    has a safety net that recovers the final answer from the result event.

Coroutines are driven with asyncio.run() so the tests need no pytest-asyncio
mode configuration.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from chat_agent import extract_assistant_text, _process_stream


def _astream(events):
    """Wrap a list of event dicts as an async generator (a fake stream_async)."""

    async def _gen():
        for e in events:
            yield e

    return _gen()


def _recorder():
    """An async send that records (customer_id, text, channel) and returns ok."""
    sent: list[tuple[str, str, str]] = []

    async def send(cid: str, text: str, channel: str) -> bool:
        sent.append((cid, text, channel))
        return True

    return sent, send


# --- extract_assistant_text -------------------------------------------------

def test_extract_joins_text_blocks():
    assert extract_assistant_text([{"text": "hi"}, {"text": " there"}]) == "hi there"


def test_extract_skips_tool_use_block():
    content = [{"text": "let me check"}, {"toolUse": {"name": "GetMenu", "input": {}}}]
    assert extract_assistant_text(content) == "let me check"


def test_extract_tool_use_only_is_empty():
    assert extract_assistant_text([{"toolUse": {"name": "GetMenu"}}]) == ""


def test_extract_non_list_is_empty():
    assert extract_assistant_text(None) == ""
    assert extract_assistant_text("nope") == ""
    assert extract_assistant_text([{"image": {"format": "png"}}]) == ""


# --- _process_stream --------------------------------------------------------

def test_process_stream_sends_interim_then_final():
    final = {"role": "assistant", "content": [{"text": "Here are the options"}]}
    events = [
        {
            "message": {
                "role": "assistant",
                "content": [
                    {"text": "Let me pull the menu"},
                    {"toolUse": {"name": "GetMenu", "input": {}}},
                ],
            }
        },
        # tool result comes back as a user message -> skipped
        {"message": {"role": "user", "content": [{"toolResult": {"content": []}}]}},
        {"message": final},
        {"result": SimpleNamespace(stop_reason="end_turn", message=final)},
    ]
    sent, send = _recorder()
    out, stop = asyncio.run(_process_stream(_astream(events), "wa-x", "chat", send))

    assert out == ["Let me pull the menu", "Here are the options"]
    assert [t for _, t, _ in sent] == ["Let me pull the menu", "Here are the options"]
    assert all(cid == "wa-x" and ch == "chat" for cid, _, ch in sent)
    assert stop == "end_turn"
    # The result.message text equals the last sent -> NOT double-sent.
    assert len(sent) == 2


def test_process_stream_strips_thinking_and_skips_tool_only():
    answer = {"role": "assistant", "content": [{"text": "<thinking>secret</thinking>Real answer"}]}
    events = [
        {"message": {"role": "assistant", "content": [{"toolUse": {"name": "X"}}]}},  # no text
        {"message": answer},
        {"result": SimpleNamespace(stop_reason="end_turn", message=answer)},
    ]
    sent, send = _recorder()
    out, _ = asyncio.run(_process_stream(_astream(events), "wa-x", "chat", send))
    assert out == ["Real answer"]
    assert [t for _, t, _ in sent] == ["Real answer"]


def test_process_stream_safety_net_recovers_final_from_result():
    # The final text was never emitted as a `message` event - only the result
    # carries it. The safety net must still deliver it.
    events = [
        {"message": {"role": "assistant", "content": [{"toolUse": {"name": "X"}}]}},
        {
            "result": SimpleNamespace(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Recovered answer"}]},
            )
        },
    ]
    sent, send = _recorder()
    out, _ = asyncio.run(_process_stream(_astream(events), "wa-x", "chat", send))
    assert out == ["Recovered answer"]


def test_process_stream_no_text_returns_empty():
    events = [
        {"message": {"role": "assistant", "content": [{"toolUse": {"name": "X"}}]}},
        {
            "result": SimpleNamespace(
                stop_reason="tool_use",
                message={"role": "assistant", "content": [{"toolUse": {"name": "X"}}]},
            )
        },
    ]
    sent, send = _recorder()
    out, stop = asyncio.run(_process_stream(_astream(events), "wa-x", "chat", send))
    assert out == []
    assert sent == []
    assert stop == "tool_use"


# --- safety net: a bare tool-placeholder is never delivered -----------------

from chat_agent import _is_tool_placeholder


def test_is_tool_placeholder_matches_bare_variants():
    for s in ["[tool]", " [tool] ", "[TOOL]", "[tool use]", "[tool_call]", "[tools]"]:
        assert _is_tool_placeholder(s) is True
    for s in ["here is the [tool] result", "the menu", "", "tool"]:
        assert _is_tool_placeholder(s) is False


def test_process_stream_drops_tool_placeholder_message():
    placeholder = {"role": "assistant", "content": [{"text": "[tool]"}]}
    events = [
        {"message": placeholder},
        {"result": SimpleNamespace(stop_reason="end_turn", message=placeholder)},
    ]
    sent, send = _recorder()
    out, _ = asyncio.run(_process_stream(_astream(events), "wa-x", "chat", send))
    assert out == []
    assert sent == []
