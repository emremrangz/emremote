#!/bin/sh
# One-step installer: downloads the compose file, generates secrets and starts emremote.
#   curl -fsSL https://raw.githubusercontent.com/emremrangz/emremote/main/scripts/install.sh | sh
# Optional: EMREMOTE_ADDRESS=192.168.1.50 (address you will browse to), EMREMOTE_DIR=emremote (install folder)
set -eu

REPO="emremrangz/emremote"
REF="${EMREMOTE_REF:-main}"
DIR="${EMREMOTE_DIR:-emremote}"
RAW="https://raw.githubusercontent.com/$REPO/$REF"

need() { command -v "$1" >/dev/null 2>&1 || { echo "emremote needs '$1' but it is not installed." >&2; exit 1; }; }
need docker
need curl
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required ('docker compose')." >&2; exit 1; }

if [ -e "$DIR/.env" ]; then
  echo "$DIR/.env already exists. To update an existing install run: cd $DIR && docker compose pull && docker compose up -d" >&2
  exit 1
fi

mkdir -p "$DIR/deploy" "$DIR/scripts"
cd "$DIR"
for f in compose.yaml .env.example deploy/Caddyfile scripts/init-env.sh; do
  curl -fsSL "$RAW/$f" -o "$f"
done
chmod +x scripts/init-env.sh

./scripts/init-env.sh "${EMREMOTE_ADDRESS:-}"
docker compose pull
docker compose up -d

addr="$(sed -n 's/^EMREMOTE_SITE_ADDRESS=//p' .env | head -1)"
port="$(sed -n 's/^EMREMOTE_HTTPS_PORT=//p' .env | head -1)"
url="https://$addr"
[ "$port" = "443" ] || url="https://$addr:$port"
echo
echo "emremote is starting. Open $url and create the administrator account."
echo "(The browser warns about the certificate until you trust the local CA; see docs/DEPLOYMENT.md.)"
