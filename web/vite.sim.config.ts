// The build of the operator's screen on invented markets, for the public address under /screen/.
// The markets are made in the browser (`src/sim/markets.ts`); the feed route is not in this build
// and nothing is asked of any exchange, so nothing of Gemini's can be in what is served.
// Run from web/ after the phone page's build, which empties dist-public first:
//   npx vite build -c vite.public.config.ts && npx vite build -c vite.sim.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/screen/",
  plugins: [react()],
  define: { "import.meta.env.VITE_BASKET_SIM": JSON.stringify("1") },
  build: { outDir: "dist-public/screen", emptyOutDir: true, rollupOptions: { input: "index.html" } },
});
