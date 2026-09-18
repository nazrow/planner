"""Initial schema: users, tokens, tasks and everything hanging off them.

Revision ID: 07f85cdc6ca9
Revises:
Create Date: 2026-09-18 11:29:21.474008
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '07f85cdc6ca9'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users'))
    )
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)
    op.create_table('auth_tokens',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('issued_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_auth_tokens_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_auth_tokens'))
    )
    op.create_index(op.f('ix_auth_tokens_token_hash'), 'auth_tokens', ['token_hash'], unique=True)
    op.create_index(op.f('ix_auth_tokens_user_id'), 'auth_tokens', ['user_id'], unique=False)
    op.create_table('tasks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('deadline', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completion', sa.Integer(), nullable=False),
    sa.Column('created_by_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('completion >= 0 AND completion <= 100', name=op.f('ck_tasks_completion_pct')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_tasks_created_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_tasks'))
    )
    op.create_table('user_permissions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('grantor_id', sa.Integer(), nullable=False),
    sa.Column('grantee_id', sa.Integer(), nullable=False),
    sa.Column('level', sa.Enum('view', 'modify', name='permission_level'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('grantor_id <> grantee_id', name=op.f('ck_user_permissions_no_self_grant')),
    sa.ForeignKeyConstraint(['grantee_id'], ['users.id'], name=op.f('fk_user_permissions_grantee_id_users'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['grantor_id'], ['users.id'], name=op.f('fk_user_permissions_grantor_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_permissions'))
    )
    op.create_index(op.f('ix_user_permissions_grantee_id'), 'user_permissions', ['grantee_id'], unique=False)
    op.create_index(op.f('ix_user_permissions_grantor_id'), 'user_permissions', ['grantor_id'], unique=False)
    op.create_table('permission_roles',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('permission_id', sa.Integer(), nullable=False),
    sa.Column('role', sa.String(length=40), nullable=False),
    sa.ForeignKeyConstraint(['permission_id'], ['user_permissions.id'], name=op.f('fk_permission_roles_permission_id_user_permissions'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_permission_roles')),
    sa.UniqueConstraint('permission_id', 'role', name=op.f('uq_permission_roles_permission_id_role'))
    )
    op.create_index(op.f('ix_permission_roles_permission_id'), 'permission_roles', ['permission_id'], unique=False)
    op.create_table('task_dependencies',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('blocker_id', sa.Integer(), nullable=False),
    sa.Column('blocked_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('blocker_id <> blocked_id', name=op.f('ck_task_dependencies_no_self_block')),
    sa.ForeignKeyConstraint(['blocked_id'], ['tasks.id'], name=op.f('fk_task_dependencies_blocked_id_tasks'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['blocker_id'], ['tasks.id'], name=op.f('fk_task_dependencies_blocker_id_tasks'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_task_dependencies')),
    sa.UniqueConstraint('blocker_id', 'blocked_id', name=op.f('uq_task_dependencies_blocker_id_blocked_id'))
    )
    op.create_index(op.f('ix_task_dependencies_blocked_id'), 'task_dependencies', ['blocked_id'], unique=False)
    op.create_index(op.f('ix_task_dependencies_blocker_id'), 'task_dependencies', ['blocker_id'], unique=False)
    op.create_table('task_links',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=False),
    sa.Column('url', sa.Text(), nullable=False),
    sa.Column('label', sa.String(length=300), nullable=True),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], name=op.f('fk_task_links_task_id_tasks'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_task_links'))
    )
    op.create_index(op.f('ix_task_links_task_id'), 'task_links', ['task_id'], unique=False)
    op.create_table('task_roles',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('role', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], name=op.f('fk_task_roles_task_id_tasks'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_task_roles_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_task_roles')),
    sa.UniqueConstraint('task_id', 'user_id', 'role', name=op.f('uq_task_roles_task_id_user_id_role'))
    )
    op.create_index(op.f('ix_task_roles_task_id'), 'task_roles', ['task_id'], unique=False)
    op.create_index(op.f('ix_task_roles_user_id'), 'task_roles', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_task_roles_user_id'), table_name='task_roles')
    op.drop_index(op.f('ix_task_roles_task_id'), table_name='task_roles')
    op.drop_table('task_roles')
    op.drop_index(op.f('ix_task_links_task_id'), table_name='task_links')
    op.drop_table('task_links')
    op.drop_index(op.f('ix_task_dependencies_blocker_id'), table_name='task_dependencies')
    op.drop_index(op.f('ix_task_dependencies_blocked_id'), table_name='task_dependencies')
    op.drop_table('task_dependencies')
    op.drop_index(op.f('ix_permission_roles_permission_id'), table_name='permission_roles')
    op.drop_table('permission_roles')
    op.drop_index(op.f('ix_user_permissions_grantor_id'), table_name='user_permissions')
    op.drop_index(op.f('ix_user_permissions_grantee_id'), table_name='user_permissions')
    op.drop_table('user_permissions')
    op.drop_table('tasks')
    op.drop_index(op.f('ix_auth_tokens_user_id'), table_name='auth_tokens')
    op.drop_index(op.f('ix_auth_tokens_token_hash'), table_name='auth_tokens')
    op.drop_table('auth_tokens')
    op.drop_index(op.f('ix_users_username'), table_name='users')
    op.drop_table('users')
    # Dropping the table leaves Postgres's enum type behind, and a later
    # upgrade would then fail on "type already exists".
    sa.Enum(name='permission_level').drop(op.get_bind(), checkfirst=True)
