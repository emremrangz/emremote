#!/usr/bin/env bash
# Back up the emremote database and the reverse proxy's local CA.
#
#   scripts/backup.sh [destination-directory]     (default: ./backups)
#
# The database dump contains connection secrets encrypted with
# EMREMOTE_ENCRYPTION_KEY from .env. Back up .env separately (e.g. in your
# password manager): without the key, stored passwords cannot be decrypted;
# with the key and the dump together, they can — store them apart.
set -euo pipefail
cd "$(dirname "$0")/.."

dest="${1:-./backups}"
ts="$(date +%Y%m%d-%H%M%S)"
data_dir="$(grep -E '^EMREMOTE_DATA_DIR=' .env 2>/dev/null | cut -d= -f2- || true)"
data_dir="${data_dir:-./data}"

umask 077
mkdir -p "$dest"

echo "Dumping PostgreSQL…"
docker compose exec -T postgres pg_dump -U emremote -d emremote --format=custom --compress=6 \
  > "$dest/emremote-db-$ts.dump"

if [ -d "$data_dir/caddy/data" ]; then
  echo "Archiving Caddy data (local CA and certificates)…"
  tar -czf "$dest/emremote-caddy-$ts.tar.gz" -C "$data_dir/caddy" data
fi

echo
ls -l "$dest"/emremote-*-"$ts".*
echo
echo "Done. Remember: .env (EMREMOTE_ENCRYPTION_KEY) is NOT included — keep a separate copy."
