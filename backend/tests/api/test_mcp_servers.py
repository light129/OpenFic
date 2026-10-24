from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import load_agent_definition
from app.storage.services import mcp_server_service
from tests.api.test_agent_settings_lock import _create_agent_task

URL = "/api/v1/mcp-servers"
CONFIG = {"name": "Reference", "url": "https://mcp.example/mcp"}


async def test_remote_mcp_crud_and_encrypted_headers(
    client: AsyncClient, session: AsyncSession
):
    response = await client.post(
        URL, json={**CONFIG, "headers": {"Authorization": "Bearer secret"}}
    )
    assert response.status_code == 201
    server = response.json()
    assert server["type"] == "remote" and server["is_enabled"] is True
    assert server["header_names"] == ["Authorization"]
    assert "secret" not in response.text
    record = await mcp_server_service.get_server(session, server["id"])
    assert "secret" not in record.headers_encrypted
    assert mcp_server_service.get_headers(record) == {"Authorization": "Bearer secret"}
    endpoint = f"{URL}/{server['id']}"

    response = await client.put(
        endpoint, json={**CONFIG, "name": "Renamed", "transport": "sse"}
    )
    assert response.status_code == 200
    assert response.json()["header_names"] == ["Authorization"]
    assert mcp_server_service.get_headers(record) == {"Authorization": "Bearer secret"}
    assert response.json()["transport"] == "sse"
    assert (
        await client.patch(f"{endpoint}/enabled", json={"is_enabled": False})
    ).json()["is_enabled"] is False
    response = await client.put(endpoint, json={**CONFIG, "headers": {}})
    assert response.json()["header_names"] == []
    assert (await client.get(URL)).json()[0]["id"] == server["id"]
    assert (await client.delete(endpoint)).status_code == 204
    assert (await client.get(URL)).json() == []
    assert (await client.put(endpoint, json=CONFIG)).status_code == 404


@pytest.mark.parametrize(
    "extra",
    [
        {"type": "local"},
        {"transport": "stdio"},
        {"command": "npx", "args": ["server"]},
        {"url": "file:///tmp/server"},
        {"url": "https://user:password@example.com/mcp"},
        {"url": "https://example.com:invalid/mcp"},
        {"url": "https://example.com/#fragment"},
        {"name": "   "},
        {"headers": {"Authorization": "Bearer x\r\nInjected: true"}},
    ],
)
async def test_reject_local_and_invalid_config(client: AsyncClient, extra):
    assert (await client.post(URL, json={**CONFIG, **extra})).status_code == 422
    assert (await client.get(URL)).json() == []


async def test_mcp_defaults_and_agent_opt_out_survive_global_toggle(
    client: AsyncClient, session: AsyncSession
):
    server_id = (await client.post(URL, json=CONFIG)).json()["id"]
    for key in ("build", "writer"):
        definition = (await client.get(f"/api/v1/agent-definitions/{key}")).json()
        assert definition["disabled_mcp_servers"] == []
    response = await client.put(
        "/api/v1/agent-definitions/build", json={"disabled_mcp_servers": [server_id]}
    )
    assert response.status_code == 200
    assert response.json()["disabled_mcp_servers"] == [server_id]
    for enabled in (False, True):
        await client.patch(f"{URL}/{server_id}/enabled", json={"is_enabled": enabled})
        assert (await load_agent_definition(session, "build")).disabled_mcp_servers == (
            server_id,
        )
        assert (
            await load_agent_definition(session, "writer")
        ).disabled_mcp_servers == ()
    created = await client.post(
        "/api/v1/agent-definitions",
        json={
            "key": "new-agent",
            "display_name": "New",
            "kind": "subagent",
            "prompt_agent_name": "new-agent",
        },
    )
    assert created.status_code == 201
    assert created.json()["disabled_mcp_servers"] == []
    await client.put(
        "/api/v1/agent-definitions/build", json={"disabled_mcp_servers": []}
    )
    assert (await load_agent_definition(session, "build")).disabled_mcp_servers == ()


async def test_mcp_mutations_follow_agent_lock(
    client: AsyncClient, session: AsyncSession
):
    server_id = (await client.post(URL, json=CONFIG)).json()["id"]
    await _create_agent_task(client, session, is_running=True)
    responses = [
        await client.post(URL, json=CONFIG),
        await client.put(f"{URL}/{server_id}", json=CONFIG),
        await client.patch(f"{URL}/{server_id}/enabled", json={"is_enabled": False}),
        await client.delete(f"{URL}/{server_id}"),
    ]
    assert all(response.status_code == 409 for response in responses)
    assert (await client.get(URL)).status_code == 200


async def test_connection_errors_do_not_echo_credentials(
    client: AsyncClient, monkeypatch
):
    server_id = (await client.post(URL, json=CONFIG)).json()["id"]
    monkeypatch.setattr(
        "app.agent_runtime.tools.mcp.discover_tools",
        AsyncMock(side_effect=RuntimeError("Bearer secret")),
    )
    response = await client.post(f"{URL}/{server_id}/test")
    assert response.status_code == 502
    assert "secret" not in response.text
