from importlib import import_module

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_background_subagent_migration_preserves_existing_requests():
    migration = import_module(
        "app.storage.migrations.versions.1030_background_subagents"
    )
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE agent_child_run_requests (id TEXT PRIMARY KEY, content TEXT NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO agent_child_run_requests VALUES ('old', 'preserve me')"
                )
            )
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            assert connection.execute(
                text(
                    "SELECT content, background, result_delivered FROM agent_child_run_requests"
                )
            ).one() == ("preserve me", 0, 0)
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            assert {
                c["name"]
                for c in inspect(connection).get_columns("agent_child_run_requests")
            } == {"id", "content"}
            assert (
                connection.execute(
                    text("SELECT content FROM agent_child_run_requests")
                ).scalar_one()
                == "preserve me"
            )
    finally:
        engine.dispose()
