from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import security
from ..db import get_session
from ..deps import get_current_user
from ..models import AuthToken, User
from ..schemas import Credentials, LoginResult, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResult)
async def login(
    credentials: Credentials, session: AsyncSession = Depends(get_session)
) -> LoginResult:
    """Progressive sign-in.

    Unknown username        -> create the User with this password.
    Known, no password yet  -> adopt this password.
    Known, has a password   -> it has to match.
    """
    username = credentials.username.strip()
    if not username:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Username required")

    result = await session.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            username=username,
            password_hash=security.hash_password(credentials.password),
        )
        session.add(user)
        await session.flush()
        outcome = "registered"
    elif user.password_hash is None:
        user.password_hash = security.hash_password(credentials.password)
        outcome = "password_set"
    elif security.verify_password(credentials.password, user.password_hash):
        outcome = "signed_in"
    else:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong password")

    raw = security.new_token()
    session.add(
        AuthToken(token_hash=security.token_fingerprint(raw), user_id=user.id)
    )
    await session.commit()

    return LoginResult(token=raw, user=UserOut.model_validate(user), outcome=outcome)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Drop every token of the current user."""
    result = await session.execute(
        select(AuthToken).where(AuthToken.user_id == user.id)
    )
    for token in result.scalars():
        await session.delete(token)
    await session.commit()
