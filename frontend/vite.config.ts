import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: loadEnv(mode, ".", "").MARKET_WATCH_API_URL ?? "http://127.0.0.1:8080",
        ws: true,
      },
    },
  },
}));
