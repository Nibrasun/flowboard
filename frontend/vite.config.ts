import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8434",
      "/media": "http://127.0.0.1:8434",
      "/ws": {
        target: "ws://127.0.0.1:8434",
        ws: true,
      },
    },
  },
});
