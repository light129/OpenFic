"""Remote MCP tools shared by primary agents and subagents.

Each operation owns its client session so connections are closed on success,
failure and cancellation, including interrupted/resumed Agent tool calls.
"""

import asyncio
import hashlib
import json
import re
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import httpx
from loguru import logger
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import Tool
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import AgentDefinition, load_agent_definition
from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.hooks.auth import auth_hook
from app.storage.models.mcp_server import MCPServer
from app.storage.services import mcp_server_service


@asynccontextmanager
async def remote_session(server: MCPServer):
    headers = mcp_server_service.get_headers(server)
    if server.transport == "sse":
        async with sse_client(
            server.url, headers=headers, timeout=15, sse_read_timeout=60
        ) as streams:
            async with ClientSession(
                *streams, read_timeout_seconds=timedelta(seconds=60)
            ) as session:
                await session.initialize()
                yield session
    elif server.transport == "streamable_http":
        async with httpx.AsyncClient(
            headers=headers, timeout=httpx.Timeout(60, connect=15)
        ) as client:
            async with streamable_http_client(server.url, http_client=client) as (
                read,
                write,
                _,
            ):
                async with ClientSession(
                    read, write, read_timeout_seconds=timedelta(seconds=60)
                ) as session:
                    await session.initialize()
                    yield session
    else:
        raise ValueError("Unsupported remote MCP transport")


async def discover_tools(server: MCPServer) -> list[Tool]:
    async with asyncio.timeout(15):
        async with remote_session(server) as session:
            tools: list[Tool] = []
            cursor = None
            seen: set[str] = set()
            while True:
                result = await session.list_tools(cursor=cursor)
                tools.extend(result.tools)
                cursor = result.nextCursor
                if not cursor:
                    return tools
                if cursor in seen:
                    raise ValueError("Repeated MCP tools pagination cursor")
                seen.add(cursor)


def tool_name(server_id: str, remote_name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", remote_name)[:24]
    digest = hashlib.sha256(remote_name.encode()).hexdigest()[:8]
    return f"mcp_{server_id}_{slug}_{digest}"[:64]


class RemoteMCPTool(AgentTool):
    # JSON schema is supplied by the MCP server and passed through to the model.
    args_schema: Any = Field(default_factory=dict)
    server: MCPServer = Field(exclude=True, repr=False)
    remote_name: str

    async def _execute(self, **kwargs: Any) -> str:
        server = self.server
        db_session = self.get_runtime_db_session()
        if db_session is not None:
            server = await mcp_server_service.get_server(db_session, server.id)
            definition = await load_agent_definition(
                db_session, self._state["active_agent"]
            )
            if not server.is_enabled or server.id in definition.disabled_mcp_servers:
                raise ValueError("MCP Server is disabled for this Agent")
        try:
            async with asyncio.timeout(60):
                async with remote_session(server) as session:
                    result = await session.call_tool(self.remote_name, arguments=kwargs)
        except Exception:
            # Do not propagate transport exceptions containing credentials into logs/model output.
            raise ValueError(
                "MCP tool call failed. Check the server connection and authentication."
            ) from None
        return json.dumps(
            {
                "success": not result.isError,
                "content": [
                    item.model_dump(mode="json", exclude_none=True)
                    for item in result.content
                ],
                "structured_content": result.structuredContent,
            },
            ensure_ascii=False,
        )


async def build_mcp_tools(
    definition: AgentDefinition,
    db_session: AsyncSession,
    state: dict[str, Any],
) -> list[AgentTool]:
    servers = [
        server
        for server in await mcp_server_service.list_servers(db_session)
        if server.is_enabled and server.id not in definition.disabled_mcp_servers
    ]
    semaphore = asyncio.Semaphore(4)

    async def build(server: MCPServer) -> list[AgentTool]:
        async with semaphore:
            try:
                remote_tools = await discover_tools(server)
                return [
                    RemoteMCPTool(
                        name=tool_name(server.id, remote.name),
                        description=f"[{server.name}] {remote.name}: {remote.description or remote.name}",
                        args_schema=remote.inputSchema,
                        server=server,
                        remote_name=remote.name,
                        _state=state,
                        _pre_hooks=[auth_hook],
                    )
                    for remote in remote_tools
                ]
            except Exception:
                # One unavailable server must not prevent the rest of the Agent from running.
                logger.warning("MCP tool discovery failed for server {}", server.id)
                return []

    return [
        tool
        for group in await asyncio.gather(*(build(server) for server in servers))
        for tool in group
    ]
