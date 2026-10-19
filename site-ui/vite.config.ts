import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: at("."),
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@api": at("../plugins/warden/src/site/api-types.ts"), "@": at("./src") } },
  build: {
    outDir: at("../plugins/warden/site-dist"), emptyOutDir: true, assetsDir: "assets",
    sourcemap: false, chunkSizeWarningLimit: 1500,
  },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: { "/api": { target: process.env.WARDEN_SITE_URL ?? "http://127.0.0.1:4400", changeOrigin: true } },
  },
});
