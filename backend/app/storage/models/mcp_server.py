"""Remote MCP server configuration."""

from datetime import UTC, datetime

from sqlalchemy import Column, Text
from sqlmodel import Field, SQLModel

from app.core.ids import generate_id


class MCPServer(SQLModel, table=True):
    __tablename__ = "mcp_servers"

    id: str = Field(default_factory=generate_id, primary_key=True)
    name: str = Field(max_length=200)
    url: str = Field(sa_column=Column(Text, nullable=False))
    transport: str = Field(default="streamable_http", max_length=30)
    headers_encrypted: str = Field(default="", sa_column=Column(Text, nullable=False))
    is_enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
