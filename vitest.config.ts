import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // wrangler.toml pins ENVIRONMENT=production (disables /dev/seed);
        // override to "test" so the suite can seed the local R2.
        bindings: { ENVIRONMENT: "test" },
      },
    }),
  ],
});
