"""Only remote HTTP/SSE transports are accepted, including through the API."""

import re
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MCPServerWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=4096)
    type: Literal["remote"] = "remote"
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] | None = None
    is_enabled: bool = True

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: str) -> str:
        return value.strip() if isinstance(value, str) else value

    @field_validator("url")
    @classmethod
    def remote_url(cls, value: str) -> str:
        value = value.strip()
        parts = urlsplit(value)
        if (
            parts.scheme not in ("http", "https")
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.fragment
            or any(char.isspace() or ord(char) < 32 for char in value)
        ):
            raise ValueError(
                "MCP URL must be an HTTP(S) URL without credentials or fragments"
            )
        # Accessing port also validates malformed port values.
        _ = parts.port
        return value

    @field_validator("headers")
    @classmethod
    def valid_headers(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        for key, header in (value or {}).items():
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key):
                raise ValueError("Invalid HTTP header name")
            if any(ord(char) < 32 or ord(char) == 127 for char in header):
                raise ValueError("Invalid HTTP header value")
        return value


class MCPServerResponse(BaseModel):
    id: str
    name: str
    url: str
    type: Literal["remote"] = "remote"
    transport: Literal["streamable_http", "sse"]
    header_names: list[str]
    is_enabled: bool
    created_at: datetime
    updated_at: datetime


class MCPServerToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_enabled: bool


class MCPServerTestResponse(BaseModel):
    tool_names: list[str]
