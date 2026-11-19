// The build of the phone pages alone, for the public address: `vault.html` and nothing else. The
// operator's screen and its feed route are not in it, so nothing of Gemini's can be in what is served.
// Run from web/ with the five VITE_VAULT_* settings in the environment (see the runbook, kept outside this repository):
//   npx vite build -c vite.public.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-public", emptyOutDir: true, rollupOptions: { input: "vault.html" } },
});
