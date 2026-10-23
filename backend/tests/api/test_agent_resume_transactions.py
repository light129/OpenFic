import asyncio

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from app.api.routers.agent_runtime import _claim_agent_session_resume
from app.storage.models.project import Project
from app.storage.models.revision import Revision
from app.storage.models.task import Task


@pytest.mark.asyncio
async def test_active_parent_child_approval_releases_sqlite_writer_for_launch(tmp_path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path}/approval.db", connect_args={"timeout": 0.1}
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(SQLModel.metadata.create_all)
        async with factory() as session:
            session.add(Project(id="project", title="Project"))
            session.add(
                Task(
                    id="task",
                    project_id="project",
                    title="Task",
                    mode="agent",
                    agent_session_id="parent",
                    current_revision_id="revision",
                )
            )
            session.add(
                Revision(
                    id="revision",
                    project_id="project",
                    message="Run",
                    status="active",
                    project_snapshot_title="Project",
                )
            )
            await session.commit()
        async with factory() as approval_session:
            assert await _claim_agent_session_resume(
                approval_session, "parent", allow_active=True
            ) == ("revision", False)
            # The approval request remains open while launch updates task state
            # using its own connection. A no-op claim UPDATE must not block it.
            async with factory() as launch_session:
                await asyncio.wait_for(
                    launch_session.execute(
                        update(Task).where(Task.id == "task").values(is_running=True)
                    ),
                    timeout=1,
                )
                await launch_session.commit()
    finally:
        await engine.dispose()
