"""Persist the shared agent board, ordered posts and participant read cursors.

Revision ID: 1031
Revises: 1030
"""

from alembic import op
import sqlalchemy as sa

revision = "1031"
down_revision = "1030"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_boards",
        sa.Column("root_session_id", sa.String(64), primary_key=True),
        sa.Column(
            "task_id",
            sa.String(64),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("project_id", sa.String(64), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("message_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("message_bytes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_agent_boards_task_id", "agent_boards", ["task_id"])
    op.create_index("ix_agent_boards_project_id", "agent_boards", ["project_id"])
    op.create_table(
        "agent_board_messages",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "root_session_id",
            sa.String(64),
            sa.ForeignKey("agent_boards.root_session_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("sender", sa.String(64), nullable=False),
        sa.Column("recipient", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("reply_to", sa.String(64)),
        sa.Column("source_call", sa.String(200), nullable=False),
        sa.Column("revision_id", sa.String(64)),
        sa.Column("retracted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "root_session_id", "seq", name="uq_agent_board_message_seq"
        ),
        sa.UniqueConstraint(
            "root_session_id",
            "sender",
            "source_call",
            name="uq_agent_board_message_call",
        ),
    )
    op.create_index(
        "ix_agent_board_messages_root_session_id",
        "agent_board_messages",
        ["root_session_id"],
    )
    op.create_index(
        "ix_agent_board_messages_revision_id", "agent_board_messages", ["revision_id"]
    )
    op.create_table(
        "agent_board_read_states",
        sa.Column(
            "root_session_id",
            sa.String(64),
            sa.ForeignKey("agent_boards.root_session_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("participant", sa.String(64), primary_key=True),
        sa.Column("seen_seq", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_table("agent_board_read_states")
    op.drop_table("agent_board_messages")
    op.drop_table("agent_boards")
