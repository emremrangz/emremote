# Contributing to emremote

Thanks for helping. This is a small project with a few firm rules, mostly about not weakening its
security.

## Ground rules

- **Security first.** Read [docs/SECURITY.md](docs/SECURITY.md). A change must not return secrets from
  the API or write them to logs, must keep the target-network policy (SSRF) check on every outgoing
  connection, and must not add a way to run arbitrary commands on a remote computer or on the server.
- **No TLS shortcuts.** Do not disable certificate verification to make something work. Pin the
  certificate or host key instead.
- **English only** in the interface, documentation and commit messages.
- **Say what you did not test.** If a feature needs real hardware (a Windows host, a Hyper-V server, a
  network card with Wake-on-LAN), say whether you tried it.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the layout and the test setup. In short:

```bash
# backend (Go)
cd app/backend && go vet ./... && go test ./...

# frontend (React + TypeScript)
cd app/frontend && npm ci && npm run typecheck && npm test
```

The end-to-end tests in `tests/e2e` drive a running instance and need disposable test targets
(`tests/targets`). They create and delete their own devices, but run them against a throwaway
deployment, never one that holds real data.

## Pull requests

- Keep changes focused; describe the problem and how you checked the fix.
- Add or update tests for behaviour changes, and update `docs/` and `CHANGELOG.md`.
- Do not include real hostnames, addresses, credentials or screenshots of your network.

## Reporting security issues

Please do not open a public issue; follow [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the Apache License 2.0.
