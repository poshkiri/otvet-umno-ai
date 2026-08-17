import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
