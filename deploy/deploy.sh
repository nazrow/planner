#!/usr/bin/env bash
# Install or update the planner on an Ubuntu server, natively.
#
#     sudo deploy/deploy.sh
#
# Run it from a git checkout of this repository. It deploys the *committed*
# HEAD of that checkout -- uncommitted edits are left behind on purpose -- so
# updating is:
#
#     git pull && sudo deploy/deploy.sh
#
# Safe to re-run. What it sets up, and leaves alone once it exists:
#
#   system user      planner (no login shell)
#   database         Postgres role and database, both "planner", on 127.0.0.1
#   secrets          /etc/planner/planner.env (root:planner, 0640)
#   code             /opt/planner/app      (replaced on every run)
#   virtualenv       /opt/planner/venv     (requirements re-synced every run)
#   service          planner.service, uvicorn on 127.0.0.1:11111
#
# nginx is not touched: point your site at 127.0.0.1:11111 as shown in
# deploy/nginx-planner.conf.

set -euo pipefail

PREFIX=/opt/planner
APP="$PREFIX/app"
VENV="$PREFIX/venv"
CONF_DIR=/etc/planner
ENV_FILE="$CONF_DIR/planner.env"
UNIT=/etc/systemd/system/planner.service
SERVICE_USER=planner
DB_NAME=planner
DB_ROLE=planner
PORT=11111

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run this with sudo"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Running as root inside somebody else's checkout trips git's ownership check.
git_repo() { git -c safe.directory="$REPO" -C "$REPO" "$@"; }
git_repo rev-parse --git-dir >/dev/null 2>&1 \
    || die "$REPO is not a git checkout; clone the repository and run this from it"
REVISION="$(git_repo rev-parse --short HEAD)"

# --------------------------------------------------------------- preflight

# Whatever else holds the port (the old Docker stack, typically) has to go
# first; our own service holding it is fine, it gets restarted below.
if ss -ltnH "sport = :$PORT" | grep -q .; then
    if ! systemctl is-active --quiet planner; then
        ss -ltnp "sport = :$PORT" >&2 || true
        die "port $PORT is already taken by something else (if it is the old Docker stack: 'docker compose down' in its directory)"
    fi
fi

# ---------------------------------------------------------------- packages

say "System packages"
missing=()
for pkg in postgresql python3-venv git curl openssl; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" \
        || missing+=("$pkg")
done
if ((${#missing[@]})); then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
fi

# The code needs Python 3.10+. Take the newest interpreter on the box.
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null \
        && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
        PYTHON="$(command -v "$candidate")"
        break
    fi
done
[[ -n $PYTHON ]] || die "needs Python 3.10 or newer, found $(python3 --version 2>&1). On Ubuntu 20.04:
    sudo add-apt-repository ppa:deadsnakes/ppa
    sudo apt install python3.12 python3.12-venv
then run this again."
"$PYTHON" -c 'import venv, ensurepip' 2>/dev/null \
    || die "$PYTHON has no venv module; install the matching python3.X-venv package"
say "Using $("$PYTHON" --version)"

# ------------------------------------------------------------ user & secrets

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    say "Creating system user $SERVICE_USER"
    useradd --system --home-dir "$PREFIX" --no-create-home \
        --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
if [[ ! -f $ENV_FILE ]]; then
    say "Writing $ENV_FILE"
    DB_PASSWORD="$(openssl rand -hex 24)"
    umask 027
    cat >"$ENV_FILE" <<EOF
# Read by planner.service. Kept by deploy.sh across runs; delete it to have a
# new database password generated.
DB_PASSWORD=$DB_PASSWORD
DATABASE_URL=postgresql+asyncpg://$DB_ROLE:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
HOST=127.0.0.1
PORT=$PORT
TOKEN_TTL_DAYS=30
MIGRATE_ON_START=1
EOF
    umask 022
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE")"
[[ -n $DB_PASSWORD ]] || die "$ENV_FILE has no DB_PASSWORD line"

# ---------------------------------------------------------------- database

say "Database"
systemctl enable --now postgresql >/dev/null
# From / so postgres is not refused the caller's working directory.
psql_admin() { (cd / && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qtA "$@"); }

# Create the role if needed, and (re)set its password to the one on file, so
# the two can never drift apart. Fed through stdin to keep it out of argv.
if [[ -z $(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_ROLE'") ]]; then
    psql_admin -c "CREATE ROLE $DB_ROLE LOGIN"
fi
printf "ALTER ROLE %s WITH LOGIN PASSWORD '%s';\n" "$DB_ROLE" "$DB_PASSWORD" | psql_admin

if [[ -z $(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'") ]]; then
    (cd / && runuser -u postgres -- createdb --owner="$DB_ROLE" "$DB_NAME")
fi

# ------------------------------------------------------------------- code

say "Code at $REVISION"
install -d -m 0755 "$PREFIX"
staging="$PREFIX/app.new"
rm -rf "$staging"
mkdir -p "$staging"
git_repo archive --format=tar HEAD | tar -x -C "$staging"
echo "$REVISION" >"$staging/REVISION"
rm -rf "$PREFIX/app.old"
if [[ -d $APP ]]; then
    mv "$APP" "$PREFIX/app.old"
fi
mv "$staging" "$APP"

say "Virtualenv"
# A venv built by a different interpreter than the one chosen now is rebuilt.
if [[ -x $VENV/bin/python ]] \
    && [[ $("$VENV/bin/python" -c 'import sys; print(sys.version_info[:2])') \
       != $("$PYTHON" -c 'import sys; print(sys.version_info[:2])') ]]; then
    rm -rf "$VENV"
fi
[[ -x $VENV/bin/python ]] || "$PYTHON" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP/requirements.txt"

# ---------------------------------------------------------------- service

say "Service"
install -m 0644 "$APP/deploy/planner.service" "$UNIT"
systemctl daemon-reload
systemctl enable planner >/dev/null
systemctl restart planner

# Startup includes migrations, so give it a moment before calling it failed.
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        rm -rf "$PREFIX/app.old"
        say "Planner $REVISION is up on 127.0.0.1:$PORT"
        echo "    logs:    journalctl -u planner -f"
        echo "    nginx:   proxy the site to 127.0.0.1:$PORT (deploy/nginx-planner.conf)"
        exit 0
    fi
    sleep 1
done

echo >&2
journalctl -u planner -n 40 --no-pager >&2 || true
die "the service did not come up; the log is above (previous code kept in $PREFIX/app.old)"
