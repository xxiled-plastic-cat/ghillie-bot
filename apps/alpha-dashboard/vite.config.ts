import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number.parseInt(process.env.ALPHA_DASHBOARD_PORT || "8787", 10);
const apiHost = process.env.ALPHA_DASHBOARD_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number.parseInt(process.env.ALPHA_DASHBOARD_WEB_PORT || "5174", 10),
    proxy: {
      "/api": {
        target: `http://${apiHost}:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
