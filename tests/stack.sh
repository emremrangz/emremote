#!/usr/bin/env bash
# Isolated test stack (never touches a real installation): the application under the project name
# "emremote-preview" on port 8443, plus the disposable servers of tests/targets (SSH, RDP, VNC, Telnet).
#
#   tests/stack.sh up         start both (generates secrets in $STACK_DIR)
#   tests/stack.sh smoke      run tests/e2e/smoke.mjs against it (the first run also creates the administrator)
#   tests/stack.sh browser    run tests/e2e/browser.mjs (Chromium via Playwright; takes about half an hour)
#   tests/stack.sh down       remove everything, including its data
#
# Needs Docker. Node and Playwright run in containers. LAN_IP is this machine's address (default: first one).
set -u
cd "$(dirname "$0")/.."
P="${STACK_DIR:-/tmp/emremote-stack}"
IP="${LAN_IP:-$(hostname -I | awk '{print $1}')}"
E="docker compose -p emremote-preview --env-file $P/preview/.env"
case "${1:-}" in
up)
  mkdir -p "$P/preview" "$P/pw"
  cat > "$P/preview/.env" <<ENV
EMREMOTE_SITE_ADDRESS=$IP
EMREMOTE_DEFAULT_SNI=$IP
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
EMREMOTE_ENCRYPTION_KEY=$(openssl rand -base64 32)
EMREMOTE_ALLOWED_TARGET_NETWORKS=${IP%.*}.0/24
EMREMOTE_HTTPS_PORT=8443
EMREMOTE_HTTP_PORT=8088
EMREMOTE_EDGE_SUBNET=172.31.251.0/24
EMREMOTE_DATA_DIR=$P/preview/data
EMREMOTE_AUTO_SSH_PORT=12222
EMREMOTE_JUMP_TARGET_NETWORKS=172.29.77.0/24
${EXTRA_ENV:-}
ENV
  chmod 600 "$P/preview/.env"
  $E up -d --no-build 2>&1 | tail -1
  TP=$(openssl rand -base64 12 | tr -d '/+='); echo "$TP" > "$P/target_pw"
  TARGET_PASSWORD=$TP docker compose -f tests/targets/compose.yaml up -d --build 2>&1 | tail -1
  # The simulated Cisco switch (port 12522) that the smoke test reads.
  docker rm -f emremote-fakeswitch >/dev/null 2>&1
  docker run -d --name emremote-fakeswitch --network host -e TARGET_PASSWORD="$TP" -v "$PWD/tests/targets/fakeswitch:/src/cmd/fakeswitch:ro" -v "$PWD/app/backend:/src:ro" -w /src golang:1.26.9-alpine3.24 go run ./cmd/fakeswitch >/dev/null
  until curl -sk "https://$IP:8443/healthz" 2>/dev/null | grep -q ok; do sleep 2; done; sleep 5
  openssl rand -base64 18 | tr -d '/+=' > "$P/admin_pw"
  : > "$P/token"
  cp "$P/preview/data/caddy/data/caddy/pki/authorities/local/root.crt" "$P/preview-root.crt"
  SPKI=$(openssl x509 -in "$P/preview-root.crt" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
  LEAF=$(echo | openssl s_client -connect "$IP:8443" 2>/dev/null | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
  echo "$SPKI,$LEAF" > "$P/spki"
  [ -d "$P/pw/node_modules/playwright" ] || docker run --rm -v "$P/pw:/w" -w /w mcr.microsoft.com/playwright:v1.48.2-noble sh -c 'npm init -y >/dev/null; npm i --no-audit --no-fund playwright@1.48.2 >/dev/null 2>&1'
  echo "stack ready: https://$IP:8443  (admin password in $P/admin_pw)" ;;
smoke)
  docker run --rm -v "$PWD/tests:/tests:ro" -v "$P:/s" -e NODE_EXTRA_CA_CERTS=/s/preview-root.crt -e EMREMOTE_URL="https://$IP:8443" -e ADMIN_USER=admin -e ADMIN_PASSWORD="$(cat "$P/admin_pw")" -e SETUP_TOKEN="$(cat "$P/token")" -e TARGET_HOST="$IP" -e TARGET_PASSWORD="$(cat "$P/target_pw")" node:22.23.3-alpine3.24 node /tests/e2e/smoke.mjs 2>&1 | grep -E "FAIL|checks passed|${2:-NOMATCH}" ;;
browser)
  cp tests/e2e/browser.mjs "$P/pw/"; rm -rf "$P/shots"
  timeout 2700 docker run --rm --ipc=host -v "$P/pw:/w" -v "$P:/s" -w /w -e EMREMOTE_URL="https://$IP:8443" -e ADMIN_USER=admin -e ADMIN_PASSWORD="$(cat "$P/admin_pw")" -e TARGET_HOST="$IP" -e TARGET_PASSWORD="$(cat "$P/target_pw")" -e CA_SPKI="$(cat "$P/spki")" -e SHOTS=/s/shots mcr.microsoft.com/playwright:v1.48.2-noble node browser.mjs > "$P/br.log" 2>&1
  echo "passed: $(grep -cE '^PASS' "$P/br.log")"; grep -E "FAIL|passed|failed|Error|at /w|${2:-NOMATCH}" "$P/br.log" | head -20 ;;
down)
  docker rm -f emremote-fakeswitch >/dev/null 2>&1
  $E down 2>&1 | tail -1; TARGET_PASSWORD=x docker compose -f tests/targets/compose.yaml down --rmi local 2>&1 | tail -1
  docker volume rm emremote-preview_state >/dev/null 2>&1
  rm -rf "$P/preview/data" ;;
*) sed -n 2,11p "$0"; exit 2 ;;
esac
