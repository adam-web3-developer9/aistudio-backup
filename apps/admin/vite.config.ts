import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.ADMIN_API_TARGET || "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
