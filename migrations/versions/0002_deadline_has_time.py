"""Deadlines can be a whole day instead of an exact time.

Revision ID: 0002_deadline_has_time
Revises: 07f85cdc6ca9
Create Date: 2026-09-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_deadline_has_time"
down_revision: str | None = "07f85cdc6ca9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Every deadline set so far was an exact time.
    op.add_column(
        "tasks",
        sa.Column(
            "deadline_has_time",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.drop_column("deadline_has_time")
