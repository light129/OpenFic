"""Integration tests against a real SDK MCP server over TCP (no transport mocks)."""

import asyncio
import json
import socket
from types import SimpleNamespace

import pytest
import pytest_asyncio
import uvicorn
from langchain_core.runnables import RunnableConfig
from mcp.server.fastmcp import FastMCP
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.agent_runtime.graph.orchestrator.graph import _primary_mcp_tools
from app.agent_runtime.runner.subagent_runner import SubagentRunner
from app.agent_runtime.tools.mcp import RemoteMCPTool
from app.agent_runtime.tools.permission_metadata import (
    SETTING_KEY_AGENT_TOOL_PERMISSIONS,
)
from app.storage.repos import setting_repo


@pytest_asyncio.fixture(
    loop_scope="function",
    params=[
        pytest.param(("streamable_http", False), id="http-sse-responses"),
        pytest.param(("streamable_http", True), id="http-json-responses"),
        pytest.param(("sse", False), id="legacy-sse"),
    ],
)
async def live_mcp_server(request):
    transport, json_response = request.param
    executions = []
    authenticated_requests = []
    sdk = FastMCP(
        "OpenFic live integration", json_response=json_response, log_level="ERROR"
    )

    @sdk.tool()
    def add(left: int, right: int) -> dict[str, int]:
        """Add two integers on the remote server."""
        executions.append({"left": left, "right": right})
        return {"sum": left + right}

    @sdk.tool()
    def fail() -> str:
        """Return a deliberate MCP tool error."""
        raise ValueError("Deliberate integration test failure")

    app = sdk.sse_app() if transport == "sse" else sdk.streamable_http_app()

    async def authenticated_app(scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            if headers.get(b"authorization") != b"Bearer mcp-integration-test":
                await send(
                    {"type": "http.response.start", "status": 401, "headers": []}
                )
                await send({"type": "http.response.body", "body": b"Unauthorized"})
                return
            authenticated_requests.append(scope["path"])
        await app(scope, receive, send)

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.setblocking(False)
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(authenticated_app, log_level="error", ws="none")
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield SimpleNamespace(
            url=f"http://127.0.0.1:{port}/{'sse' if transport == 'sse' else 'mcp'}",
            transport=transport,
            executions=executions,
            authenticated_requests=authenticated_requests,
        )
    finally:
        server.should_exit = True
        try:
            async with asyncio.timeout(10):
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            listener.close()


async def test_live_remote_mcp_management_agent_calls_and_opt_out(
    live_mcp_server, client, session
):
    remote = live_mcp_server
    body = {"name": "Live MCP", "url": remote.url, "transport": remote.transport}
    response = await client.post("/api/v1/mcp-servers", json=body)
    assert response.status_code == 201
    server_id = response.json()["id"]
    endpoint = f"/api/v1/mcp-servers/{server_id}"

    # The real MCP server rejects a connection without its authentication header.
    assert (await client.post(f"{endpoint}/test")).status_code == 502
    body["headers"] = {"Authorization": "Bearer mcp-integration-test"}
    assert (await client.put(endpoint, json=body)).status_code == 200
    response = await client.post(f"{endpoint}/test")
    assert response.status_code == 200
    assert set(response.json()["tool_names"]) == {"add", "fail"}

    config: RunnableConfig = {"configurable": {"db_session": session}}
    primary_tools = await _primary_mcp_tools(config, "build", {"active_agent": "build"})
    assert len(primary_tools) == 2  # No per-agent activation is needed.
    await setting_repo.upsert(
        session,
        SETTING_KEY_AGENT_TOOL_PERMISSIONS,
        json.dumps(
            [{"tool_name": tool.name, "mode": "allow"} for tool in primary_tools]
        ),
    )
    await session.commit()
    primary_add = next(
        tool
        for tool in primary_tools
        if isinstance(tool, RemoteMCPTool) and tool.remote_name == "add"
    )
    result = json.loads(
        await primary_add.ainvoke({"left": 19, "right": 23}, config=config)
    )
    assert result["success"] is True
    assert result["structured_content"] == {"sum": 42}
    assert remote.executions == [{"left": 19, "right": 23}]

    # Exercise the actual subagent tool builder with its own DB session lifecycle.
    runner = SubagentRunner(
        session_factory=async_sessionmaker(bind=session.bind, expire_on_commit=False),
        model_config={},
        project_id="live-mcp-test",
    )
    definition = await runner._load_agent_definition("writer")
    child_tools = await runner._build_tools(definition, {"active_agent": "writer"})
    child_add = next(
        tool for tool in child_tools if getattr(tool, "remote_name", None) == "add"
    )
    result = json.loads(
        await child_add.ainvoke({"left": 30, "right": 12}, config=config)
    )
    assert result["success"] is True
    assert result["structured_content"] == {"sum": 42}
    assert len(remote.executions) == 2

    failure = next(
        tool
        for tool in primary_tools
        if isinstance(tool, RemoteMCPTool) and tool.remote_name == "fail"
    )
    result = json.loads(await failure.ainvoke({}, config=config))
    assert result["success"] is False
    assert "Deliberate integration test failure" in result["content"][0]["text"]

    response = await client.put(
        "/api/v1/agent-definitions/build", json={"disabled_mcp_servers": [server_id]}
    )
    assert response.status_code == 200
    # Even an already-built tool is prevented from calling the server after opt-out.
    result = json.loads(
        await primary_add.ainvoke({"left": 1, "right": 2}, config=config)
    )
    assert result["success"] is False
    assert len(remote.executions) == 2
    for enabled in (False, True):
        response = await client.patch(
            f"{endpoint}/enabled", json={"is_enabled": enabled}
        )
        assert response.status_code == 200
        assert (
            await _primary_mcp_tools(config, "build", {"active_agent": "build"}) == []
        )
    # The opt-out belongs to Build; Writer keeps access after a global off/on cycle.
    result = json.loads(
        await child_add.ainvoke({"left": 41, "right": 1}, config=config)
    )
    assert result["success"] is True
    assert len(remote.executions) == 3
    assert remote.authenticated_requests
    assert (await client.delete(endpoint)).status_code == 204
