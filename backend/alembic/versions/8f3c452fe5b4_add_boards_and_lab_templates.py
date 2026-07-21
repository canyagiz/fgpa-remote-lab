"""add boards and lab templates

Revision ID: 8f3c452fe5b4
Revises: 7c61d7d5b05c
Create Date: 2026-07-21 14:59:50.281475

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8f3c452fe5b4'
down_revision: Union[str, None] = '7c61d7d5b05c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "boards",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column(
            "family",
            sa.Enum(
                "cyclone_iv", "cyclone_v", "cyclone_10", "zynq_7020", name="fpgafamily"
            ),
            nullable=False,
        ),
        sa.Column("expected_idcode", sa.String(length=32), nullable=True),
        sa.Column("programmer_serial", sa.String(length=128), nullable=False),
        sa.Column("video_capture_serial", sa.String(length=128), nullable=True),
        sa.Column("gpio_endpoint", sa.String(length=128), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("registered_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["registered_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    # One board per programmer: two boards claiming the same cable are
    # really one board entered twice, which would then satisfy a
    # requirement twice over.
    op.create_index(
        "ix_boards_programmer_serial", "boards", ["programmer_serial"], unique=True
    )
    op.create_index("ix_boards_label_lower", "boards", [sa.text("lower(label)")], unique=True)

    op.create_table(
        "lab_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("requirements", sa.JSON(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_lab_templates_name_lower", "lab_templates", [sa.text("lower(name)")], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_lab_templates_name_lower", table_name="lab_templates")
    op.drop_table("lab_templates")
    op.drop_index("ix_boards_label_lower", table_name="boards")
    op.drop_index("ix_boards_programmer_serial", table_name="boards")
    op.drop_table("boards")
    # Postgres keeps the enum type behind after its table is gone.
    sa.Enum(name="fpgafamily").drop(op.get_bind(), checkfirst=True)
