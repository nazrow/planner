from collections.abc import AsyncIterator

from sqlalchemy import MetaData, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from . import config

# Deterministic constraint names, so a later migration can find and drop one
# by name on any database -- SQLite especially, which names nothing itself.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


engine = create_async_engine(config.DATABASE_URL, echo=config.SQL_ECHO, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


if engine.dialect.name == "sqlite":
    # SQLite ignores FK constraints (and therefore ON DELETE CASCADE) unless asked.
    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_fk_pragma(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
