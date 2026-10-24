import importlib
import json

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_existing_agents_default_to_all_mcp_servers_and_migration_round_trip(
    tmp_path, monkeypatch
):
    migration = importlib.import_module(
        "app.storage.migrations.versions.1030_add_remote_mcp_servers"
    )
    engine = create_engine(f"sqlite:///{tmp_path / 'mcp.db'}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE agent_definitions (id TEXT PRIMARY KEY, display_name TEXT NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO agent_definitions VALUES ('custom', 'Existing Agent')"
                )
            )
            monkeypatch.setattr(
                migration, "op", Operations(MigrationContext.configure(connection))
            )
            migration.upgrade()
            assert "mcp_servers" in inspect(connection).get_table_names()
            assert (
                json.loads(
                    connection.execute(
                        text("SELECT disabled_mcp_servers FROM agent_definitions")
                    ).scalar_one()
                )
                == []
            )
            migration.downgrade()
            assert "mcp_servers" not in inspect(connection).get_table_names()
            assert connection.execute(
                text("SELECT * FROM agent_definitions")
            ).one() == ("custom", "Existing Agent")
    finally:
        engine.dispose()
