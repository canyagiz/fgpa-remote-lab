"""add active_session_token to users

Revision ID: 7a1e9b3c2d4f
Revises: 2fd144993865
Create Date: 2026-07-17 11:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7a1e9b3c2d4f'
down_revision: Union[str, None] = '2fd144993865'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('active_session_token', sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'active_session_token')
