import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// During development, API and tunnel requests are proxied to a running backend
// (EMREMOTE_DEV_BACKEND, default http://localhost:8080).
const backend = process.env.EMREMOTE_DEV_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Never inline assets as data: URIs; the CSP only allows same-origin fonts/scripts.
  build: { sourcemap: false, chunkSizeWarningLimit: 800, assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: false },
      "/healthz": backend,
    },
  },
  test: { environment: "node" },
});
