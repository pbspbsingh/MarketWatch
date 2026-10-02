import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { frontendBuildInfo } from "./scripts/build-info.mjs";

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  define: {
    __FRONTEND_BUILD_INFO__: JSON.stringify(frontendBuildInfo(command, mode)),
  },
  server: {
    proxy: {
      "/api": {
        target: loadEnv(mode, ".", "").MARKET_WATCH_API_URL ?? "http://127.0.0.1:8080",
        ws: true,
      },
    },
  },
}));
