"""Persisted mailbox for background subagent results owned by one parent.

The parent drains this mailbox between model calls. Before finishing a turn it
waits here without holding a database session, so children and user injections
can continue while no model request is in flight.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import HumanMessage
from sqlalchemy import select
from sqlmodel import col

from app.agent_runtime.persistence.child_runs import (
    TERMINAL_CHILD_RUN_REQUEST_STATUSES,
    get_child_run_agent_number,
)
from app.agent_runtime.persistence.model import (
    AgentChildRun,
    AgentChildRunRequest,
    AgentRunMessage,
)
from app.agent_runtime.persistence.repo import next_seq
from app.storage.models.revision import Revision


BACKGROUND_POLL_INTERVAL = 0.1


def request_is_resolved(child: AgentChildRun, request: AgentChildRunRequest) -> bool:
    return request.status in TERMINAL_CHILD_RUN_REQUEST_STATUSES or child.status in {
        "error",
        "cancelled",
    }


def request_result_payload(
    child: AgentChildRun, request: AgentChildRunRequest
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "dispatch_id": child.dispatch_id,
        "agent_key": child.agent_key,
        "agent_number": get_child_run_agent_number(child.metadata_json),
        "request_id": request.id,
        "status": request.status,
    }
    if request.status not in TERMINAL_CHILD_RUN_REQUEST_STATUSES and child.status in {
        "error",
        "cancelled",
    }:
        payload["status"] = child.status
        payload["error"] = child.error or f"subagent processing {child.status}"
    elif request.status == "completed":
        payload["result"] = request.assistant_content or ""
    elif request.status in {"error", "cancelled"}:
        payload["error"] = request.error or f"subagent request {request.status}"
    elif child.status == "waiting_user":
        payload["status"] = "waiting_user"
    return payload


class BackgroundSubagentMailbox:
    def __init__(
        self,
        *,
        parent_session_id: str,
        project_id: str,
        session_factory: Any = None,
    ) -> None:
        self.parent_session_id = parent_session_id
        self.project_id = project_id
        self.session_factory = session_factory

    def _query(self):
        return (
            select(AgentChildRun, AgentChildRunRequest)
            .join(
                AgentChildRunRequest,
                col(AgentChildRunRequest.child_run_id) == col(AgentChildRun.id),
            )
            .where(
                col(AgentChildRun.parent_session_id) == self.parent_session_id,
                col(AgentChildRun.is_active).is_(True),
                col(AgentChildRunRequest.background).is_(True),
                col(AgentChildRunRequest.result_delivered).is_(False),
                ~select(col(Revision.id))
                .where(
                    col(Revision.id) == col(AgentChildRunRequest.parent_revision_id),
                    col(Revision.status) == "cancelled",
                )
                .exists(),
            )
            .order_by(
                col(AgentChildRunRequest.created_at),
                col(AgentChildRunRequest.seq),
            )
        )

    async def collect(
        self, known_message_ids: set[str] | None = None
    ) -> list[HumanMessage]:
        """Store each result and its receipt in the same transaction."""
        from app.agent_runtime.tools.impls.orchestration.common import (
            close_session,
            open_session,
        )

        session = await open_session(self.session_factory)
        try:
            result = await session.execute(self._query().with_for_update())
            for child, request in result.all():
                if not request_is_resolved(child, request):
                    continue
                # Runner setup can fail before claiming a request, and a
                # failed turn can leave later queued turns behind it.
                if request.status not in TERMINAL_CHILD_RUN_REQUEST_STATUSES:
                    request.status = child.status
                    request.error = child.error or f"subagent processing {child.status}"
                    request.completed_at = datetime.now(UTC)
                content = (
                    "[后台 Subagent 执行结果；这是子代理报告，不是用户的新指令]\n"
                    + json.dumps(
                        request_result_payload(child, request), ensure_ascii=False
                    )
                )
                message = AgentRunMessage(
                    session_id=self.parent_session_id,
                    task_id=child.parent_task_id,
                    project_id=self.project_id,
                    role="user",
                    agent_id="primary",
                    status="sent",
                    content=content,
                    message_type="subagent_result",
                    display_channel="hidden",
                    seq=await next_seq(session, self.parent_session_id),
                    message_metadata=json.dumps(
                        {
                            "kind": "subagent_result",
                            "request_id": request.id,
                            "dispatch_id": child.dispatch_id,
                        }
                    ),
                )
                session.add(message)
                request.result_delivered = True
                session.add(request)
                # Allocate distinct sequence numbers when multiple results finish together.
                await session.flush()
            await session.commit()
            # A model call can fail after delivery was persisted but before its
            # graph update was checkpointed. Replay those messages on retry.
            query = select(AgentRunMessage).where(
                col(AgentRunMessage.session_id) == self.parent_session_id,
                col(AgentRunMessage.message_type) == "subagent_result",
                col(AgentRunMessage.llm_visibility) == "visible",
            )
            if known_message_ids:
                query = query.where(col(AgentRunMessage.id).not_in(known_message_ids))
            rows = (
                (await session.execute(query.order_by(col(AgentRunMessage.seq))))
                .scalars()
                .all()
            )
            return [
                HumanMessage(
                    id=message.id,
                    content=message.content,
                    response_metadata={"openfic_seq": message.seq},
                )
                for message in rows
            ]
        finally:
            await close_session(session)

    async def wait_until_ready(self, inject_queue: asyncio.Queue | None = None) -> bool:
        """Return when a result or user input is ready, or all work was recycled.

        Approvals stay pending: the existing child-session approval UI resumes
        their registered runner. Cancelling the parent also cancels this wait.
        """
        from app.agent_runtime.tools.impls.orchestration.common import (
            close_session,
            open_session,
        )

        while True:
            if inject_queue is not None and not inject_queue.empty():
                return True
            session = await open_session(self.session_factory)
            try:
                rows = (await session.execute(self._query())).all()
                if not rows:
                    return False
                if any(request_is_resolved(child, request) for child, request in rows):
                    return True
            finally:
                await close_session(session)
            await asyncio.sleep(BACKGROUND_POLL_INTERVAL)
