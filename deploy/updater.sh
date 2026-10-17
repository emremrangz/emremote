#!/bin/sh
# emremote updater (optional; only runs with the "updater" compose profile).
#
# It watches for /state/update.request, which an administrator creates with the "Update now" button,
# and then runs the same fixed steps every time: back up the database, download the new image,
# restart the application, wait until it is healthy and go back to the old image if it is not.
# Nothing from the request (or from the application) is ever used as a command or an argument.
#
# Progress goes to /state/update.log and /state/update.status, which the application shows.
set -u

STATE=/state
LOG="$STATE/update.log"
STATUS="$STATE/update.status"
REQUEST="$STATE/update.request"
ALIVE="$STATE/updater.alive"
COMPOSE_FILE=/project/compose.yaml
ENV_FILE=/project/.env
BACKUPS=/project/backups

umask 022

# Where this project lives on the host and what it is called: Docker records both on this container.
SELF="$(hostname)"
HOST_DIR="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$SELF")"
PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$SELF")"
[ -n "$HOST_DIR" ] && [ -n "$PROJECT" ] || { echo "updater: cannot tell which compose project this is" >&2; exit 1; }

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$HOST_DIR" --env-file "$ENV_FILE" "$@"; }
log() { printf '%s\n' "$*" >> "$LOG"; }
now() { date +%s; }

FROM=""
STARTED=""
set_status() { # set_status <state> [finished]
  printf 'state=%s\nfrom=%s\nstarted=%s\nfinished=%s\n' "$1" "$FROM" "$STARTED" "${2:-}" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

image_version() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null; }

fail() {
  log "FAILED: $*"
  set_status failed "$(now)"
}

run_update() {
  : > "$LOG"
  STARTED="$(now)"
  FROM=""
  set_status running

  CID="$(dc ps -q emremote 2>/dev/null | head -n1)"
  REF="$(dc config --images 2>/dev/null | grep '/emremote:' | head -n1)"
  [ -n "$CID" ] && [ -n "$REF" ] || { fail "could not find the emremote container"; return; }
  OLD_ID="$(docker inspect --format '{{.Image}}' "$CID")"
  FROM="$(image_version "$OLD_ID")"
  set_status running
  log "Current version: ${FROM:-unknown}"

  log "Backing up the database..."
  mkdir -p "$BACKUPS"
  DUMP="$BACKUPS/emremote-db-update-$(date +%Y%m%d-%H%M%S).dump"
  if ! (umask 077; dc exec -T postgres pg_dump -U emremote -d emremote --format=custom --compress=6 > "$DUMP"); then
    rm -f "$DUMP"
    fail "the database backup did not work, nothing was changed"
    return
  fi
  log "Backup saved: $(basename "$DUMP")"
  # Keep the five newest backups made by this updater.
  ls -1t "$BACKUPS"/emremote-db-update-*.dump 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f"; done

  log "Downloading $REF ..."
  if ! dc pull -q emremote >> "$LOG" 2>&1; then
    fail "the new image could not be downloaded (is the server online?), nothing was changed"
    return
  fi
  NEW_ID="$(docker image inspect --format '{{.Id}}' "$REF")"
  if [ "$NEW_ID" = "$OLD_ID" ]; then
    log "This is already the newest image for the tag in use ($REF)."
    log "If .env pins EMREMOTE_IMAGE_TAG to a version, change it to move to a newer one."
    set_status done "$(now)"
    return
  fi
  TO="$(image_version "$NEW_ID")"
  log "New version: ${TO:-unknown}"

  log "Restarting emremote..."
  if ! OUT="$(dc up -d --no-deps emremote 2>&1)"; then
    printf '%s\n' "$OUT" >> "$LOG"
    log "Could not start the new version, going back to the old one..."
    docker tag "$OLD_ID" "$REF" && dc up -d --no-deps emremote >/dev/null 2>&1
    fail "the new version did not start; the old one was restored"
    return
  fi

  log "Waiting for emremote to become healthy..."
  CID="$(dc ps -q emremote 2>/dev/null | head -n1)"
  i=0
  while [ "$i" -lt 60 ]; do
    H="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null)"
    [ "$H" = "healthy" ] && break
    case "$H" in unhealthy|exited|dead) break ;; esac
    i=$((i + 1)); sleep 2
  done
  if [ "$H" != "healthy" ]; then
    log "The new version is not healthy ($H). Last log lines:"
    docker logs --tail 15 "$CID" >> "$LOG" 2>&1
    log "Going back to the old version..."
    docker tag "$OLD_ID" "$REF" && dc up -d --no-deps emremote >/dev/null 2>&1
    fail "the new version did not become healthy; the old one was restored (backup: $(basename "$DUMP"))"
    return
  fi
  log "Updated to ${TO:-the new version}."
  set_status done "$(now)"
}

# The heartbeat lives in its own loop so the application can tell the updater is there even during a long download.
( while true; do now > "$ALIVE.tmp" && mv "$ALIVE.tmp" "$ALIVE"; sleep 5; done ) &

echo "updater ready: project $PROJECT in $HOST_DIR"
while true; do
  if [ -f "$REQUEST" ]; then
    rm -f "$REQUEST"
    run_update
  fi
  sleep 2
done
