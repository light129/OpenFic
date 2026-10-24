"""Persistence and encrypted authentication headers for remote MCP servers."""

import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.api.schemas.mcp_server import MCPServerWrite
from app.core.encryption import EncryptionService
from app.core.errors import NotFoundError
from app.settings import settings
from app.storage.models.mcp_server import MCPServer


def get_headers(server: MCPServer) -> dict[str, str]:
    if not server.headers_encrypted:
        return {}
    return json.loads(
        EncryptionService(settings.encryption_key).decrypt(server.headers_encrypted)
    )


async def list_servers(session: AsyncSession) -> list[MCPServer]:
    result = await session.execute(
        select(MCPServer).order_by(col(MCPServer.created_at), col(MCPServer.id))
    )
    return list(result.scalars())


async def get_server(session: AsyncSession, server_id: str) -> MCPServer:
    server = await session.get(MCPServer, server_id)
    if server is None:
        raise NotFoundError("MCP Server 不存在")
    return server


async def save_server(
    session: AsyncSession, data: MCPServerWrite, server_id: str | None = None
) -> MCPServer:
    server = (
        await get_server(session, server_id)
        if server_id
        else MCPServer(name=data.name, url=data.url)
    )
    server.name = data.name
    server.url = data.url
    server.transport = data.transport
    server.is_enabled = data.is_enabled
    if data.headers is not None:
        server.headers_encrypted = (
            EncryptionService(settings.encryption_key).encrypt(json.dumps(data.headers))
            if data.headers
            else ""
        )
    server.updated_at = datetime.now(UTC)
    session.add(server)
    await session.flush()
    await session.refresh(server)
    return server
