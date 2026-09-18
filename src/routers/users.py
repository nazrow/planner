from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from ..db import get_session
from ..deps import get_current_user
from ..models import BUILTIN_ROLES, TaskRole, User
from ..schemas import UserSuggestion

router = APIRouter(tags=["users"])


@router.get("/users/suggestions", response_model=list[UserSuggestion])
async def suggestions(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[UserSuggestion]:
    """People to offer first when casting a task: the ones already around you.

    Ranked by how often they turn up on tasks the asker has a role on, so the
    usual suspects float to the top; everybody else follows alphabetically.
    """
    mine = select(TaskRole.task_id).where(TaskRole.user_id == user.id).subquery()
    theirs = aliased(TaskRole)
    counted = await session.execute(
        select(theirs.user_id, func.count(func.distinct(theirs.task_id)).label("uses"))
        .where(theirs.task_id.in_(select(mine.c.task_id)))
        .group_by(theirs.user_id)
    )
    uses = {row.user_id: row.uses for row in counted}

    everyone = await session.execute(select(User).order_by(User.username))
    people = list(everyone.scalars())
    people.sort(key=lambda person: (-uses.get(person.id, 0), person.username.lower()))
    return [
        UserSuggestion(username=person.username, uses=uses.get(person.id, 0))
        for person in people
    ]


@router.get("/roles", response_model=list[str])
async def roles(
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[str]:
    """The built-in vocabulary plus anything already in use elsewhere."""
    result = await session.execute(select(TaskRole.role).distinct())
    known = list(BUILTIN_ROLES)
    for role in sorted(result.scalars()):
        if role not in known:
            known.append(role)
    return known
