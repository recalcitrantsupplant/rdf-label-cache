import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // wrangler.toml pins ENVIRONMENT=production (disables /dev/seed);
        // override to "test" so the suite can seed the local R2.
        bindings: { ENVIRONMENT: "test", PURGE_TOKEN: "test-token" },
      },
    }),
  ],
  test: {
    // Only the Worker's own suite runs under the Workers pool. The standalone
    // client library (packages/) ships its own `node:test` suite, run separately
    // via `node --test` in scripts/ci.sh; keep vitest from globbing it.
    include: ["test/**/*.test.ts"],
  },
});
