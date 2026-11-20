// The build for the public address: `site.html`, the one page of the demo (the allocator on invented
// markets, then the vault), and `vault.html`, the vault alone. The dev server's feed route is not in it. On
// the public address step one asks the shared reader (`services/screen`) through `/feed/*`, and
// makes invented markets in the browser where that has nothing yet.
// Run from web/ with the five VITE_VAULT_* settings in the environment (see the runbook, kept outside this repository):
//   npx vite build -c vite.public.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-public", emptyOutDir: true, rollupOptions: { input: ["site.html", "vault.html"] } },
});
