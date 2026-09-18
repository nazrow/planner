from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import PermissionLevel


def as_utc(value: dt.datetime | None) -> dt.datetime | None:
    """A time without a zone is taken as UTC, on the way in and on the way out.

    Left alone, Postgres would read a naive time in *its* zone (so it depends on
    how the server is set up), and SQLite hands back naive times for everything.
    """
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=dt.timezone.utc)
    return value


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str


class UserSuggestion(BaseModel):
    username: str
    #: How often this person shows up on the asker's own tasks.
    uses: int


class LoginResult(BaseModel):
    token: str
    user: UserOut
    # What the login actually did, so the UI can say something useful.
    outcome: str  # "registered" | "password_set" | "signed_in"


class LinkIn(BaseModel):
    url: str = Field(min_length=1)
    label: str | None = None


class LinkOut(LinkIn):
    model_config = ConfigDict(from_attributes=True)

    id: int


class RoleIn(BaseModel):
    """Somebody's part in a task. An unknown username is created on save."""

    username: str = Field(min_length=1, max_length=64)
    role: str = Field(min_length=1, max_length=40)


class RoleOut(BaseModel):
    user_id: int
    username: str
    role: str


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    deadline: dt.datetime | None = None
    #: False makes the deadline a whole day: only the date part counts.
    deadline_has_time: bool = True
    completion: int = Field(default=0, ge=0, le=100)
    links: list[LinkIn] = Field(default_factory=list)
    # Task-to-task connections, by id of the other end.
    blocked_by: list[int] = Field(default_factory=list)
    blocks: list[int] = Field(default_factory=list)
    #: Left out entirely, the existing cast stays as it is.
    roles: list[RoleIn] | None = None

    _utc_deadline = field_validator("deadline")(as_utc)

    @model_validator(mode="after")
    def _day_deadline_at_midnight(self) -> "TaskIn":
        # A date-only deadline is pinned to midnight UTC of its (UTC) date,
        # whatever time came along with it.
        if self.deadline is not None and not self.deadline_has_time:
            day = self.deadline.astimezone(dt.timezone.utc).date()
            self.deadline = dt.datetime.combine(day, dt.time(), dt.timezone.utc)
        return self


class TaskOut(BaseModel):
    id: int
    title: str
    description: str | None
    deadline: dt.datetime | None
    deadline_has_time: bool
    completion: int
    links: list[LinkOut]
    blocked_by: list[int]
    blocks: list[int]
    roles: list[RoleOut]
    can_edit: bool
    is_owner: bool
    created_by_id: int | None
    updated_at: dt.datetime

    _utc_times = field_validator("deadline", "updated_at")(as_utc)


class Workspace(BaseModel):
    me: UserOut
    tasks: list[TaskOut]
    #: Finished tasks left out because nobody has touched them in two months.
    hidden_finished: int = 0


class PermissionIn(BaseModel):
    """"<grantee> may <level> every task where I am <roles>"."""

    username: str = Field(min_length=1, max_length=64)
    level: PermissionLevel = PermissionLevel.view
    roles: list[str] = Field(min_length=1)


class PermissionOut(BaseModel):
    id: int
    grantor: str
    grantee: str
    level: PermissionLevel
    roles: list[str]
    created_at: dt.datetime

    _utc_created = field_validator("created_at")(as_utc)


class PermissionBook(BaseModel):
    granted: list[PermissionOut]
    received: list[PermissionOut]
