from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access import (
    expand_graph,
    is_stale,
    load_rights,
    may_edit,
    seed_task_ids,
    split_stale,
    would_create_cycle,
)
from ..db import get_session
from ..deps import get_current_user
from ..models import (
    OWNER,
    PermissionLevel,
    Task,
    TaskDependency,
    TaskLink,
    TaskRole,
    User,
    normalise_role,
    utcnow,
)
from ..schemas import LinkOut, RoleOut, TaskIn, TaskOut, UserOut, Workspace

router = APIRouter(tags=["tasks"])


async def _usernames(session: AsyncSession, user_ids: set[int]) -> dict[int, str]:
    if not user_ids:
        return {}
    result = await session.execute(
        select(User.id, User.username).where(User.id.in_(list(user_ids)))
    )
    return {row.id: row.username for row in result}


async def _resolve_users(session: AsyncSession, usernames: set[str]) -> dict[str, User]:
    """Look up people by name, inventing the ones nobody has registered yet.

    A user made this way has no password; whoever first signs in under that
    name claims it, which is the rule the login screen already follows.
    """
    if not usernames:
        return {}
    result = await session.execute(
        select(User).where(User.username.in_(list(usernames)))
    )
    found = {user.username: user for user in result.scalars()}
    for name in usernames - set(found):
        fresh = User(username=name)
        session.add(fresh)
        found[name] = fresh
    await session.flush()
    return found


async def _serialize(
    session: AsyncSession,
    tasks: list[Task],
    deps: list[TaskDependency],
    roles: dict[int, set[str]],
    granted: dict[int, PermissionLevel],
) -> list[TaskOut]:
    blocked_by: dict[int, list[int]] = defaultdict(list)
    blocks: dict[int, list[int]] = defaultdict(list)
    for dep in deps:
        blocked_by[dep.blocked_id].append(dep.blocker_id)
        blocks[dep.blocker_id].append(dep.blocked_id)

    people: set[int] = set()
    for task in tasks:
        people.update(role.user_id for role in task.roles)
    names = await _usernames(session, people)

    out: list[TaskOut] = []
    for task in tasks:
        out.append(
            TaskOut(
                id=task.id,
                title=task.title,
                description=task.description,
                deadline=task.deadline,
                deadline_has_time=task.deadline_has_time,
                completion=task.completion,
                links=[LinkOut.model_validate(link) for link in task.links],
                blocked_by=sorted(blocked_by[task.id]),
                blocks=sorted(blocks[task.id]),
                roles=sorted(
                    (
                        RoleOut(
                            user_id=role.user_id,
                            username=names.get(role.user_id, "?"),
                            role=role.role,
                        )
                        for role in task.roles
                    ),
                    key=lambda entry: (entry.role != OWNER, entry.username),
                ),
                can_edit=may_edit(task.id, roles, granted),
                is_owner=OWNER in roles.get(task.id, set()),
                created_by_id=task.created_by_id,
                updated_at=task.updated_at,
            )
        )
    return out


async def _load_tasks(session: AsyncSession, ids: set[int]) -> list[Task]:
    """Always re-select: Task collections load eagerly here, get() may be stale."""
    if not ids:
        return []
    result = await session.execute(select(Task).where(Task.id.in_(list(ids))))
    return list(result.scalars())


async def _visible_ids(session: AsyncSession, user: User) -> set[int]:
    """Everything the user could legitimately point a connection at.

    Finished-and-forgotten tasks count here even though the workspace hides
    them, so re-saving a task cannot quietly sever its older connections.
    """
    seeds = await seed_task_ids(session, user)
    visible, _ = await expand_graph(session, seeds)
    return visible


@router.get("/workspace", response_model=Workspace)
async def workspace(
    include_finished: bool = False,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Workspace:
    seeds = await seed_task_ids(session, user)
    hidden_ids: set[int] = set()
    if not include_finished:
        seeds, hidden_ids = await split_stale(session, seeds)

    task_ids, deps = await expand_graph(session, seeds)
    tasks = await _load_tasks(session, task_ids)

    if not include_finished:
        now = utcnow()
        kept = [task for task in tasks if not is_stale(task, now)]
        hidden_ids |= {task.id for task in tasks if is_stale(task, now)}
        tasks = kept

    roles, granted = await load_rights(session, user.id, {task.id for task in tasks})
    return Workspace(
        me=UserOut.model_validate(user),
        tasks=await _serialize(session, tasks, deps, roles, granted),
        hidden_finished=len(hidden_ids),
    )


async def _single(session: AsyncSession, user_id: int, task_id: int) -> TaskOut:
    """Re-read one task with its own connections, for the response of a write."""
    session.expire_all()
    tasks = await _load_tasks(session, {task_id})
    result = await session.execute(
        select(TaskDependency).where(
            (TaskDependency.blocker_id == task_id)
            | (TaskDependency.blocked_id == task_id)
        )
    )
    deps = list(result.scalars())
    roles, granted = await load_rights(session, user_id, {task_id})
    serialized = await _serialize(session, tasks, deps, roles, granted)
    return serialized[0]


async def _apply_roles(session: AsyncSession, task: Task, payload: TaskIn) -> None:
    if payload.roles is None:
        return

    wanted: list[tuple[str, str]] = []
    for entry in payload.roles:
        username = entry.username.strip()
        role = normalise_role(entry.role)
        if username and role:
            wanted.append((username, role))

    if not any(role == OWNER for _, role in wanted):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A task needs at least one owner",
        )

    users = await _resolve_users(session, {name for name, _ in wanted})
    await session.execute(delete(TaskRole).where(TaskRole.task_id == task.id))

    seen: set[tuple[int, str]] = set()
    for username, role in wanted:
        key = (users[username].id, role)
        if key in seen:
            continue
        seen.add(key)
        session.add(TaskRole(task_id=task.id, user_id=key[0], role=role))
    await session.flush()


async def _apply_payload(
    session: AsyncSession,
    task: Task,
    payload: TaskIn,
    visible: set[int],
) -> None:
    targets = set(payload.blocked_by) | set(payload.blocks)
    targets.discard(task.id)
    unknown = targets - visible
    if unknown:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Cannot connect to tasks outside your workspace: {sorted(unknown)}",
        )

    task.title = payload.title.strip()
    task.description = (payload.description or "").strip() or None
    task.deadline = payload.deadline
    task.deadline_has_time = payload.deadline_has_time if payload.deadline else True
    task.completion = payload.completion
    task.updated_at = utcnow()

    await session.execute(delete(TaskLink).where(TaskLink.task_id == task.id))
    for position, link in enumerate(payload.links):
        url = link.url.strip()
        if not url:
            continue
        session.add(
            TaskLink(
                task_id=task.id,
                url=url,
                label=(link.label or "").strip() or None,
                position=position,
            )
        )
    await session.flush()

    await _apply_roles(session, task, payload)

    wanted = {(blocker, task.id) for blocker in set(payload.blocked_by)}
    wanted |= {(task.id, blocked) for blocked in set(payload.blocks)}
    wanted = {(a, b) for a, b in wanted if a != b}

    result = await session.execute(
        select(TaskDependency).where(
            (TaskDependency.blocker_id == task.id)
            | (TaskDependency.blocked_id == task.id)
        )
    )
    existing = {(d.blocker_id, d.blocked_id): d for d in result.scalars()}

    for pair, dep in existing.items():
        if pair not in wanted:
            await session.delete(dep)
    await session.flush()

    added = [pair for pair in wanted if pair not in existing]
    if added and await would_create_cycle(session, added):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Those connections would make tasks block each other in a loop",
        )
    for blocker, blocked in added:
        session.add(TaskDependency(blocker_id=blocker, blocked_id=blocked))


@router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> TaskOut:
    visible = await _visible_ids(session, user)
    task = Task(title=payload.title.strip(), created_by_id=user.id)
    session.add(task)
    await session.flush()
    if payload.roles is None:
        session.add(TaskRole(task_id=task.id, user_id=user.id, role=OWNER))
    await _apply_payload(session, task, payload, visible)
    await session.commit()
    return await _single(session, user.id, task.id)


@router.put("/tasks/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: int,
    payload: TaskIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> TaskOut:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such task")
    roles, granted = await load_rights(session, user.id, {task_id})
    if not may_edit(task_id, roles, granted):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No permission to modify")

    visible = await _visible_ids(session, user)
    await _apply_payload(session, task, payload, visible)
    await session.commit()
    return await _single(session, user.id, task_id)


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    task = await session.get(Task, task_id)
    if task is None:
        return
    roles, granted = await load_rights(session, user.id, {task_id})
    if not may_edit(task_id, roles, granted):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No permission to delete")
    await session.delete(task)
    await session.commit()
