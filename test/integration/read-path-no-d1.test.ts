/// <reference types="node" />
/**
 * test/integration/read-path-no-d1.test.ts
 *
 * read path handlers が db/client や db/queries を import しないことを検証する回帰テスト（G10/B5/D4）。
 * ソースファイルを grep して import 文の存在を確認する（import graph 静的解析）。
 *
 * この種のテストは pool-workers が不要なため unit project で実行する（node:fs を使用）。
 * 受入条件: B5/D4/G10
 */
import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

// Vite/vitest では import.meta.url が使えるが Workers 型では url プロパティが undefined の場合がある。
// Node.js 環境（unit project）では __dirname 等が使えないため、CWD ベースでパス解決する。
const SRC_ROOT = path.resolve(process.cwd(), "src");

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relPath), "utf-8");
}

/**
 * 指定ファイルが db/client または db/queries を直接 import しているかを判定する。
 * - "from ... db/client" や "from ... db/queries" の形式を検索する。
 * - 相対 import (`../db/client`, `../../db/client` etc.) もチェック。
 */
function importsD1(source: string): boolean {
  // import 文のパターン（static import と dynamic import の両方）
  const patterns = [
    /from\s+["'].*\/db\/client["']/,
    /from\s+["'].*\/db\/queries["']/,
    /import\s*\(\s*["'].*\/db\/client["']\s*\)/,
    /import\s*\(\s*["'].*\/db\/queries["']\s*\)/,
    // 相対 import（handlers/ は src/ 直下にある）
    /from\s+["']\.\.?\/db\/client["']/,
    /from\s+["']\.\.?\/db\/queries["']/,
  ];
  return patterns.some((p) => p.test(source));
}

// ─── read path handlers の D1 非参照確認 ─────────────────────────────────────

describe("read path handlers: D1 非参照（G10/B5/D4）", () => {
  test("handlers/nar.ts が db/client を import しない", () => {
    const src = readSource("handlers/nar.ts");
    expect(importsD1(src)).toBe(false);
  });

  test("handlers/narinfo.ts が db/client を import しない", () => {
    const src = readSource("handlers/narinfo.ts");
    expect(importsD1(src)).toBe(false);
  });

  test("handlers/cacheInfo.ts が db/client を import しない", () => {
    const src = readSource("handlers/cacheInfo.ts");
    expect(importsD1(src)).toBe(false);
  });

  test("handlers/nar.ts が db/queries を import しない", () => {
    const src = readSource("handlers/nar.ts");
    expect(importsD1(src)).toBe(false);
  });

  test("handlers/narinfo.ts が db/queries を import しない", () => {
    const src = readSource("handlers/narinfo.ts");
    expect(importsD1(src)).toBe(false);
  });

  test("handlers/cacheInfo.ts が db/queries を import しない", () => {
    const src = readSource("handlers/cacheInfo.ts");
    expect(importsD1(src)).toBe(false);
  });
});

// ─── read path handlers: D1 文字列が一切含まれないことを確認 ─────────────────

describe("read path handlers: D1 関連シンボルが含まれない", () => {
  const d1Keywords = ["drizzle", "CONTROL_DB", "getDb", "Drizzle"];

  for (const handler of ["handlers/nar.ts", "handlers/narinfo.ts", "handlers/cacheInfo.ts"]) {
    for (const keyword of d1Keywords) {
      test(`${handler} に "${keyword}" が含まれない`, () => {
        const src = readSource(handler);
        expect(src).not.toContain(keyword);
      });
    }
  }
});

// ─── read path handlers: 依存する storage 層のみを import することを確認 ──────

describe("read path handlers: 許可された依存のみ使用", () => {
  test("handlers/nar.ts は storage/r2、storage/keys、cache/memory、types のみに依存する", () => {
    const src = readSource("handlers/nar.ts");

    // 許可された import（cache/memory は NAR size の L0 キャッシュ用）
    const allowedPatterns = [
      /from\s+["'].*\/types["']/,
      /from\s+["'].*\/storage\/r2["']/,
      /from\s+["'].*\/storage\/keys["']/,
      /from\s+["'].*\/cache\/memory["']/,
    ];

    // 全 import 文を抽出
    const importLines = src
      .split("\n")
      .filter((line) => line.trim().startsWith("import"));

    for (const line of importLines) {
      const isAllowed = allowedPatterns.some((p) => p.test(line));
      if (!isAllowed) {
        // import 文の from パスを抽出して確認
        const match = line.match(/from\s+["']([^"']+)["']/);
        if (match) {
          const importPath = match[1] ?? "";
          // node: プレフィクス（node:fs 等）、相対でないものは許可
          const isRelative = importPath.startsWith(".");
          if (isRelative) {
            // 相対 import はすべて許可リストと照合
            expect(importPath).toMatch(/\/(types|storage\/(r2|keys)|cache\/memory)/);
          }
        }
      }
    }
  });

  test("handlers/narinfo.ts は storage と cache 層のみに依存する", () => {
    const src = readSource("handlers/narinfo.ts");
    // D1 参照がないことが主要な確認
    expect(importsD1(src)).toBe(false);
    // db/ への参照がない
    expect(src).not.toMatch(/from\s+["'].*\/db\//);
  });

  test("handlers/cacheInfo.ts は storage と cache 層のみに依存する", () => {
    const src = readSource("handlers/cacheInfo.ts");
    expect(importsD1(src)).toBe(false);
    expect(src).not.toMatch(/from\s+["'].*\/db\//);
  });
});

// ─── index.ts: /api/* のみ hono 委譲で read path は既存維持（F2） ────────────

describe("index.ts: read path と API path の分離（F2）", () => {
  test("index.ts が /api/ で apiApp へ委譲している", () => {
    const src = readSource("index.ts");
    expect(src).toMatch(/startsWith\s*\(\s*["']\/api\/["']\s*\)/);
    expect(src).toMatch(/apiApp\.fetch/);
  });

  test("index.ts は read path handlers を維持している", () => {
    const src = readSource("index.ts");
    expect(src).toContain("handleCacheInfo");
    expect(src).toContain("handleNarinfo");
    expect(src).toContain("handleNar");
  });
});
