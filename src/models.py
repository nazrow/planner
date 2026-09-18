from __future__ import annotations

import datetime as dt
import enum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


OWNER = "owner"

#: The roles offered in the pickers. Roles are plain strings, so a task can use
#: one that isn't on this list; "owner" is the only one with meaning in code.
BUILTIN_ROLES = (OWNER, "assignee", "requestor", "consultant", "observer")


def normalise_role(role: str) -> str:
    return " ".join(role.strip().lower().split())


class PermissionLevel(str, enum.Enum):
    view = "view"
    modify = "modify"


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # Empty until the user first supplies one -- see the progressive login flow.
    password_hash: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    tokens: Mapped[list["AuthToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Only the hash is stored; the raw token is handed to the client once.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    issued_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    last_used_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    user: Mapped[User] = relationship(back_populates="tokens")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text, default=None)
    deadline: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    completion: Mapped[int] = mapped_column(Integer, default=0)
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (
        CheckConstraint("completion >= 0 AND completion <= 100", name="completion_pct"),
    )

    links: Mapped[list["TaskLink"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="TaskLink.position",
        lazy="selectin",
    )
    roles: Mapped[list["TaskRole"]] = relationship(
        back_populates="task", cascade="all, delete-orphan", lazy="selectin"
    )


class TaskLink(Base):
    """A URL hanging off a Task (not to be confused with TaskDependency)."""

    __tablename__ = "task_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    url: Mapped[str] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(String(300), default=None)
    position: Mapped[int] = mapped_column(Integer, default=0)

    task: Mapped[Task] = relationship(back_populates="links")


class TaskDependency(Base):
    """blocker must be finished before blocked can be started."""

    __tablename__ = "task_dependencies"

    id: Mapped[int] = mapped_column(primary_key=True)
    blocker_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    blocked_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id"),
        CheckConstraint("blocker_id <> blocked_id", name="no_self_block"),
    )


class TaskRole(Base):
    __tablename__ = "task_roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (UniqueConstraint("task_id", "user_id", "role"),)

    task: Mapped[Task] = relationship(back_populates="roles")
    user: Mapped[User] = relationship()


class UserPermission(Base):
    """One User handing another a standing right over their own Tasks.

    Reads as: *grantee* may `level` every Task where *grantor* holds one of
    `roles`. It is a rule, not a list -- tasks the grantor takes on later are
    covered automatically.
    """

    __tablename__ = "user_permissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    grantor_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    grantee_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    level: Mapped[PermissionLevel] = mapped_column(
        SAEnum(PermissionLevel, name="permission_level")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (
        CheckConstraint("grantor_id <> grantee_id", name="no_self_grant"),
    )

    grantor: Mapped[User] = relationship(foreign_keys=[grantor_id])
    grantee: Mapped[User] = relationship(foreign_keys=[grantee_id])
    roles: Mapped[list["PermissionRole"]] = relationship(
        back_populates="permission",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def role_names(self) -> set[str]:
        return {entry.role for entry in self.roles}


class PermissionRole(Base):
    """One of the roles a UserPermission is scoped to."""

    __tablename__ = "permission_roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    permission_id: Mapped[int] = mapped_column(
        ForeignKey("user_permissions.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(40))

    __table_args__ = (
        UniqueConstraint("permission_id", "role"),
    )

    permission: Mapped[UserPermission] = relationship(back_populates="roles")
