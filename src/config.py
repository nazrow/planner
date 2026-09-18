import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://planner:planner@localhost:5432/planner",
)
TOKEN_TTL_DAYS = int(os.environ.get("TOKEN_TTL_DAYS", "30"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "11111"))
SQL_ECHO = os.environ.get("SQL_ECHO", "").lower() in ("1", "true", "yes")
# Bring the schema up to date on startup. Turn off to run `alembic upgrade head`
# yourself, e.g. if you ever run more than one app process against one database.
MIGRATE_ON_START = os.environ.get("MIGRATE_ON_START", "1").lower() in ("1", "true", "yes")
