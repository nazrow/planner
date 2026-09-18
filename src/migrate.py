"""Running Alembic from inside the app (and from tests).

The command line works as usual from the repository root:

    alembic upgrade head
    alembic revision --autogenerate -m "what changed"
"""

import pathlib

from alembic import command
from alembic.config import Config

ROOT = pathlib.Path(__file__).resolve().parent.parent


def alembic_config(configure_logging: bool = False) -> Config:
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    # Letting env.py run fileConfig() inside a live server would switch off
    # uvicorn's own loggers, so only the CLI gets Alembic's logging setup.
    cfg.attributes["configure_logging"] = configure_logging
    return cfg


def upgrade_to_head() -> None:
    """Blocking; env.py runs its own event loop, so call it off the app's loop."""
    command.upgrade(alembic_config(), "head")


def check_models_match_migrations() -> None:
    """Raise if the models have drifted from what the migrations build."""
    command.check(alembic_config())
