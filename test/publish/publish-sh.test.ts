import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repoRoot, "scripts/publish.sh");

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o755 });
}

async function runPublishSh(env: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "cf-edgenix-publish-sh-"));
  const binDir = join(dir, "bin");
  const cacheDir = join(dir, "cache");
  const nixLog = join(dir, "nix-args.log");
  const bunLog = join(dir, "bun-args.log");
  await mkdir(binDir);
  await mkdir(cacheDir);

  await writeExecutable(
    join(binDir, "nix"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  build)
    echo "/nix/store/abcdef123456aaaa-system"
    ;;
  path-info)
    echo '{"paths":["/nix/store/abcdef123456aaaa-system"]}'
    ;;
  copy)
    : > "$NIX_STUB_LOG"
    for arg in "$@"; do
      printf '%s\\n' "$arg" >> "$NIX_STUB_LOG"
    done
    mkdir -p "$CACHE_DIR/nar"
    printf 'nar' > "$CACHE_DIR/nar/sha256:file001.nar.zst"
    cat > "$CACHE_DIR/abcdef123456aaaa.narinfo" <<'EOF'
StorePath: /nix/store/abcdef123456aaaa-system
URL: nar/sha256:file001.nar.zst
Compression: zstd
FileHash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FileSize: 3
NarHash: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
NarSize: 10
EOF
    ;;
  *)
    echo "unexpected nix command: $*" >&2
    exit 64
    ;;
esac
`,
  );

  await writeExecutable(
    join(binDir, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$BUN_STUB_LOG"
`,
  );

  await execFileAsync("bash", [scriptPath], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      HOST: "test-host",
      CACHE_DIR: cacheDir,
      CACHE_PRIVATE_KEY: "test-private-key",
      API_BASE_URL: "https://cache.example.com",
      ADMIN_TOKEN: "test-token",
      R2_BUCKET_NAME: "test-bucket",
      KV_NAMESPACE_ID: "test-kv",
      GIT_REV: "deadbeef",
      SYSTEM: "x86_64-linux",
      FLAKE_LOCK_HASH: "sha256:lock",
      SKIP_UPSTREAM_PRUNE: "1",
      NIX_STUB_LOG: nixLog,
      BUN_STUB_LOG: bunLog,
      ...env,
    },
  });

  return (await readFile(nixLog, "utf8")).trim().split("\n");
}

describe("scripts/publish.sh", () => {
  test("ZSTD_LEVEL 未指定時は compression-level=9 を使う", async () => {
    const args = await runPublishSh({});

    expect(args[2]).toContain("?compression=zstd&compression-level=9&secret-key=");
  });

  test("nix copy の file URL に zstd の compression-level を含める", async () => {
    const args = await runPublishSh({ ZSTD_LEVEL: "9" });

    expect(args[0]).toBe("copy");
    expect(args[1]).toBe("--to");
    expect(args[2]).toContain("?compression=zstd&compression-level=9&secret-key=");
  });

  test("ZSTD_LEVEL が整数でない場合は失敗する", async () => {
    await expect(runPublishSh({ ZSTD_LEVEL: "fast" })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("ZSTD_LEVEL must be an integer"),
    });
  });
});
