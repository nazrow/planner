"""Who may see and touch which Task, and how the workspace graph is gathered.

Rights come from two places:

* a **role** on the task itself -- anyone with one, whatever it is, may change
  the task;
* a **permission** somebody granted you: *"you may view (or modify) every task
  where I am the owner / the assignee / …"*. Permissions are between two users
  and are scoped by the grantor's roles, so they keep covering tasks the
  grantor picks up later.

Permissions do not chain: what somebody was let into, they cannot pass on.
"""

import datetime as dt
from collections import defaultdict

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    PermissionLevel,
    Task,
    TaskDependency,
    TaskRole,
    User,
    UserPermission,
    utcnow,
)

#: A finished task stops showing up once nobody has touched it for this long.
STALE_AFTER = dt.timedelta(days=60)


def is_stale(task: Task, now: dt.datetime | None = None) -> bool:
    if task.completion < 100:
        return False
    updated = task.updated_at
    if updated is None:
        return False
    if updated.tzinfo is None:  # SQLite hands back naive datetimes
        updated = updated.replace(tzinfo=dt.timezone.utc)
    return updated < (now or utcnow()) - STALE_AFTER


async def permissions_granted_to(
    session: AsyncSession, user_id: int
) -> list[UserPermission]:
    result = await session.execute(
        select(UserPermission).where(UserPermission.grantee_id == user_id)
    )
    return list(result.scalars())


async def seed_task_ids(session: AsyncSession, user: User) -> set[int]:
    """Tasks the user is attached to: by their own role, or through a grant.

    Unfiltered -- deciding what is too old to bother with happens in one place,
    `split_stale`, so the workspace can also say how much it left out.
    """
    by_role = await session.execute(
        select(TaskRole.task_id).where(TaskRole.user_id == user.id)
    )
    seeds = set(by_role.scalars())

    clauses = []
    for permission in await permissions_granted_to(session, user.id):
        roles = permission.role_names
        if roles:
            clauses.append(
                and_(
                    TaskRole.user_id == permission.grantor_id,
                    TaskRole.role.in_(list(roles)),
                )
            )
    if clauses:
        borrowed = await session.execute(select(TaskRole.task_id).where(or_(*clauses)))
        seeds |= set(borrowed.scalars())

    return seeds


async def split_stale(
    session: AsyncSession, ids: set[int]
) -> tuple[set[int], set[int]]:
    """(worth showing, finished and untouched for two months)."""
    if not ids:
        return set(), set()
    cutoff = utcnow() - STALE_AFTER
    result = await session.execute(
        select(Task.id).where(
            Task.id.in_(list(ids)), Task.completion >= 100, Task.updated_at < cutoff
        )
    )
    stale = set(result.scalars())
    return ids - stale, stale


async def expand_graph(
    session: AsyncSession, seeds: set[int]
) -> tuple[set[int], list[TaskDependency]]:
    """Walk dependencies out of the seed set, both directions, to every leaf."""
    seen: set[int] = set(seeds)
    frontier: set[int] = set(seeds)
    edges: dict[int, TaskDependency] = {}

    while frontier:
        batch = list(frontier)
        result = await session.execute(
            select(TaskDependency).where(
                or_(
                    TaskDependency.blocker_id.in_(batch),
                    TaskDependency.blocked_id.in_(batch),
                )
            )
        )
        frontier = set()
        for dep in result.scalars():
            edges[dep.id] = dep
            for other in (dep.blocker_id, dep.blocked_id):
                if other not in seen:
                    seen.add(other)
                    frontier.add(other)

    return seen, list(edges.values())


async def load_rights(
    session: AsyncSession, user_id: int, task_ids: set[int]
) -> tuple[dict[int, set[str]], dict[int, PermissionLevel]]:
    """(my own roles per task, the level somebody else's grant gives me)."""
    if not task_ids:
        return {}, {}
    ids = list(task_ids)

    own: dict[int, set[str]] = defaultdict(set)
    result = await session.execute(
        select(TaskRole).where(TaskRole.user_id == user_id, TaskRole.task_id.in_(ids))
    )
    for row in result.scalars():
        own[row.task_id].add(row.role)

    permissions = await permissions_granted_to(session, user_id)
    if not permissions:
        return own, {}

    grantor_ids = {p.grantor_id for p in permissions}
    result = await session.execute(
        select(TaskRole).where(
            TaskRole.task_id.in_(ids), TaskRole.user_id.in_(list(grantor_ids))
        )
    )
    # task -> grantor -> the roles that grantor holds on it
    grantor_roles: dict[int, dict[int, set[str]]] = defaultdict(
        lambda: defaultdict(set)
    )
    for row in result.scalars():
        grantor_roles[row.task_id][row.user_id].add(row.role)

    granted: dict[int, PermissionLevel] = {}
    for task_id, holders in grantor_roles.items():
        for permission in permissions:
            held = holders.get(permission.grantor_id)
            if not held or not (held & permission.role_names):
                continue
            # The grantor holds one of the roles the grant covers, so they can
            # change this task themselves and may pass that on.
            if granted.get(task_id) != PermissionLevel.modify:
                granted[task_id] = permission.level

    return own, granted


def may_edit(
    task_id: int,
    roles: dict[int, set[str]],
    granted: dict[int, PermissionLevel],
) -> bool:
    """Any role on the task at all, or a granted `modify`."""
    if roles.get(task_id):
        return True
    return granted.get(task_id) == PermissionLevel.modify


async def would_create_cycle(
    session: AsyncSession, extra_edges: list[tuple[int, int]]
) -> bool:
    """extra_edges are (blocker_id, blocked_id) pairs about to be stored."""
    result = await session.execute(
        select(TaskDependency.blocker_id, TaskDependency.blocked_id)
    )
    adjacency: dict[int, list[int]] = defaultdict(list)
    for blocker, blocked in list(result.all()) + extra_edges:
        adjacency[blocker].append(blocked)

    WHITE, GREY, BLACK = 0, 1, 2
    colour: dict[int, int] = defaultdict(int)

    def visit(start: int) -> bool:
        stack: list[tuple[int, int]] = [(start, 0)]
        colour[start] = GREY
        while stack:
            node, index = stack.pop()
            if index < len(adjacency[node]):
                stack.append((node, index + 1))
                nxt = adjacency[node][index]
                if colour[nxt] == GREY:
                    return True
                if colour[nxt] == WHITE:
                    colour[nxt] = GREY
                    stack.append((nxt, 0))
            else:
                colour[node] = BLACK
        return False

    for node in list(adjacency):
        if colour[node] == WHITE and visit(node):
            return True
    return False
