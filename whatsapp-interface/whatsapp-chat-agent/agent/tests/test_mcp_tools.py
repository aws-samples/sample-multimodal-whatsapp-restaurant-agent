"""Unit tests for the chat-agent MCP tool helpers (Task 7.2).

Focus: ``sanitize_tool_names`` - the Nova Pro / Converse hyphen workaround.
Amazon Nova Pro errors with "Model produced invalid sequence as part of ToolUse"
when a tool name contains a hyphen (the AgentCore Gateway always prefixes names
with the hyphenated target, e.g. ``qsr-backend-api___GeocodeAddress``). The fix
rebuilds each tool with a hyphen-free ``name_override`` (the model-facing name),
while the gateway call keeps the original ``mcp_tool.name``.

strands is not installed in the test/lint environment, so the rename path lazily
imports ``strands.tools.mcp.mcp_agent_tool``; these tests inject a fake module so
the logic is exercised without the real SDK.
"""
from __future__ import annotations

import sys
import types

import mcp_tools


class _FakeMCPTool:
    def __init__(self, name: str) -> None:
        self.name = name
        self.inputSchema = {"type": "object", "properties": {}}


class _FakeTool:
    """Stand-in for a strands MCPAgentTool returned by list_tools_sync()."""

    def __init__(self, name: str) -> None:
        self.mcp_tool = _FakeMCPTool(name)
        self.mcp_client = object()
        self.timeout = None


def _install_fake_mcp_agent_tool(monkeypatch):
    """Register a fake strands MCPAgentTool (and parent packages) in sys.modules.

    Returns the list that records every fake tool constructed, so a test can
    assert what name_override / mcp_tool the rename path passed through.
    """
    created = []

    class FakeMCPAgentTool:
        def __init__(self, mcp_tool, mcp_client, name_override=None, timeout=None):
            self.mcp_tool = mcp_tool
            self.mcp_client = mcp_client
            self.name_override = name_override
            self.timeout = timeout
            created.append(self)

        @property
        def tool_name(self):
            return self.name_override or self.mcp_tool.name

    for pkg in ("strands", "strands.tools", "strands.tools.mcp"):
        monkeypatch.setitem(sys.modules, pkg, types.ModuleType(pkg))
    mod = types.ModuleType("strands.tools.mcp.mcp_agent_tool")
    mod.MCPAgentTool = FakeMCPAgentTool
    monkeypatch.setitem(sys.modules, "strands.tools.mcp.mcp_agent_tool", mod)
    return created


def test_sanitize_renames_hyphenated_tool(monkeypatch):
    created = _install_fake_mcp_agent_tool(monkeypatch)
    tools = [_FakeTool("qsr-backend-api___GeocodeAddress")]

    out = mcp_tools.sanitize_tool_names(tools)

    assert len(out) == 1
    # The model-facing name is hyphen-free...
    assert out[0].name_override == "qsr_backend_api___GeocodeAddress"
    # ...but the original gateway name is preserved on the (same) mcp_tool object
    # so the actual MCP call still resolves at the gateway.
    assert out[0].mcp_tool is tools[0].mcp_tool
    assert out[0].mcp_tool.name == "qsr-backend-api___GeocodeAddress"
    assert len(created) == 1


def test_sanitize_passthrough_when_no_hyphen(monkeypatch):
    created = _install_fake_mcp_agent_tool(monkeypatch)
    plain = _FakeTool("plain_tool_name")

    out = mcp_tools.sanitize_tool_names([plain])

    # No hyphen -> tool is returned untouched and never rebuilt.
    assert out[0] is plain
    assert created == []


def test_sanitize_only_replaces_hyphens(monkeypatch):
    _install_fake_mcp_agent_tool(monkeypatch)
    tools = [_FakeTool("a-b-c___DoThing")]

    out = mcp_tools.sanitize_tool_names(tools)

    assert out[0].name_override == "a_b_c___DoThing"
