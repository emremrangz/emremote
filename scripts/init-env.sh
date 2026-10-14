#!/bin/sh
# Creates .env from .env.example with fresh random secrets.
#   scripts/init-env.sh [address]        address = the IP or name you will open in the browser
# Refuses to overwrite an existing .env.
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] && { echo ".env already exists; leaving it alone." >&2; exit 1; }
[ -f .env.example ] || { echo ".env.example not found (run this from the emremote folder)." >&2; exit 1; }

rand() { # rand <bytes> [strip]
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"; else head -c "$1" /dev/urandom | base64; fi
}

addr="${1:-}"
if [ -z "$addr" ]; then
  addr="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
[ -n "$addr" ] || addr="localhost"

# An IP address needs DEFAULT_SNI set to itself (browsers send no server name for IPs).
sni="localhost"
case "$addr" in *[!0-9.]*) ;; *) sni="$addr" ;; esac

# Use the standard ports when they are free; otherwise pick the next free ones (another web
# server or reverse proxy, such as Nginx Proxy Manager, often owns 80 and 443).
busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$1\$"
  elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$1\$"
  else return 1; fi
}
pick() { # pick <preferred> <fallback-start>
  p="$1"
  while busy "$p"; do
    [ "$p" = "$1" ] && p="$2" || p=$((p + 1))
  done
  echo "$p"
}
https_port="$(pick 443 8443)"
http_port="$(pick 80 8088)"

pg="$(rand 24 | tr -d '/+=\n')"
key="$(rand 32 | tr -d '\n')"

umask 077
sed -e "s|^EMREMOTE_SITE_ADDRESS=.*|EMREMOTE_SITE_ADDRESS=$addr|" \
    -e "s|^EMREMOTE_DEFAULT_SNI=.*|EMREMOTE_DEFAULT_SNI=$sni|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg|" \
    -e "s|^EMREMOTE_ENCRYPTION_KEY=.*|EMREMOTE_ENCRYPTION_KEY=$key|" \
    -e "s|^EMREMOTE_HTTPS_PORT=.*|EMREMOTE_HTTPS_PORT=$https_port|" \
    -e "s|^EMREMOTE_HTTP_PORT=.*|EMREMOTE_HTTP_PORT=$http_port|" \
    .env.example > .env
chmod 600 .env

url="https://$addr"
[ "$https_port" = "443" ] || url="https://$addr:$https_port"
echo "Created .env for $url"
[ "$https_port" = "443" ] || echo "Ports 80/443 are in use on this machine, so emremote will listen on $https_port (HTTPS) and $http_port (HTTP)."
echo "Back up EMREMOTE_ENCRYPTION_KEY from .env somewhere safe: without it, saved passwords cannot be recovered."
