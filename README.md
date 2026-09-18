# planner

A personal planning tool. Tasks, the connections between them, and a workspace
that draws the whole dependency graph so blockers always sit above what they
block.

FastAPI + SQLAlchemy on Postgres; the front end is plain ES modules with no
build step.

## Running it

### Locally, without Postgres

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
DATABASE_URL="sqlite+aiosqlite:///./planner-dev.db" .venv/Scripts/python -m uvicorn src.main:app --reload --port 11111
```

Then open <http://127.0.0.1:11111/>.

### On the server (Ubuntu)

Everything runs natively: Postgres from apt, the app in a virtualenv under
systemd, and nginx in front. From a checkout of this repository on the server:

```bash
sudo deploy/deploy.sh
```

That one script installs what is missing (Postgres, python3-venv), creates a
`planner` system user, a Postgres role and database with a generated password
kept in `/etc/planner/planner.env`, copies the committed code to
`/opt/planner/app`, builds `/opt/planner/venv`, and starts `planner.service`
on `127.0.0.1:11111` — migrations included. It needs Python 3.10 or newer, and
says what to install if the server's is older.

It is safe to re-run, and re-running it is how you update:

```bash
git pull && sudo deploy/deploy.sh
```

It deploys the checkout's committed `HEAD`, not uncommitted edits. If the new
version fails to start, it prints the service log and keeps the previous code in
`/opt/planner/app.old`.

Then point nginx at it. The app serves its own pages and static files and uses
only relative URLs, so it works wherever it is mounted: proxy the site root to
it (`deploy/nginx-planner.conf`), or proxy a sub-path with the prefix stripped,
e.g. `location /planner/ { proxy_pass http://127.0.0.1:11111/; }`, and it runs
at `/planner/`. What nginx does with any path it does *not* forward is up to
nginx — an unproxied `/` shows nginx's own default page.

```bash
sudo systemctl status planner
journalctl -u planner -f
```

## Migrations

The schema is managed by Alembic (`migrations/`). The app runs any pending
migrations itself when it starts, so deploying a new version is just
restarting it. Set `MIGRATE_ON_START=0` to take that over by hand — worth doing
if you ever run more than one app process against the same database.

The database URL comes from `DATABASE_URL`, the same variable the app reads;
it is deliberately not in `alembic.ini`.

After changing `src/models.py`:

```bash
.venv/Scripts/alembic revision --autogenerate -m "what changed"
```

Read what it wrote before committing it — autogenerate misses some things
(renames look like a drop plus an add, and Postgres enum types need dropping by
hand in a `downgrade`, as the first migration shows). Then:

```bash
.venv/Scripts/alembic upgrade head
```

Constraint names follow a fixed convention (`src/db.py`), so a later migration
can always find a constraint by name, SQLite included.

## Signing in

One screen, username and password:

- a username nobody has taken becomes yours, with the password you typed
- a username that exists but has no password adopts the one you typed
- otherwise the password has to match

Either way you get a token, which the browser keeps in `localStorage` and sends
as `Authorization: Bearer …`.

## The data model

| Thing | What it holds |
| --- | --- |
| `User` | username, optional password hash |
| `AuthToken` | a hash of the token, its user, when it was issued |
| `Task` | title, description, deadline, completion percent, last-update stamp |
| `TaskLink` | a URL hanging off a task |
| `TaskDependency` | blocker → blocked |
| `TaskRole` | a user's part in a task — owner, assignee, requestor, consultant, … |
| `UserPermission` | one user's standing grant to another, scoped by role |
| `PermissionRole` | a role that grant is scoped to |

Roles are plain strings. The pickers offer a built-in vocabulary plus anything
already in use, so you can invent one; `owner` is the only role code cares
about, and every task needs at least one.

### Who sees what

Rights come from two places.

A **role on the task** — its owner may change it, anybody else with a role may
look at it.

A **permission you were given**, which is between two people rather than about
one task: *"you may view (or modify) every task where I am the owner, or the
assignee, or the consultant"*. Because it is a rule and not a list, it keeps
covering tasks the grantor picks up later. A granted `modify` is capped at what
the grantor actually holds, so it only confers modify on tasks they own, and
grants do not chain. They live on their own screen at `/permissions`.

Your workspace starts from every task you reach either way, then follows
dependencies outward in both directions to every leaf — so you see the whole
chain you are part of, even the parts that belong to other people. Tasks
reached only through the graph are read-only. Dependency loops are refused.

### Finished work fading out

A task that is 100% complete and has not been edited for two months drops out
of the workspace. The header says how many went that way and puts them back
with a click (`GET /workspace?include_finished=true`). Editing one brings
it back for another two months. Old tasks are never deleted, and they stay
connectable, so re-saving a task cannot silently cut its links to them.

## The workspace

Positions are worked out entirely in the browser (`www/js/layout.js`); the API
only ever deals in data.

The layout is a Sugiyama pipeline: split into unconnected groups, break any
stray cycles, put every task on a row below all of its blockers, thread
multi-row edges through reserved channels, cut crossings with median ordering
and adjacent swaps, place x by the priority method, then clamp each row into
the narrowest width that row's contents allow. Edges are cubic Béziers leaving
straight down and arriving straight down, drawn only in the empty bands between
rows — which is what makes it impossible for one to cross a task box.

`www/layout-test.html` checks all of that in a browser, including walking each
rendered curve point by point to prove it never enters a box. Open it at
`/layout-test.html` with the server running.

### Using it

- Click empty space for a `+`, click that to start a task.
- An unconnected new task has a drag handle; drag it anywhere.
- `↑` on a task starts a connection from whatever blocks it, `↓` from whatever
  it blocks. A dashed curve follows the pointer, targets grow a dot to land on,
  and everything re-arranges as soon as the connection lands.
- `✓` saves, `✕` throws away a draft or deletes a saved task. `Esc` backs out
  of a form without touching anything.
- `✎` turns a saved task back into that same form.
- The people section lists who is on the task and what they are to it. Both
  fields have pickers — names sorted by how often they turn up on your other
  tasks, roles from the known vocabulary. A name nobody has registered is
  created when you save, and whoever first signs in under it claims it.

## API

Routes sit at the app's root, next to the pages (`index.html`,
`workspace.html`, `permissions.html`):

```
POST   /auth/login              {username, password} -> {token, user, outcome}
GET    /auth/me
POST   /auth/logout
GET    /workspace               the graph you can see
GET    /workspace?include_finished=true
GET    /health
POST   /tasks
PUT    /tasks/{id}
DELETE /tasks/{id}
GET    /permissions             {granted, received}
POST   /permissions             {username, level, roles}
PUT    /permissions/{id}
DELETE /permissions/{id}
GET    /users/suggestions       names, most-used first
GET    /roles                   the role vocabulary
```

A `PUT` carries the task's whole set of connections and its whole cast, so
leaving `blocks` out clears it. Leaving `roles` out entirely is the exception:
the existing cast stays as it is.

## Tests

```bash
.venv/Scripts/python tests/smoke.py
```

Runs the API end to end against a throwaway SQLite file: the login rules, task
writes, cycle refusal, casting people onto tasks, role-scoped permissions, the
two-month cutoff, and who is allowed to do what.

Before any of that it builds the schema through the migrations — up, all the
way down, and up again — and fails if the models have drifted from what the
migrations produce, so a forgotten `alembic revision` gets caught here.

To run it on Postgres, point it at a database of its own. It wipes it:

```bash
SMOKE_DATABASE_URL="postgresql+asyncpg://planner@localhost/planner_smoke" .venv/Scripts/python tests/smoke.py
```
