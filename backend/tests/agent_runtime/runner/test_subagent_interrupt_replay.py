from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.runner import subagent_runner
from app.agent_runtime.streaming.replay_buffer import AgentEventReplayBuffer


@pytest.mark.asyncio
async def test_joining_paused_child_cannot_replay_running_events_over_approval(
    monkeypatch,
):
    buffer = AgentEventReplayBuffer()
    for session_id in ("child", "other-child"):
        buffer.record_unlocked(
            "agent:node",
            {"session_id": session_id, "phase": "start", "node": "explore"},
        )
        buffer.record_unlocked(
            "agent:tool_call",
            {"session_id": session_id, "tool_call_id": "write", "tool": "write_note"},
        )
    monkeypatch.setattr(
        subagent_runner, "get_agent_event_replay_buffer", lambda: buffer
    )
    emitted = AsyncMock()
    monkeypatch.setattr(subagent_runner, "emit", emitted)
    runner = subagent_runner.SubagentRunner(model_config={}, project_id="project")

    await runner._emit_child_interrupt(
        SimpleNamespace(child_thread_id="child"),
        {"type": "tool_approval", "approval_id": "approval", "tool_call_id": "write"},
    )

    # A browser that loads persisted approval state and then joins must not
    # receive the old running/tool stream, which removes its approval panel.
    assert buffer.replay_events_unlocked("child") == []
    assert len(buffer.replay_events_unlocked("other-child")) == 2
    assert emitted.await_args.args[0] == "agent:interrupt"
    assert emitted.await_args.args[1]["approval_id"] == "approval"
