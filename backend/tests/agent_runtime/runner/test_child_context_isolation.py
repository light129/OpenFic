import asyncio

from langchain_core.runnables.config import var_child_runnable_config
import pytest

from app.agent_runtime.runner.run_registry import AgentRunRegistry
from app.agent_runtime.tools.impls.orchestration import common


@pytest.mark.asyncio
@pytest.mark.parametrize("resume", [False, True])
async def test_child_run_does_not_inherit_parent_tool_approval_or_callbacks(
    monkeypatch, resume
):
    registry = AgentRunRegistry()
    monkeypatch.setattr(common, "get_agent_run_registry", lambda: registry)
    observed = asyncio.Future()

    class Runner:
        async def run(self, _child_id):
            observed.set_result(var_child_runnable_config.get())

        async def resume(self, _child_id, _payload):
            observed.set_result(var_child_runnable_config.get())

    parent_config = {
        "metadata": {
            "openfic_skip_pre_hooks": True,
            "openfic_phase": "execute",
            "tool_call_id": "parent-dispatch",
        },
        "callbacks": [],
        "configurable": {"thread_id": "parent"},
    }
    token = var_child_runnable_config.set(parent_config)
    try:
        assert await common.ensure_child_processing(
            parent_session_id="parent",
            child_run_id="child",
            runner=Runner(),
            resume_payload={"approved": True} if resume else None,
        )
        assert await asyncio.wait_for(observed, timeout=2) is None
        assert var_child_runnable_config.get() is parent_config
    finally:
        var_child_runnable_config.reset(token)
        await registry.cancel_all()
