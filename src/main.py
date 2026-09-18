import asyncio
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .migrate import upgrade_to_head
from .routers import auth, permissions, tasks, users

WWW = pathlib.Path(__file__).resolve().parent.parent / "www"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if config.MIGRATE_ON_START:
        # Alembic's env.py spins up its own event loop, so keep it off this one.
        await asyncio.to_thread(upgrade_to_head)
    yield


app = FastAPI(title="planner", lifespan=lifespan)


@app.middleware("http")
async def cache_policy(request: Request, call_next):
    """Never let a browser reuse something stale.

    Pages, scripts and styles: revalidate every time (a cheap 304), so a deploy
    takes effect on the next load instead of whenever the heuristic cache of
    the browser decides. API data: do not store at all -- it is per-user.
    """
    response = await call_next(request)
    if "cache-control" not in response.headers:
        is_data = response.headers.get("content-type", "").startswith("application/json")
        response.headers["Cache-Control"] = "no-store" if is_data else "no-cache"
    return response


# No path prefix anywhere, and the pages use only relative URLs, so the whole
# app works unchanged wherever the proxy mounts it: at the site root, or under
# a path the proxy strips before forwarding.
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(permissions.router)
app.include_router(tasks.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# Pages are plain files: index.html, workspace.html, permissions.html. Only
# the bare root needs pointing at one; /workspace and /permissions are data.
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WWW / "index.html")


app.mount("/", StaticFiles(directory=WWW), name="www")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host=config.HOST, port=config.PORT, reload=True)
