from importlib import import_module

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


def test_agent_board_migration_defaults_deduplication_cascade_and_downgrade():
    migration = import_module("app.storage.migrations.versions.1031_agent_board")
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            connection.execute(text("CREATE TABLE tasks (id TEXT PRIMARY KEY)"))
            connection.execute(text("INSERT INTO tasks VALUES ('existing-task')"))
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            connection.execute(
                text(
                    "INSERT INTO agent_boards (root_session_id, task_id, project_id) "
                    "VALUES ('root', 'existing-task', 'project')"
                )
            )
            assert connection.execute(
                text("SELECT sequence, message_count, message_bytes FROM agent_boards")
            ).one() == (0, 0, 0)
            insert_message = text(
                "INSERT INTO agent_board_messages "
                "(id, root_session_id, seq, sender, recipient, kind, body, source_call, created_at) "
                "VALUES (:id, 'root', :seq, 'main', 'ALL', 'INFO', 'original', :call, CURRENT_TIMESTAMP)"
            )
            connection.execute(
                insert_message, {"id": "first", "seq": 1, "call": "tool-1"}
            )
            assert (
                connection.execute(
                    text("SELECT retracted FROM agent_board_messages")
                ).scalar_one()
                == 0
            )
            # The migration enforces both message order and replay deduplication.
            for params in [
                {"id": "same-order", "seq": 1, "call": "tool-2"},
                {"id": "same-call", "seq": 2, "call": "tool-1"},
            ]:
                with pytest.raises(IntegrityError), connection.begin_nested():
                    connection.execute(insert_message, params)
            connection.execute(
                text(
                    "INSERT INTO agent_board_read_states (root_session_id, participant) VALUES ('root', 'main')"
                )
            )
            assert (
                connection.execute(
                    text("SELECT seen_seq FROM agent_board_read_states")
                ).scalar_one()
                == 0
            )
            connection.execute(text("DELETE FROM tasks WHERE id='existing-task'"))
            for table in [
                "agent_boards",
                "agent_board_messages",
                "agent_board_read_states",
            ]:
                assert (
                    connection.execute(
                        text(f"SELECT COUNT(*) FROM {table}")
                    ).scalar_one()
                    == 0
                )
            connection.execute(text("INSERT INTO tasks VALUES ('preserved')"))
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            assert inspect(connection).get_table_names() == ["tasks"]
            assert (
                connection.execute(text("SELECT id FROM tasks")).scalar_one()
                == "preserved"
            )
    finally:
        engine.dispose()
