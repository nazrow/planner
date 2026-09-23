"""End-to-end smoke test of the API.

    python tests/smoke.py

Runs against a throwaway SQLite file unless SMOKE_DATABASE_URL points it at a
real database -- which it will wipe, so give it one of its own:

    SMOKE_DATABASE_URL=postgresql+asyncpg://planner@localhost/planner_smoke python tests/smoke.py

The schema is built by the Alembic migrations, the same way the app builds it,
after a full down-and-up round trip and a check that the models have not
drifted from them.
"""

import asyncio
import datetime as dt
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

if os.environ.get("SMOKE_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["SMOKE_DATABASE_URL"]
else:
    DB_FILE = pathlib.Path(tempfile.gettempdir()) / "planner_smoke.db"
    DB_FILE.unlink(missing_ok=True)
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{DB_FILE.as_posix()}"

import httpx  # noqa: E402

from alembic import command  # noqa: E402

from src.db import SessionLocal  # noqa: E402
from src.main import app  # noqa: E402
from src.migrate import alembic_config, check_models_match_migrations  # noqa: E402

PASSED = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}  {detail}")
        raise SystemExit(1)


async def age_task(task_id: int, days: int) -> None:
    """Backdate a task, to test the two-month cutoff without waiting."""
    from sqlalchemy import update

    from src.models import Task

    async with SessionLocal() as session:
        await session.execute(
            update(Task)
            .where(Task.id == task_id)
            .values(updated_at=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days))
        )
        await session.commit()


def migrate() -> None:
    print(f"migrations  ({os.environ['DATABASE_URL'].split(':', 1)[0]})")
    cfg = alembic_config()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    check("downgrade to nothing works", True)
    command.upgrade(cfg, "head")
    check("upgrade back to head works", True)
    check_models_match_migrations()
    check("models match the migrations", True)


async def main() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        print("auth")
        r = await client.post(
            "/auth/login", json={"username": "alice", "password": "hunter2"}
        )
        check("unknown username registers", r.status_code == 200, r.text)
        check("outcome is 'registered'", r.json()["outcome"] == "registered")
        alice = {"Authorization": "Bearer " + r.json()["token"]}

        r = await client.post(
            "/auth/login", json={"username": "alice", "password": "wrong"}
        )
        check("wrong password rejected", r.status_code == 401, r.text)

        r = await client.post(
            "/auth/login", json={"username": "alice", "password": "hunter2"}
        )
        check("right password signs in", r.json()["outcome"] == "signed_in")

        r = await client.get("/auth/me", headers=alice)
        check("token identifies the user", r.json()["username"] == "alice", r.text)

        r = await client.get("/workspace")
        check("no token is a 401", r.status_code == 401)

        r = await client.get("/health")
        check("API data is never cached", r.headers.get("cache-control") == "no-store")
        r = await client.get("/")
        check("pages revalidate every load", r.headers.get("cache-control") == "no-cache")
        r = await client.get("/js/app.js")
        check("so do scripts", r.headers.get("cache-control") == "no-cache")

        print("tasks")
        r = await client.post(
            "/tasks",
            headers=alice,
            json={
                "title": "Buy paint",
                "description": "Matte, off-white",
                "completion": 40,
                "links": [{"url": "https://example.com/paint", "label": "shop"}],
            },
        )
        check("create task", r.status_code == 201, r.text)
        paint = r.json()
        check("creator becomes owner", paint["is_owner"] is True)
        check("owner can edit", paint["can_edit"] is True)
        check("links stored", paint["links"][0]["label"] == "shop")
        check("carries a last-update stamp", bool(paint["updated_at"]), paint)

        r = await client.post(
            "/tasks",
            headers=alice,
            json={"title": "Paint the wall", "blocked_by": [paint["id"]]},
        )
        check("create blocked task", r.status_code == 201, r.text)
        wall = r.json()
        check("dependency recorded", wall["blocked_by"] == [paint["id"]], wall)

        r = await client.get("/workspace", headers=alice)
        body = r.json()
        check("workspace lists both", len(body["tasks"]) == 2, body)
        by_id = {t["id"]: t for t in body["tasks"]}
        check("reverse side of the edge", by_id[paint["id"]]["blocks"] == [wall["id"]])

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={
                "title": "Paint the wall",
                "completion": 10,
                "blocked_by": [paint["id"]],
                "blocks": [],
            },
        )
        check("update task", r.status_code == 200 and r.json()["completion"] == 10)

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={
                "title": "Paint the wall",
                "completion": 10,
                "blocked_by": [paint["id"]],
                "deadline": "2026-09-20T17:00:00",
            },
        )
        check("a deadline without a timezone is taken as UTC", r.status_code == 200, r.text)
        check(
            "and comes back marked as such",
            r.json()["deadline"].startswith("2026-09-20T17:00:00")
            and r.json()["deadline"].endswith(("Z", "+00:00")),
            r.json()["deadline"],
        )
        check("a timed deadline says so", r.json()["deadline_has_time"] is True)

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={
                "title": "Paint the wall",
                "completion": 10,
                "blocked_by": [paint["id"]],
                "deadline": "2026-10-01T15:45:00Z",
                "deadline_has_time": False,
            },
        )
        body = r.json()
        check("a date-only deadline is accepted", r.status_code == 200, r.text)
        check("no estimate unless given", body["estimate_hours"] is None, body)

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={"title": "Paint the wall", "blocked_by": [paint["id"]], "estimate_hours": 6.5},
        )
        check("an estimate is stored", r.json()["estimate_hours"] == 6.5, r.text)
        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={"title": "Paint the wall", "blocked_by": [paint["id"]], "estimate_hours": -1},
        )
        check("a negative estimate is refused", r.status_code == 422, r.text)
        check(
            "and pinned to midnight UTC of its date",
            body["deadline"].startswith("2026-10-01T00:00:00")
            and body["deadline_has_time"] is False,
            body,
        )

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={
                "title": "Paint the wall",
                "blocked_by": [paint["id"]],
                "blocks": [paint["id"]],
            },
        )
        check("2-task cycle refused", r.status_code == 409, r.text)

        print("people on a task")
        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={
                "title": "Paint the wall",
                "blocked_by": [paint["id"]],
                "roles": [
                    {"username": "alice", "role": "owner"},
                    {"username": "dora", "role": "Assignee"},
                    {"username": "eli", "role": "consultant"},
                ],
            },
        )
        check("cast the task", r.status_code == 200, r.text)
        cast = {(entry["username"], entry["role"]) for entry in r.json()["roles"]}
        check(
            "unknown usernames were created",
            cast == {("alice", "owner"), ("dora", "assignee"), ("eli", "consultant")},
            cast,
        )

        r = await client.post(
            "/auth/login", json={"username": "dora", "password": "dora-pass"}
        )
        check(
            "an invented user claims the name on first login",
            r.json()["outcome"] == "password_set",
            r.text,
        )
        dora = {"Authorization": "Bearer " + r.json()["token"]}

        r = await client.get("/workspace", headers=dora)
        check("assignee sees the task", len(r.json()["tasks"]) == 2, r.json())
        dora_wall = next(t for t in r.json()["tasks"] if t["id"] == wall["id"])
        check("any role at all may edit it", dora_wall["can_edit"] is True)
        check("without being its owner", dora_wall["is_owner"] is False)
        dora_paint = next(t for t in r.json()["tasks"] if t["id"] == paint["id"])
        check(
            "a task reached only through the graph stays read-only",
            dora_paint["can_edit"] is False,
            dora_paint,
        )

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=dora,
            json={
                "title": "Paint the wall, says dora",
                "blocked_by": [paint["id"]],
                "roles": [
                    {"username": "alice", "role": "owner"},
                    {"username": "dora", "role": "assignee"},
                    {"username": "eli", "role": "consultant"},
                ],
            },
        )
        check("and really can write to it", r.status_code == 200, r.text)
        r = await client.put(
            f"/tasks/{paint['id']}", headers=dora, json={"title": "Hijacked"}
        )
        check("but not to one it has no role on", r.status_code == 403, r.text)

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=alice,
            json={"title": "Paint the wall", "roles": [{"username": "d", "role": "x"}]},
        )
        check("a task without an owner is refused", r.status_code == 422, r.text)

        r = await client.get("/roles", headers=alice)
        vocabulary = r.json()
        check("role vocabulary offered", "owner" in vocabulary and "assignee" in vocabulary)

        r = await client.get("/users/suggestions", headers=alice)
        names = [entry["username"] for entry in r.json()]
        check("suggestions lead with people on my tasks", names[0] == "alice", r.json())
        check("and include the rest", "dora" in names and "eli" in names, names)

        print("user-to-user permissions")
        r = await client.post(
            "/auth/login", json={"username": "bob", "password": "b"}
        )
        bob = {"Authorization": "Bearer " + r.json()["token"]}

        r = await client.get("/workspace", headers=bob)
        check("bob sees nothing yet", r.json()["tasks"] == [])

        r = await client.post(
            "/permissions",
            headers=alice,
            json={"username": "bob", "level": "view", "roles": ["owner"]},
        )
        check("grant created", r.status_code == 201, r.text)
        grant_id = r.json()["granted"][0]["id"]

        r = await client.get("/permissions", headers=bob)
        check("bob sees it as received", len(r.json()["received"]) == 1, r.json())
        check("and grants nothing himself", r.json()["granted"] == [])

        r = await client.get("/workspace", headers=bob)
        shared = r.json()["tasks"]
        check("the grant reaches alice's tasks", len(shared) == 2, shared)
        check("view only", all(t["can_edit"] is False for t in shared), shared)
        r = await client.put(
            f"/tasks/{wall['id']}", headers=bob, json={"title": "Hijacked"}
        )
        check("a view grant cannot write", r.status_code == 403, r.text)

        r = await client.post(
            "/tasks", headers=alice, json={"title": "A later task of alice's"}
        )
        later = r.json()
        r = await client.get("/workspace", headers=bob)
        check(
            "a grant covers tasks made after it",
            any(t["id"] == later["id"] for t in r.json()["tasks"]),
            r.json(),
        )

        r = await client.put(
            f"/permissions/{grant_id}",
            headers=alice,
            json={"username": "bob", "level": "modify", "roles": ["owner"]},
        )
        check("grant upgraded", r.json()["granted"][0]["level"] == "modify", r.text)

        r = await client.put(
            f"/tasks/{wall['id']}",
            headers=bob,
            json={"title": "Painted by bob", "blocked_by": [paint["id"]]},
        )
        check("modify now works", r.status_code == 200, r.text)

        r = await client.put(
            f"/permissions/{grant_id}",
            headers=alice,
            json={"username": "bob", "level": "modify", "roles": ["consultant"]},
        )
        check("grant re-scoped to a role alice does not hold", r.status_code == 200)
        r = await client.get("/workspace", headers=bob)
        check("so bob loses sight of them", r.json()["tasks"] == [], r.json())

        r = await client.post(
            "/permissions",
            headers=bob,
            json={"username": "alice", "level": "view", "roles": ["owner"]},
        )
        bobs_grant = r.json()["granted"][0]["id"]
        r = await client.delete(f"/permissions/{bobs_grant}", headers=alice)
        check("only the grantor may revoke", r.status_code == 403, r.text)
        r = await client.delete(f"/permissions/{bobs_grant}", headers=bob)
        check("grantor revokes", r.status_code == 200 and r.json()["granted"] == [])

        print("finished tasks fade out")
        r = await client.put(
            f"/tasks/{later['id']}",
            headers=alice,
            json={"title": "A later task of alice's", "completion": 100},
        )
        check("marked done", r.json()["completion"] == 100)
        r = await client.get("/workspace", headers=alice)
        check(
            "still shown while it is recent",
            any(t["id"] == later["id"] for t in r.json()["tasks"]),
        )

        await age_task(later["id"], 70)
        r = await client.get("/workspace", headers=alice)
        body = r.json()
        check(
            "gone once it is done and two months stale",
            not any(t["id"] == later["id"] for t in body["tasks"]),
            body,
        )
        check("and counted", body["hidden_finished"] == 1, body)

        r = await client.get("/workspace?include_finished=true", headers=alice)
        check(
            "still reachable on request",
            any(t["id"] == later["id"] for t in r.json()["tasks"]),
        )

        await age_task(paint["id"], 70)
        r = await client.put(
            f"/tasks/{paint['id']}",
            headers=alice,
            json={"title": "Buy paint", "completion": 100},
        )
        check("editing a stale task refreshes it", r.status_code == 200)
        r = await client.get("/workspace", headers=alice)
        check(
            "so it comes back",
            any(t["id"] == paint["id"] for t in r.json()["tasks"]),
        )

        print("deletion")
        r = await client.post(
            "/tasks", headers=dora, json={"title": "Dora's own"}
        )
        doras = r.json()
        r = await client.delete(f"/tasks/{doras['id']}", headers=alice)
        check("alice cannot delete dora's task", r.status_code == 403, r.text)
        r = await client.delete(f"/tasks/{doras['id']}", headers=dora)
        check("owner deletes", r.status_code == 204)

    print(f"\n{PASSED} checks passed")


if __name__ == "__main__":
    migrate()  # before any event loop: env.py runs its own
    asyncio.run(main())
