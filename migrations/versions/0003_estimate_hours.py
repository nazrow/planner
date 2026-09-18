"""Tasks get an estimate of the work they take, in hours.

Revision ID: 0003_estimate_hours
Revises: 0002_deadline_has_time
Create Date: 2026-09-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_estimate_hours"
down_revision: str | None = "0002_deadline_has_time"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.add_column(sa.Column("estimate_hours", sa.Float(), nullable=True))
        batch.create_check_constraint(
            op.f("ck_tasks_estimate_not_negative"), "estimate_hours >= 0"
        )


def downgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.drop_constraint(op.f("ck_tasks_estimate_not_negative"), type_="check")
        batch.drop_column("estimate_hours")
