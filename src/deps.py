import datetime as dt

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import config, security
from .db import get_session
from .models import AuthToken, User, utcnow


async def get_current_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    raw = authorization.split(" ", 1)[1].strip()

    result = await session.execute(
        select(AuthToken).where(
            AuthToken.token_hash == security.token_fingerprint(raw)
        )
    )
    token = result.scalar_one_or_none()
    if token is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown token")

    issued = token.issued_at
    if issued.tzinfo is None:  # SQLite hands back naive datetimes
        issued = issued.replace(tzinfo=dt.timezone.utc)
    if utcnow() - issued > dt.timedelta(days=config.TOKEN_TTL_DAYS):
        await session.delete(token)
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")

    token.last_used_at = utcnow()
    user = await session.get(User, token.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown user")
    await session.commit()
    return user
