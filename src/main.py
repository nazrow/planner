import asyncio
import pathlib
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
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

api = APIRouter(prefix="/api")
api.include_router(auth.router)
api.include_router(users.router)
api.include_router(permissions.router)
api.include_router(tasks.router)


@api.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WWW / "index.html")


@app.get("/workspace")
async def workspace_page() -> FileResponse:
    return FileResponse(WWW / "workspace.html")


@app.get("/permissions")
async def permissions_page() -> FileResponse:
    return FileResponse(WWW / "permissions.html")


app.mount("/", StaticFiles(directory=WWW), name="www")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host=config.HOST, port=config.PORT, reload=True)
