#!/usr/bin/env bash
# Restore an emremote database dump created by scripts/backup.sh.
#
#   scripts/restore.sh backups/emremote-db-YYYYmmdd-HHMMSS.dump
#
# The running database is replaced. .env must contain the same
# EMREMOTE_ENCRYPTION_KEY that was in use when the dump was taken.
set -euo pipefail
cd "$(dirname "$0")/.."

dump="${1:?usage: scripts/restore.sh <dump-file>}"
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 1; }

read -r -p "This replaces ALL current emremote data with $dump. Type 'restore' to continue: " answer
[ "$answer" = "restore" ] || { echo "Aborted."; exit 1; }

docker compose up -d postgres
docker compose stop emremote caddy
until docker compose exec -T postgres pg_isready -U emremote -d emremote >/dev/null 2>&1; do sleep 1; done

echo "Restoring…"
docker compose exec -T postgres pg_restore -U emremote -d emremote --clean --if-exists --no-owner --single-transaction \
  < "$dump"

docker compose up -d
echo "Restore complete. Active browser sessions from the dump remain valid until they expire."
