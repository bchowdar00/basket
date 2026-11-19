import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { feedRoute } from "./feed/route.ts";

// Component tests render to markup with react-dom/server, so they need no browser.
export default defineConfig({
  plugins: [react(), feedRoute()],
  server: { host: "127.0.0.1" },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "feed/**/*.test.ts"] },
});
