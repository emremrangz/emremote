# syntax=docker/dockerfile:1
# emremote application image: Go API + guacd tunnel + static React UI.

# ---- Web UI ----
# The web UI and the Go compiler always run on the build machine; only the Go output targets the final architecture.
FROM --platform=$BUILDPLATFORM node:22.23.3-alpine3.24 AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
# npm 10 (bundled with Node 22) cannot resolve vitest 4's optional peer set.
RUN npm install -g npm@11.19.1 && npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run typecheck && npm test && npx vite build

# ---- API server ----
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24 AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
ARG EMREMOTE_VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN go vet ./... && go test ./... \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags "-s -w -X main.version=${EMREMOTE_VERSION}" -o /out/emremote ./cmd/emremote

# ---- Runtime: no shell, no package manager, non-root ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /out/emremote /app/emremote
COPY --from=web /web/dist /app/web
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/emremote", "healthcheck"]
ENTRYPOINT ["/app/emremote"]
