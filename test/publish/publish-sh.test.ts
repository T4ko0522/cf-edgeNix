import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

async function runPublishSh(
  env: Record<string, string>,
  hosts: string[] = [],
): Promise<{
  copyArgs: string[];
  copyStdin: string[];
  cacheNarinfos: string[];
  nixCommands: string[];
  bunArgs: string[];
  plan: { targets: Array<{ host: string; system: string; closureStorePaths: string[] }> };
  stdout: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cf-edgenix-publish-sh-"));
  const binDir = join(dir, "bin");
  const cacheDir = join(dir, "cache");
  const nixLog = join(dir, "nix-args.log");
  const nixCommandsLog = join(dir, "nix-commands.log");
  const nixStdinLog = join(dir, "nix-stdin.log");
  const bunLog = join(dir, "bun-args.log");
  const planLog = join(dir, "plan.json");
  await mkdir(binDir);
  await mkdir(cacheDir);
  await writeFile(nixLog, "");
  await writeFile(nixStdinLog, "");

  await writeExecutable(
    join(binDir, "nix"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$1" >> "$NIX_COMMANDS_LOG"
for arg in "\${@:2}"; do printf '\\t%s' "$arg" >> "$NIX_COMMANDS_LOG"; done
printf '\\n' >> "$NIX_COMMANDS_LOG"
case "$1" in
  build)
    ;;
  eval)
    case "$3" in
      *laptop*pkgs.system*) echo "x86_64-linux" ;;
      *desktop*pkgs.system*) echo "aarch64-linux" ;;
      *laptop*) echo "/nix/store/laptop000000000-system" ;;
      *desktop*) echo "/nix/store/desktop000000000-system" ;;
      *) echo "/nix/store/abcdef123456aaaa-system" ;;
    esac
    ;;
  path-info)
    out="\${@: -1}"
    if [ -n "\${CLOSURE_PATH_COUNT:-}" ]; then
      printf '{'
      for ((i = 0; i < CLOSURE_PATH_COUNT; i++)); do
        if [ "$i" -gt 0 ]; then printf ','; fi
        printf '"/nix/store/%032d-package-%05d":{}' "$i" "$i"
      done
      printf ',"%s":{}}\\n' "$out"
    else
      printf '{"/nix/store/shared0000000000-shared":{},"%s":{}}\\n' "$out"
    fi
    ;;
  copy)
    : > "$NIX_STUB_LOG"
    for arg in "$@"; do printf '%s\\n' "$arg" >> "$NIX_STUB_LOG"; done
    cat > "$NIX_STDIN_LOG"
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
cp "$3" "$PLAN_LOG"
`,
  );

  await writeExecutable(
    join(binDir, "curl"),
    `#!/usr/bin/env bash
output="/dev/null"
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[$i]}" = "-o" ]; then output="\${args[$((i + 1))]}"; fi
done
url="\${args[-1]}"
if [ -n "\${SELF_CACHE_HIT_HASH:-}" ] && [[ "$url" == "https://cache.example.com/$SELF_CACHE_HIT_HASH.narinfo" ]]; then
  cat > "$output" <<EOF
StorePath: /nix/store/\${SELF_CACHE_STORE_HASH:-$SELF_CACHE_HIT_HASH}-shared
URL: nar/shared.nar.zst
Compression: zstd
FileHash: sha256:shared
FileSize: 10
NarHash: sha256:sharednar
NarSize: 20
EOF
  printf '200'
  exit 0
fi
if [ "\${UPSTREAM_ALL_HIT:-0}" = "1" ] || { [ -n "\${UPSTREAM_HIT_HASH:-}" ] && [[ "\${*: -1}" == *"/$UPSTREAM_HIT_HASH.narinfo" ]]; }; then
  printf '200'
else
  printf '404'
fi
`,
  );

  const result = await execFileAsync("bash", [scriptPath, ...hosts], {
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
      SKIP_SELF_CACHE_REUSE: "1",
      NIX_STUB_LOG: nixLog,
      NIX_COMMANDS_LOG: nixCommandsLog,
      NIX_STDIN_LOG: nixStdinLog,
      BUN_STUB_LOG: bunLog,
      PLAN_LOG: planLog,
      ...env,
    },
  });

  return {
    copyArgs: (await readFile(nixLog, "utf8")).trim().split("\n"),
    copyStdin: (await readFile(nixStdinLog, "utf8")).trim().split("\n").filter(Boolean),
    cacheNarinfos: (await readdir(cacheDir)).filter((name) => name.endsWith(".narinfo")).sort(),
    nixCommands: (await readFile(nixCommandsLog, "utf8")).trim().split("\n"),
    bunArgs: (await readFile(bunLog, "utf8")).trim().split("\n"),
    plan: JSON.parse(await readFile(planLog, "utf8")) as {
      targets: Array<{ host: string; system: string; closureStorePaths: string[] }>;
    },
    stdout: result.stdout,
  };
}

describe("scripts/publish.sh", () => {
  test("ZSTD_LEVEL 未指定時は compression-level=9 を使う", async () => {
    const { copyArgs } = await runPublishSh({});
    expect(copyArgs[2]).toContain("?compression=zstd&compression-level=9&secret-key=");
  });

  test("nix copy の file URL に zstd の compression-level を含める", async () => {
    const { copyArgs } = await runPublishSh({ ZSTD_LEVEL: "9" });
    expect(copyArgs[0]).toBe("copy");
    expect(copyArgs[1]).toBe("--to");
    expect(copyArgs[2]).toContain("?compression=zstd&compression-level=9&secret-key=");
    expect(copyArgs).toContain("--no-recursive");
    expect(copyArgs).toContain("--stdin");
  });

  test("主要phaseの所要時間をログへ出す", async () => {
    const { stdout } = await runPublishSh({});
    expect(stdout).toMatch(/\[timing\] build=\d+s/);
    expect(stdout).toMatch(/\[timing\] closure-metadata=\d+s/);
    expect(stdout).toMatch(/\[timing\] upstream-preflight=\d+s/);
    expect(stdout).toMatch(/\[timing\] self-cache-preflight=\d+s/);
    expect(stdout).toMatch(/\[timing\] copy=\d+s/);
    expect(stdout).toMatch(/\[timing\] publish=\d+s/);
    expect(stdout).toMatch(/\[timing\] total=\d+s/);
  });

  test("ZSTD_LEVEL が整数でない場合は失敗する", async () => {
    await expect(runPublishSh({ ZSTD_LEVEL: "fast" })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("ZSTD_LEVEL must be an integer"),
    });
  });

  test("2ホストをbuild/copy/publish各1回で処理する", async () => {
    const result = await runPublishSh({ HOST: "" }, ["laptop", "desktop"]);
    expect(result.nixCommands.filter((line) => line.startsWith("build\t"))).toHaveLength(1);
    expect(result.nixCommands.filter((line) => line.startsWith("copy\t"))).toHaveLength(1);
    expect(result.nixCommands.find((line) => line.startsWith("build\t"))).toContain("laptop");
    expect(result.nixCommands.find((line) => line.startsWith("build\t"))).toContain("desktop");
    expect(result.copyStdin).toContain("/nix/store/laptop000000000-system");
    expect(result.copyStdin).toContain("/nix/store/desktop000000000-system");
    expect(result.bunArgs[1]).toBe("--plan");
    expect(result.plan.targets).toHaveLength(2);
    expect(JSON.stringify(result.plan)).not.toContain("test-private-key");
  });

  test("upstream保有pathを圧縮前に除外し、未保有pathだけをcopyする", async () => {
    const result = await runPublishSh(
      {
        HOST: "",
        SKIP_UPSTREAM_PRUNE: "0",
        SKIP_SELF_CACHE_REUSE: "0",
        UPSTREAM_HIT_HASH: "shared0000000000",
      },
      ["laptop", "desktop"],
    );
    expect(result.copyStdin).not.toContain("/nix/store/shared0000000000-shared");
    expect(result.copyStdin).toEqual([
      "/nix/store/desktop000000000-system",
      "/nix/store/laptop000000000-system",
    ]);
    expect(result.stdout).toContain("[preflight] upstream owns 1/3; self candidates 2");
    expect(result.stdout).toContain("[preflight] self cache reuses 0/2; copying 2");
  });

  test("全pathがupstreamにあればcopyを省略してpublishを続行する", async () => {
    const result = await runPublishSh({
      SKIP_UPSTREAM_PRUNE: "0",
      UPSTREAM_ALL_HIT: "1",
    });

    expect(result.nixCommands.filter((line) => line.startsWith("copy\t"))).toHaveLength(0);
    expect(result.bunArgs[1]).toBe("--plan");
    expect(result.stdout).toContain("[copy] no self-hosted paths to copy");
  });

  test("self cache保有pathはnarinfoを再利用してcopy対象から外す", async () => {
    const result = await runPublishSh({
      SKIP_UPSTREAM_PRUNE: "0",
      SKIP_SELF_CACHE_REUSE: "0",
      SELF_CACHE_HIT_HASH: "shared0000000000",
    });

    expect(result.copyStdin).not.toContain("/nix/store/shared0000000000-shared");
    expect(result.cacheNarinfos).toContain("shared0000000000.narinfo");
    expect(result.stdout).toContain("[preflight] self cache reuses 1/2; copying 1");
  });

  test("self cacheのnarinfoがstore pathと一致しなければcopyへフォールバックする", async () => {
    const result = await runPublishSh({
      SKIP_UPSTREAM_PRUNE: "0",
      SKIP_SELF_CACHE_REUSE: "0",
      SELF_CACHE_HIT_HASH: "shared0000000000",
      SELF_CACHE_STORE_HASH: "different00000000",
    });

    expect(result.copyStdin).toContain("/nix/store/shared0000000000-shared");
    expect(result.cacheNarinfos).not.toContain("shared0000000000.narinfo");
    expect(result.stdout).toContain("[preflight] self cache reuses 0/2; copying 2");
  });

  test("各hostのsystemをflake属性から個別に取得する", async () => {
    const result = await runPublishSh(
      { HOST: "", SYSTEM: "" },
      ["laptop", "desktop"],
    );
    expect(result.plan.targets.map(({ host, system }) => ({ host, system }))).toEqual([
      { host: "laptop", system: "x86_64-linux" },
      { host: "desktop", system: "aarch64-linux" },
    ]);
  });

  test("巨大なclosureをコマンドライン引数にせずplanへ格納する", async () => {
    const result = await runPublishSh({ CLOSURE_PATH_COUNT: "3000" });
    expect(result.plan.targets[0]?.closureStorePaths).toHaveLength(3001);
  });

  test("位置引数とHOSTの同時指定、重複、不正名を拒否する", async () => {
    await expect(runPublishSh({}, ["laptop"])).rejects.toMatchObject({ code: 2 });
    await expect(runPublishSh({ HOST: "" }, ["laptop", "laptop"])).rejects.toMatchObject({ code: 2 });
    await expect(runPublishSh({ HOST: "" }, ["../laptop"])).rejects.toMatchObject({ code: 2 });
  });
});
