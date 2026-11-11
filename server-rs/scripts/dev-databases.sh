#!/usr/bin/env bash
# Start a throwaway PostgreSQL and MariaDB for the multi-database tests, each with an empty database `kanban_test`.
#
#   scripts/dev-databases.sh start [dir]   # prints the two KANBAN_DATABASE_URL values
#   scripts/dev-databases.sh stop  [dir]
#
# Needs the server programs installed (Debian/Ubuntu: postgresql, mariadb-server). Data lives in [dir]
# (default: $TMPDIR/kanban-dev-databases) and is removed by `stop`. When run as root, the servers run as the
# `postgres` and `mysql` users, which refuse to run as root.
set -euo pipefail

cmd="${1:-start}"
dir="${2:-${TMPDIR:-/tmp}/kanban-dev-databases}"
pg_port=55432
my_port=53306
pg_bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"

as_user() { # as_user <user> <command...>
  local user="$1"; shift
  if [ "$(id -u)" = "0" ]; then runuser -u "$user" -- "$@"; else "$@"; fi
}

case "$cmd" in
  start)
    mkdir -p "$dir/pg" "$dir/my" "$dir/run"
    if [ "$(id -u)" = "0" ]; then chown postgres "$dir/pg"; chown mysql "$dir/my"; chmod 777 "$dir/run" "$dir"; fi
    if [ ! -f "$dir/pg/PG_VERSION" ]; then
      as_user postgres "$pg_bin/initdb" -D "$dir/pg" -U kanban --auth=trust -E UTF8 >/dev/null
    fi
    as_user postgres "$pg_bin/pg_ctl" -D "$dir/pg" -o "-p $pg_port -k $dir/run -c listen_addresses=127.0.0.1" -l "$dir/pg.log" -w start >/dev/null
    as_user postgres "$pg_bin/psql" -h 127.0.0.1 -p "$pg_port" -U kanban -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='kanban_test'" | grep -q 1 \
      || as_user postgres "$pg_bin/createdb" -h 127.0.0.1 -p "$pg_port" -U kanban kanban_test
    if [ ! -d "$dir/my/mysql" ]; then
      as_user mysql mariadb-install-db --datadir="$dir/my" --auth-root-authentication-method=normal >/dev/null
    fi
    as_user mysql mariadbd --datadir="$dir/my" --port="$my_port" --bind-address=127.0.0.1 \
      --socket="$dir/run/mysql.sock" --pid-file="$dir/run/mysql.pid" --log-error="$dir/my.log" >/dev/null 2>&1 </dev/null &
    for _ in $(seq 1 60); do
      mariadb --socket="$dir/run/mysql.sock" -u root -e "SELECT 1" >/dev/null 2>&1 && break
      sleep 0.5
    done
    mariadb --socket="$dir/run/mysql.sock" -u root -e "
      CREATE DATABASE IF NOT EXISTS kanban_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
      CREATE USER IF NOT EXISTS 'kanban'@'127.0.0.1' IDENTIFIED BY 'kanban';
      GRANT ALL ON kanban_test.* TO 'kanban'@'127.0.0.1';"
    echo "postgresql://kanban@127.0.0.1:$pg_port/kanban_test?sslmode=disable"
    echo "mysql://kanban:kanban@127.0.0.1:$my_port/kanban_test?sslmode=disable"
    ;;
  stop)
    as_user postgres "$pg_bin/pg_ctl" -D "$dir/pg" -m fast stop >/dev/null 2>&1 || true
    if [ -f "$dir/run/mysql.pid" ]; then kill "$(cat "$dir/run/mysql.pid")" 2>/dev/null || true; fi
    sleep 1
    rm -rf "$dir"
    ;;
  *)
    echo "usage: $0 start|stop [dir]" >&2
    exit 2
    ;;
esac
