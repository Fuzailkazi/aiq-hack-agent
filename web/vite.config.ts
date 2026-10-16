import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The ArmorIQ design system is vendored in ./design-system; its primitives import each other as @shared/*.
const shared = fileURLToPath(new URL("./design-system/primitives", import.meta.url));

// `npm run dev` proxies /api to `hackeval serve` on :8000; the production build is served by Fastify itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@shared": shared } },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  // The primitives have no import side effects (checked: no bare/CSS imports), so unused ones — e.g. the
  // React Flow graph node exported by the barrel — are dropped from the bundle.
  build: {
    rolldownOptions: {
      treeshake: { moduleSideEffects: (id: string) => !id.includes("/design-system/primitives/") },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], css: false },
});
