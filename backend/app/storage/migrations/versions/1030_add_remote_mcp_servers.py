"""Add remote MCP servers and per-agent opt-outs.

Revision ID: 1030
Revises: 1029
"""

from alembic import op
import sqlalchemy as sa

revision = "1030"
down_revision = "1029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mcp_servers",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("transport", sa.String(30), nullable=False),
        sa.Column("headers_encrypted", sa.Text(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    with op.batch_alter_table("agent_definitions") as batch_op:
        batch_op.add_column(
            sa.Column(
                "disabled_mcp_servers", sa.JSON(), nullable=False, server_default="[]"
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("agent_definitions") as batch_op:
        batch_op.drop_column("disabled_mcp_servers")
    op.drop_table("mcp_servers")
