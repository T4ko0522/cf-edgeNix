import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "test/auth.test.ts",
            "test/router.test.ts",
            "test/nar/range.test.ts",
            "test/publish/transform.test.ts",
            "test/api.routing.test.ts",
            "test/quota/evaluate.test.ts",
            "test/quota/guard.test.ts",
            "test/quota/state.test.ts",
            "test/quota/analytics.test.ts",
            // test/db/queries.test.ts は統合テストへ移行（偽陽性解消）
            "test/schemas/params.test.ts",
            "test/schemas/publish.test.ts",
            // read path D1 非参照の静的 grep テスト（G10/B5）: node:fs を使うため unit
            "test/integration/read-path-no-d1.test.ts",
          // G4/G5/G9: scripts/publish.ts のロジック unit テスト
            "test/publish/publish-script.test.ts",
            "test/publish/publish-sh.test.ts",
          ],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: {
              d1Databases: ["CONTROL_DB"],
              r2Buckets: ["NAR_BUCKET"],
              kvNamespaces: ["META_KV"],
            },
          }),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          exclude: [
            // read-path-no-d1 は node:fs を使うため unit project で実行
            "test/integration/read-path-no-d1.test.ts",
          ],
        },
      },
    ],
  },
});
