"""Standing grants between two users, scoped by the grantor's roles."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models import (
    PermissionRole,
    User,
    UserPermission,
    normalise_role,
    utcnow,
)
from ..schemas import PermissionBook, PermissionIn, PermissionOut

router = APIRouter(prefix="/permissions", tags=["permissions"])


def _render(permission: UserPermission, grantor: str, grantee: str) -> PermissionOut:
    return PermissionOut(
        id=permission.id,
        grantor=grantor,
        grantee=grantee,
        level=permission.level,
        roles=sorted(permission.role_names),
        created_at=permission.created_at,
    )


async def _names(session: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    result = await session.execute(
        select(User.id, User.username).where(User.id.in_(list(ids)))
    )
    return {row.id: row.username for row in result}


async def _book(session: AsyncSession, user_id: int) -> PermissionBook:
    # Takes a plain id: expire_all() below would make touching a User do IO.
    session.expire_all()
    result = await session.execute(
        select(UserPermission).where(
            or_(
                UserPermission.grantor_id == user_id,
                UserPermission.grantee_id == user_id,
            )
        )
    )
    rows = list(result.scalars())
    names = await _names(
        session,
        {row.grantor_id for row in rows} | {row.grantee_id for row in rows},
    )
    granted = [
        _render(row, names.get(row.grantor_id, "?"), names.get(row.grantee_id, "?"))
        for row in rows
        if row.grantor_id == user_id
    ]
    received = [
        _render(row, names.get(row.grantor_id, "?"), names.get(row.grantee_id, "?"))
        for row in rows
        if row.grantee_id == user_id
    ]
    return PermissionBook(granted=granted, received=received)


@router.get("", response_model=PermissionBook)
async def list_permissions(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PermissionBook:
    return await _book(session, user.id)


def _clean_roles(roles: list[str]) -> list[str]:
    cleaned = []
    for role in roles:
        normalised = normalise_role(role)
        if normalised and normalised not in cleaned:
            cleaned.append(normalised)
    if not cleaned:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Pick at least one role for the grant to cover",
        )
    return cleaned


@router.post("", response_model=PermissionBook, status_code=status.HTTP_201_CREATED)
async def grant(
    payload: PermissionIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PermissionBook:
    user_id = user.id
    username = payload.username.strip()
    if username == user.username:
        raise HTTPException(status.HTTP_409_CONFLICT, "That is you")

    result = await session.execute(select(User).where(User.username == username))
    grantee = result.scalar_one_or_none()
    if grantee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such user")

    permission = UserPermission(
        grantor_id=user_id, grantee_id=grantee.id, level=payload.level
    )
    session.add(permission)
    await session.flush()
    for role in _clean_roles(payload.roles):
        session.add(PermissionRole(permission_id=permission.id, role=role))
    await session.commit()
    return await _book(session, user_id)


async def _mine(
    session: AsyncSession, user: User, permission_id: int
) -> UserPermission:
    permission = await session.get(UserPermission, permission_id)
    if permission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such permission")
    if permission.grantor_id != user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the person who gave it can change it"
        )
    return permission


@router.put("/{permission_id}", response_model=PermissionBook)
async def amend(
    permission_id: int,
    payload: PermissionIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PermissionBook:
    permission = await _mine(session, user, permission_id)
    user_id = user.id

    username = payload.username.strip()
    if username != user.username:
        result = await session.execute(select(User).where(User.username == username))
        grantee = result.scalar_one_or_none()
        if grantee is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such user")
        permission.grantee_id = grantee.id
    elif permission.grantee_id == user_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "That is you")

    permission.level = payload.level
    permission.updated_at = utcnow()

    wanted = _clean_roles(payload.roles)
    existing = {entry.role: entry for entry in permission.roles}
    for role, entry in existing.items():
        if role not in wanted:
            permission.roles.remove(entry)
    for role in wanted:
        if role not in existing:
            permission.roles.append(PermissionRole(role=role))

    await session.commit()
    return await _book(session, user_id)


@router.delete("/{permission_id}", response_model=PermissionBook)
async def revoke(
    permission_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PermissionBook:
    permission = await _mine(session, user, permission_id)
    user_id = user.id
    await session.delete(permission)
    await session.commit()
    return await _book(session, user_id)
