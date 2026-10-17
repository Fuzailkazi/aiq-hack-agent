import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live tests call real Gemini/OpenAI/Jev and need keys: run them with `npm run test:live`.
    // The web UI has its own Vitest setup (jsdom): `npm run web:test`.
    // Only our own tests: workspace/ holds cloned team repos, whose code must never run here.
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "web/**",
      "workspace/**",
      ...(process.env.LIVE ? [] : ["tests/live/**"]),
    ],
    testTimeout: 60_000,
    pool: "forks",
  },
});
