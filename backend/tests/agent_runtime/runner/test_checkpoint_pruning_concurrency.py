import asyncio

from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
import pytest

from app.agent_runtime.runner.checkpointer import prune_checkpoints_for_thread


async def save(saver, thread_id, checkpoint_id):
    checkpoint = empty_checkpoint()
    checkpoint["id"] = checkpoint_id
    return await saver.aput(
        {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {},
        {},
    )


@pytest.mark.asyncio
async def test_parallel_child_pruning_and_saver_writes_share_transaction_lock():
    async with AsyncSqliteSaver.from_conn_string(":memory:") as saver:
        for index in range(10):
            for checkpoint_id in ("cp-001", "cp-002", "cp-003"):
                await save(saver, f"child-{index}", checkpoint_id)
        await asyncio.gather(
            *[
                operation
                for index in range(10)
                for operation in (
                    prune_checkpoints_for_thread(saver, f"child-{index}", {"cp-001"}),
                    save(saver, f"child-{index}", "cp-004"),
                )
            ]
        )
        assert not saver.conn.in_transaction
        for index in range(10):
            history = [
                item
                async for item in saver.alist(
                    {"configurable": {"thread_id": f"child-{index}"}}
                )
            ]
            retained = {item.checkpoint["id"] for item in history}
            assert {"cp-001", "cp-004"} <= retained
            assert "cp-002" not in retained


@pytest.mark.asyncio
async def test_cancelled_child_pruning_rolls_back_before_releasing_saver_lock(
    monkeypatch,
):
    async with AsyncSqliteSaver.from_conn_string(":memory:") as saver:
        await save(saver, "child", "cp-001")
        await save(saver, "child", "cp-002")
        entered = asyncio.Event()
        hold = asyncio.Event()
        original_execute = saver.conn.execute

        async def execute(sql, *args, **kwargs):
            result = await original_execute(sql, *args, **kwargs)
            if sql == "BEGIN":
                entered.set()
                await hold.wait()
            return result

        monkeypatch.setattr(saver.conn, "execute", execute)
        task = asyncio.create_task(prune_checkpoints_for_thread(saver, "child", set()))
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not saver.conn.in_transaction
        assert not saver.lock.locked()
        monkeypatch.setattr(saver.conn, "execute", original_execute)
        await asyncio.wait_for(save(saver, "child", "cp-003"), timeout=2)
