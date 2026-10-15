#!/usr/bin/env bash
# Update emremote in one step, from any folder:
#
#   ~/emremote/scripts/update.sh [--no-backup] [--yes]
#
# 1. refreshes the compose file and scripts (git pull, or a download for installs made with install.sh),
# 2. backs up the database first (stops here if the backup fails),
# 3. pulls the new images and restarts what changed,
# 4. waits until the application is healthy and tells you how to go back if it is not.
set -euo pipefail
cd "$(dirname "$0")/.."

backup=1
for a in "$@"; do
  case "$a" in
    --no-backup) backup=0 ;;
    --yes|-y) ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker is not installed." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }
[ -f compose.yaml ] && [ -f .env ] || { echo "Run this from an emremote install (compose.yaml and .env must exist)." >&2; exit 1; }

image_ref() { docker compose config --images 2>/dev/null | grep -m1 'emremote/emremote\|/emremote:' || true; }
image_info() { # image_info <ref> -> "version (short id)"
  local v id
  v="$(docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)"
  id="$(docker image inspect "$1" --format '{{.Id}}' 2>/dev/null | sed 's/^sha256://' | cut -c1-12 || true)"
  if [ -z "$id" ]; then echo "not installed"; else echo "${v:-unknown} ($id)"; fi
}

img="$(image_ref)"
old_id="$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null || true)"
echo "Installed now: $(image_info "$img")"

# Runs a step quietly and shows its output only when it fails.
quiet() {
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then rm -f "$log"; return 0; fi
  cat "$log" >&2; rm -f "$log"; return 1
}

# 1. compose file and scripts
if [ -d .git ]; then
  echo "Refreshing files…"
  if ! git diff --quiet -- compose.yaml deploy scripts .env.example 2>/dev/null; then
    echo "You changed tracked files (compose.yaml, deploy/, scripts/); leaving them alone. Use compose.override.yaml for local changes."
  elif ! quiet git pull -q --ff-only; then
    echo "Could not update the files with git. If the history of this copy has diverged from GitHub, run:" >&2
    echo "  git fetch origin && git reset --hard origin/main" >&2
    exit 1
  fi
else
  echo "Refreshing files from GitHub…"
  base="https://raw.githubusercontent.com/emremrangz/emremote/${EMREMOTE_REF:-main}"
  for f in compose.yaml .env.example deploy/Caddyfile scripts/init-env.sh scripts/backup.sh scripts/restore.sh scripts/update.sh; do
    mkdir -p "$(dirname "$f")"
    curl -fsSL "$base/$f" -o "$f.new" && mv "$f.new" "$f"
  done
  chmod +x scripts/*.sh
fi

# 2. backup
if [ "$backup" = 1 ]; then
  echo "Backing up the database…"
  if ! quiet ./scripts/backup.sh "${EMREMOTE_BACKUP_DIR:-./backups}"; then
    echo "The backup failed, so nothing was updated. Fix that, or run again with --no-backup if you accept the risk." >&2
    exit 1
  fi
else
  echo "Skipping the backup (--no-backup)."
fi

# 3. new images
echo "Downloading and starting the new version…"
quiet docker compose pull -q
quiet docker compose up -d --remove-orphans

# 4. wait for health
cid="$(docker compose ps -q emremote)"
echo -n "Waiting for emremote to become healthy"
status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
  case "$status" in healthy|running) break ;; unhealthy|exited|dead) break ;; esac
  echo -n "."
  sleep 2
done
echo
new_id="$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null || true)"
echo "Running now:   $(image_info "$img")"

if [ "$status" != "healthy" ] && [ "$status" != "running" ]; then
  echo
  echo "emremote did not become healthy (status: $status). Last log lines:" >&2
  docker compose logs --tail 25 emremote >&2 || true
  echo >&2
  echo "To go back to the previous image: docker tag ${old_id#sha256:} $img && docker compose up -d emremote" >&2
  echo "The database backup from before the update is in ${EMREMOTE_BACKUP_DIR:-./backups}." >&2
  exit 1
fi
if [ -n "$old_id" ] && [ "$old_id" = "$new_id" ]; then
  echo "Already up to date."
else
  echo "Updated."
fi
