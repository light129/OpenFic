"""Track background subagent requests and result delivery.

Revision ID: 1030
Revises: 1029
"""

from alembic import op
import sqlalchemy as sa


revision: str = "1030"
down_revision: str = "1029"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("agent_child_run_requests") as batch_op:
        batch_op.add_column(
            sa.Column(
                "background", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )
        batch_op.add_column(
            sa.Column(
                "result_delivered",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("agent_child_run_requests") as batch_op:
        batch_op.drop_column("result_delivered")
        batch_op.drop_column("background")
