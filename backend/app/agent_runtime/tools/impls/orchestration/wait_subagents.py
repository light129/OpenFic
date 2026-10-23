from __future__ import annotations

import asyncio
import json
from textwrap import dedent

from pydantic import BaseModel, Field

from app.agent_runtime.persistence.child_runs import (
    get_latest_child_run_requests,
)
from app.agent_runtime.persistence.model import AgentChildRun, AgentChildRunRequest
from app.agent_runtime.runner.background_subagents import (
    request_is_resolved,
    request_result_payload,
)
from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.orchestration.common import (
    POLL_INTERVAL_SECONDS,
    close_session,
    ensure_primary,
    get_configurable,
    open_session,
    resolve_child_run,
)
from app.agent_runtime.tools.registry import ToolRegistry


class WaitSubagentsInput(BaseModel):
    dispatch_ids: list[str] = Field(
        min_length=1,
        max_length=10,
        description="要等待的 Subagent 会话 ID；等待调用开始时各会话的最后一个请求。",
    )
    timeout_seconds: float = Field(
        default=30,
        ge=0,
        le=300,
        description="最长等待秒数，0 表示立即查看。超时不会取消后台任务。",
    )
    model_config = {"extra": "forbid"}


@ToolRegistry.register
class WaitSubagentsTool(AgentTool):
    name: str = "wait_subagents"
    description: str = dedent("""\
        等待一个或多个 Subagent 的结果，任一请求完成、失败、取消或等待用户审批时返回。
        使用 dispatch_subagent / notify_subagent 返回的 dispatch_id。
        返回 request_id、status 和已完成的 result/error；timed_out=true 表示尚无结果，任务仍会继续运行。
        仅在没有其他独立工作可做或确实需要结果时等待；不要短间隔循环查询。
    """)
    access_level: str = "readonly"
    args_schema: type[BaseModel] = WaitSubagentsInput

    async def _execute(
        self,
        dispatch_ids: list[str],
        timeout_seconds: float = 30,
    ) -> str:
        configurable = get_configurable(self.config)
        session_factory = configurable.get("session_factory")
        await ensure_primary(self._state, session_factory)
        children = [
            await resolve_child_run(
                parent_session_id=self.session_id,
                session_factory=session_factory,
                dispatch_id=dispatch_id,
            )
            for dispatch_id in dict.fromkeys(dispatch_ids)
        ]
        session = await open_session(session_factory)
        try:
            latest = await get_latest_child_run_requests(
                session, [row.id for row in children]
            )
            if any(row.id not in latest for row in children):
                raise ToolExecutionError("subagent request not found")
            targets = [(row.id, latest[row.id].id) for row in children]
        finally:
            await close_session(session)

        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            session = await open_session(session_factory)
            try:
                results = []
                for child_id, request_id in targets:
                    child = await session.get(AgentChildRun, child_id)
                    request = await session.get(AgentChildRunRequest, request_id)
                    if child is None or request is None:
                        raise ToolExecutionError("subagent request no longer exists")
                    if (
                        request_is_resolved(child, request)
                        or child.status == "waiting_user"
                        or not child.is_active
                    ):
                        results.append(request_result_payload(child, request))
                if results:
                    return json.dumps(
                        {"results": results, "timed_out": False}, ensure_ascii=False
                    )
            finally:
                await close_session(session)
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return json.dumps({"results": [], "timed_out": True})
            await asyncio.sleep(min(POLL_INTERVAL_SECONDS, remaining))
