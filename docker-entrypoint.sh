#!/bin/sh
set -eu

DB_HOST="${PGHOST:-postgres}"
DB_PORT="${PGPORT:-5432}"
DB_USER="${PGUSER:-postgres}"

printf 'Waiting for PostgreSQL to be ready at %s:%s...
' "$DB_HOST" "$DB_PORT"
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" >/dev/null 2>&1; do
  printf 'PostgreSQL is unavailable - sleeping
'
  sleep 2
done

printf 'PostgreSQL is up - executing migrations
'
node -e 'import("./src/database/migrate.js").then((m) => m.migrateDatabase())'

printf 'Starting application
'
exec "$@"
