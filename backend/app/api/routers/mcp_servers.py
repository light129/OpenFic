"""Remote MCP server management, following the Agent settings lock."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.agent_settings_lock import require_agent_settings_unlocked
from app.api.schemas.mcp_server import (
    MCPServerResponse,
    MCPServerTestResponse,
    MCPServerToggle,
    MCPServerWrite,
)
from app.storage.database import get_session
from app.storage.services import mcp_server_service as service

router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])


def _response(server) -> MCPServerResponse:
    return MCPServerResponse(
        **server.model_dump(exclude={"headers_encrypted"}),
        header_names=list(service.get_headers(server)),
    )


@router.get("", response_model=list[MCPServerResponse])
async def list_servers(session: AsyncSession = Depends(get_session)):
    return [_response(server) for server in await service.list_servers(session)]


@router.post("", response_model=MCPServerResponse, status_code=201)
async def create_server(
    body: MCPServerWrite, session: AsyncSession = Depends(get_session)
):
    await require_agent_settings_unlocked(session)
    server = await service.save_server(session, body)
    await session.commit()
    return _response(server)


@router.put("/{server_id}", response_model=MCPServerResponse)
async def update_server(
    server_id: str, body: MCPServerWrite, session: AsyncSession = Depends(get_session)
):
    await require_agent_settings_unlocked(session)
    server = await service.save_server(session, body, server_id)
    await session.commit()
    return _response(server)


@router.patch("/{server_id}/enabled", response_model=MCPServerResponse)
async def toggle_server(
    server_id: str, body: MCPServerToggle, session: AsyncSession = Depends(get_session)
):
    await require_agent_settings_unlocked(session)
    server = await service.get_server(session, server_id)
    server.is_enabled = body.is_enabled
    server.updated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(server)
    return _response(server)


@router.delete("/{server_id}", status_code=204)
async def delete_server(server_id: str, session: AsyncSession = Depends(get_session)):
    await require_agent_settings_unlocked(session)
    await session.delete(await service.get_server(session, server_id))
    await session.commit()


@router.post("/{server_id}/test", response_model=MCPServerTestResponse)
async def test_server(server_id: str, session: AsyncSession = Depends(get_session)):
    from app.agent_runtime.tools.mcp import discover_tools

    server = await service.get_server(session, server_id)
    try:
        tools = await discover_tools(server)
    except Exception:
        # Transport errors can contain URLs or authentication headers.
        raise HTTPException(
            502, "MCP connection failed. Check the URL, transport and authentication."
        ) from None
    return MCPServerTestResponse(tool_names=[tool.name for tool in tools])
