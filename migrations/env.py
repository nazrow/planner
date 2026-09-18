import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from src import config as app_config
from src import models  # noqa: F401  (registers every table on the metadata)
from src.db import Base

config = context.config

# The CLI wants Alembic's logging; the app, which runs this in-process, does not.
if config.config_file_name and config.attributes.get("configure_logging", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _options(url: str) -> dict:
    return {
        "target_metadata": target_metadata,
        "compare_type": True,
        # SQLite can barely ALTER; batch mode rebuilds the table instead.
        "render_as_batch": url.startswith("sqlite"),
    }


def run_migrations_offline() -> None:
    """`alembic upgrade head --sql`: print the SQL instead of running it."""
    url = app_config.DATABASE_URL
    context.configure(
        url=url,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_options(url),
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, **_options(app_config.DATABASE_URL))
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(app_config.DATABASE_URL, poolclass=pool.NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
