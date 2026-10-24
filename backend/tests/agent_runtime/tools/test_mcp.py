import json
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_core.utils.function_calling import convert_to_openai_tool
from mcp.types import Tool

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.tools import mcp
from app.api.schemas.mcp_server import MCPServerWrite
from app.storage.services import mcp_server_service


async def test_remote_http_handshake_discovery_and_tool_execution(session, monkeypatch):
    """Exercise the SDK wire protocol and JSON schema through a real AgentTool."""
    calls = []

    def handle(request: httpx.Request):
        assert request.headers["authorization"] == "Bearer test"
        if request.method == "GET":
            return httpx.Response(405)
        payload = json.loads(request.content)
        calls.append(payload)
        method = payload["method"]
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "initialize":
            result = {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "test", "version": "1"},
            }
        elif method == "tools/list":
            result = {
                "tools": [
                    {
                        "name": "lookup",
                        "description": "Look up a reference",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                            "required": ["query"],
                        },
                    }
                ]
            }
        elif method == "tools/call":
            assert payload["params"] == {
                "name": "lookup",
                "arguments": {"query": "story"},
            }
            result = {
                "content": [{"type": "text", "text": "A reference"}],
                "isError": False,
            }
        else:
            raise AssertionError(method)
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result}
        )

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        mcp.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            transport=httpx.MockTransport(handle), **kwargs
        ),
    )
    server = await mcp_server_service.save_server(
        session,
        MCPServerWrite(
            name="References",
            url="https://mcp.example/mcp",
            headers={"Authorization": "Bearer test"},
        ),
    )
    tools = await mcp.build_mcp_tools(
        get_default_agent_definition("build"), session, {"active_agent": "build"}
    )
    assert len(tools) == 1
    tool = tools[0]
    spec = convert_to_openai_tool(tool)
    assert spec["function"]["parameters"]["required"] == ["query"]
    assert tool.name.startswith(f"mcp_{server.id}_")
    assert tool.pre_hooks == [mcp.auth_hook]
    # Approval policy has its own tests; bypass it here to exercise the transport.
    tool.pre_hooks = []
    result = json.loads(
        await tool.ainvoke(
            {"query": "story"}, config={"configurable": {"db_session": session}}
        )
    )
    assert result["success"] is True
    assert result["content"][0]["text"] == "A reference"
    assert [item["method"] for item in calls].count("initialize") == 2


async def test_global_disable_and_per_agent_opt_out_control_tool_availability(
    session, monkeypatch
):
    server = await mcp_server_service.save_server(
        session, MCPServerWrite(name="One", url="https://mcp.example")
    )
    discover = AsyncMock(
        return_value=[
            Tool(name="lookup", inputSchema={"type": "object", "properties": {}})
        ]
    )
    monkeypatch.setattr(mcp, "discover_tools", discover)
    primary = get_default_agent_definition("build")
    child = get_default_agent_definition("writer")
    for definition in (primary, child):
        assert len(await mcp.build_mcp_tools(definition, session, {})) == 1
        assert (
            await mcp.build_mcp_tools(
                replace(definition, disabled_mcp_servers=(server.id,)), session, {}
            )
            == []
        )
    assert discover.await_count == 2
    server.is_enabled = False
    await session.flush()
    assert await mcp.build_mcp_tools(primary, session, {}) == []
    assert discover.await_count == 2
    server.is_enabled = True
    await session.flush()
    assert len(await mcp.build_mcp_tools(primary, session, {})) == 1


async def test_unavailable_server_does_not_hide_other_tools(session, monkeypatch):
    for name in ("Offline", "Online"):
        await mcp_server_service.save_server(
            session, MCPServerWrite(name=name, url="https://mcp.example")
        )

    async def discover(server):
        if server.name == "Offline":
            raise OSError("Unavailable")
        return [Tool(name="lookup", inputSchema={"type": "object"})]

    monkeypatch.setattr(mcp, "discover_tools", discover)
    tools = await mcp.build_mcp_tools(
        get_default_agent_definition("build"), session, {}
    )
    assert len(tools) == 1 and tools[0].description.startswith("[Online]")


def test_names_are_stable_unique_and_provider_compatible():
    names = [
        mcp.tool_name(server, name)
        for server in ("server1", "server2")
        for name in ("a.b", "a_b", "长名称" * 100)
    ]
    assert len(set(names)) == len(names)
    assert all(len(name) <= 64 for name in names)
    assert mcp.tool_name("server1", "a.b") == names[0]


async def test_discovery_follows_pagination_and_closes_sse_session(monkeypatch):
    calls = []
    remote = SimpleNamespace(
        initialize=AsyncMock(),
        list_tools=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    tools=[Tool(name="one", inputSchema={})], nextCursor="page-2"
                ),
                SimpleNamespace(
                    tools=[Tool(name="two", inputSchema={})], nextCursor=None
                ),
            ]
        ),
    )

    @asynccontextmanager
    async def transport(url, **kwargs):
        calls.append((url, kwargs))
        try:
            yield ("read", "write")
        finally:
            calls.append("closed")

    @asynccontextmanager
    async def client(*args, **kwargs):
        yield remote

    monkeypatch.setattr(mcp, "sse_client", transport)
    monkeypatch.setattr(mcp, "ClientSession", client)
    server = mcp.MCPServer(name="SSE", url="https://mcp.example/sse", transport="sse")
    assert [tool.name for tool in await mcp.discover_tools(server)] == ["one", "two"]
    remote.initialize.assert_awaited_once()
    assert remote.list_tools.call_args_list[1].kwargs == {"cursor": "page-2"}
    assert calls[-1] == "closed"


async def test_primary_and_subagent_load_mcp_abilities(session, monkeypatch):
    from app.agent_runtime.graph.orchestrator.graph import _primary_mcp_tools
    from app.agent_runtime.runner.subagent_runner import SubagentRunner

    server = await mcp_server_service.save_server(
        session, MCPServerWrite(name="Shared", url="https://mcp.example")
    )
    monkeypatch.setattr(
        mcp,
        "discover_tools",
        AsyncMock(return_value=[Tool(name="lookup", inputSchema={})]),
    )
    config = {"configurable": {"db_session": session}}
    assert (
        len(await _primary_mcp_tools(config, "build", {"active_agent": "build"})) == 1
    )
    # The fixture owns this session's lifecycle.
    monkeypatch.setattr(
        "app.agent_runtime.runner.subagent_runner._close_session", AsyncMock()
    )
    runner = SubagentRunner(
        session_factory=lambda: session, model_config={}, project_id="project"
    )
    tools = await runner._build_tools(
        get_default_agent_definition("writer"), {"active_agent": "writer"}
    )
    assert any(tool.name == mcp.tool_name(server.id, "lookup") for tool in tools)


async def test_tool_rechecks_agent_opt_out_before_remote_call(session, monkeypatch):
    from app.storage.services.agent_definition_service import update_definition

    server = await mcp_server_service.save_server(
        session, MCPServerWrite(name="Shared", url="https://mcp.example")
    )
    remote_call = AsyncMock()
    monkeypatch.setattr(mcp, "remote_session", remote_call)
    tool = mcp.RemoteMCPTool(
        server=server,
        remote_name="lookup",
        name="lookup",
        _state={"active_agent": "build"},
    )
    tool._config = {"configurable": {"db_session": session}}
    await update_definition(session, "build", disabled_mcp_servers=[server.id])
    with pytest.raises(ValueError, match="disabled"):
        await tool._execute()
    remote_call.assert_not_called()
