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
  stagedPaths: string[];
  zstdArgs: string[];
  cacheNarinfos: string[];
  cacheNarinfoContents: string[];
  nixCommands: string[];
  bunArgs: string[];
  plan: { version: number; selfNarinfoDir: string; targets: Array<{ host: string; system: string; closureStorePaths: string[]; externalStorePaths: Array<{storePath: string; substituterUrl: string}>; selfExistingStorePaths: string[]; newStorePaths: string[] }> };
  selfNarinfo: string | null;
  stdout: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cf-edgenix-publish-sh-"));
  const binDir = join(dir, "bin");
  const cacheDir = join(dir, "cache");
  const nixLog = join(dir, "staged-paths.log");
  const nixCommandsLog = join(dir, "nix-commands.log");
  const zstdLog = join(dir, "zstd-args.log");
  const bunLog = join(dir, "bun-args.log");
  const planLog = join(dir, "plan.json");
  const selfNarinfoLog = join(dir, "self-narinfo");
  await mkdir(binDir);
  await mkdir(cacheDir);
  await writeFile(nixLog, "");
  await writeFile(zstdLog, "");

  await writeExecutable(
    join(binDir, "nix"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$1" >> "$NIX_COMMANDS_LOG"
for arg in "\${@:2}"; do printf '\\t%s' "$arg" >> "$NIX_COMMANDS_LOG"; done
printf '\\n' >> "$NIX_COMMANDS_LOG"
case "$1" in
  store)
    [ "$2" = "sign" ] || exit 64
    cat > /dev/null
    ;;
  nar)
    [ "$2" = "dump-path" ] || exit 64
    printf '%s\\n' "$3" >> "$NIX_STUB_LOG"
    printf 'NAR for %s' "$3"
    ;;
  hash)
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
    ;;
  config)
    if [ "\${STUB_SELF_ALIAS:-0}" = "1" ]; then
      printf '{"substituters":{"value":["https://cache.example.com","https://self.example.com","https://upstream.example.com"]}}\\n'
    else
      printf '{"substituters":{"value":["https://cache.example.com","https://upstream.example.com"]}}\\n'
    fi
    ;;
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
    if [[ "$*" == *"--sigs"* ]]; then
      printf '{'
      first=1
      while IFS= read -r store_path; do
        if [ "$first" = 0 ]; then printf ','; fi
        first=0
        printf '"%s":{"narHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","narSize":10,"references":[],"deriver":null,"ca":"fixed:r:sha256:cccc","signatures":["test-key-1:signature"]}' "$store_path"
      done
      printf '}\\n'
      exit 0
    fi
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
source_dir="$(jq -r '.selfNarinfoDir' "$3")"
if [ -d "$source_dir" ]; then cp "$source_dir"/*.narinfo "$SELF_NARINFO_LOG" 2>/dev/null || true; fi
`,
  );

  await writeExecutable(
    join(binDir, "zstd"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$ZSTD_ARGS_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; cat > "$1"; exit 0; fi
  shift
done
exit 64
`,
  );

  await writeExecutable(
    join(binDir, "curl"),
    `#!/usr/bin/env bash
url="\${*: -1}"
hash="\${url##*/}"
hash="\${hash%.narinfo}"
head=0
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --head) head=1 ;;
    -o) shift; out="$1" ;;
  esac
  shift
done
status=404
if [[ "$url" == https://upstream.example.com/* ]]; then
  if [ "\${UPSTREAM_ALL_HIT:-0}" = "1" ] || [ "$hash" = "\${UPSTREAM_HIT_HASH:-}" ]; then status=200; fi
elif [[ "$url" == https://cache.example.com/* || "$url" == https://self.example.com/* ]]; then
  if [ "$hash" = "\${SELF_HIT_HASH:-}" ]; then status=200; fi
  if [ "\${SELF_TRANSIENT_ERROR:-0}" = "1" ]; then exit 28; fi
  if [ "$status" = 200 ] && [ "$head" = 0 ]; then
    if [ "\${SELF_MISMATCH:-0}" = "1" ]; then
      printf 'StorePath: /nix/store/wrong0000000000-package\\n' > "$out"
    else
      printf 'StorePath: /nix/store/%s-shared\\nURL: nar/example.nar.zst\\nCompression: zstd\\nFileHash: sha256:aaaaaaaa\\nFileSize: 3\\nNarHash: sha256:bbbbbbbb\\nNarSize: 10\\n' "$hash" > "$out"
    fi
  fi
fi
printf '%s' "$status"
`,
  );

  const result = await execFileAsync("bash", [scriptPath, ...hosts], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      HOST: "test-host",
      CACHE_DIR: cacheDir,
      CACHE_PRIVATE_KEY: "test-key-1:secret",
      API_BASE_URL: "https://cache.example.com",
      ADMIN_TOKEN: "test-token",
      R2_BUCKET_NAME: "test-bucket",
      KV_NAMESPACE_ID: "test-kv",
      GIT_REV: "deadbeef",
      SYSTEM: "x86_64-linux",
      FLAKE_LOCK_HASH: "sha256:lock",
      NIX_STUB_LOG: nixLog,
      NIX_COMMANDS_LOG: nixCommandsLog,
      ZSTD_ARGS_LOG: zstdLog,
      BUN_STUB_LOG: bunLog,
      PLAN_LOG: planLog,
      SELF_NARINFO_LOG: selfNarinfoLog,
      ...env,
    },
  });

  const cacheNarinfos = (await readdir(cacheDir)).filter((name) => name.endsWith(".narinfo")).sort();
  return {
    stagedPaths: (await readFile(nixLog, "utf8")).trim().split("\n").filter(Boolean),
    zstdArgs: (await readFile(zstdLog, "utf8")).trim().split("\n"),
    cacheNarinfos,
    cacheNarinfoContents: await Promise.all(cacheNarinfos.map((name) => readFile(join(cacheDir, name), "utf8"))),
    nixCommands: (await readFile(nixCommandsLog, "utf8")).trim().split("\n"),
    bunArgs: (await readFile(bunLog, "utf8")).trim().split("\n"),
    plan: JSON.parse(await readFile(planLog, "utf8")),
    selfNarinfo: (await readdir(dir)).includes("self-narinfo") ? await readFile(selfNarinfoLog, "utf8") : null,
    stdout: result.stdout,
  };
}

describe("scripts/publish.sh", () => {
  test("ZSTD_LEVEL 未指定時は level 9 を使う", async () => {
    const { zstdArgs } = await runPublishSh({});
    expect(zstdArgs).toContain("-9");
  });

  test("ZSTD_LEVEL=-1 は zstd の既定 level を使う", async () => {
    const { zstdArgs } = await runPublishSh({ ZSTD_LEVEL: "-1" });
    expect(zstdArgs).not.toContain("--1");
    expect(zstdArgs).toContain("-q");
  });

  test("new pathだけを参照先なしでNAR化する", async () => {
    const { stagedPaths, plan, nixCommands, cacheNarinfoContents } = await runPublishSh({ ZSTD_LEVEL: "9" });
    expect(stagedPaths).toEqual(plan.targets[0]?.newStorePaths);
    expect(nixCommands.some((line) => line.startsWith("copy\t"))).toBe(false);
    expect(plan.targets[0]?.closureStorePaths).toHaveLength(2);
    expect(cacheNarinfoContents[0]).toMatch(/^URL: nar\/[0-9a-z]+\.nar\.zst$/m);
    expect(cacheNarinfoContents[0]).toContain("CA: fixed:r:sha256:cccc");
  });

  test("主要phaseの所要時間をログへ出す", async () => {
    const { stdout } = await runPublishSh({});
    expect(stdout).toMatch(/\[timing\] build=\d+s/);
    expect(stdout).toMatch(/\[timing\] closure-metadata=\d+s/);
    expect(stdout).toMatch(/\[timing\] stage=\d+s/);
    expect(stdout).toMatch(/\[timing\] availability=\d+s/);
    expect(stdout).toMatch(/\[timing\] publish=\d+s/);
    expect(stdout).toMatch(/\[timing\] total=\d+s/);
  });

  test("ZSTD_LEVEL が整数でない場合は失敗する", async () => {
    await expect(runPublishSh({ ZSTD_LEVEL: "fast" })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("ZSTD_LEVEL must be an integer"),
    });
  });

  test("2ホストをbuild/sign/publish各1回で処理する", async () => {
    const result = await runPublishSh({ HOST: "" }, ["laptop", "desktop"]);
    expect(result.nixCommands.filter((line) => line.startsWith("build\t"))).toHaveLength(1);
    expect(result.nixCommands.filter((line) => line.startsWith("store\tsign"))).toHaveLength(1);
    expect(result.nixCommands.find((line) => line.startsWith("build\t"))).toContain("laptop");
    expect(result.nixCommands.find((line) => line.startsWith("build\t"))).toContain("desktop");
    expect(result.stagedPaths).toContain("/nix/store/laptop000000000-system");
    expect(result.stagedPaths).toContain("/nix/store/desktop000000000-system");
    expect(result.bunArgs[1]).toBe("--plan");
    expect(result.plan.targets).toHaveLength(2);
    expect(JSON.stringify(result.plan)).not.toContain("test-key-1:secret");
  });

  test("upstream保有pathを圧縮前に除外する", async () => {
    const result = await runPublishSh(
      {
        HOST: "",
        UPSTREAM_HIT_HASH: "shared0000000000",
      },
      ["laptop", "desktop"],
    );
    expect(result.stagedPaths).toContain("/nix/store/desktop000000000-system");
    expect(result.stagedPaths).toContain("/nix/store/laptop000000000-system");
    expect(result.stagedPaths).not.toContain("/nix/store/shared0000000000-shared");
    expect(result.plan.targets[0]?.externalStorePaths).toEqual([{storePath: "/nix/store/shared0000000000-shared", substituterUrl: "https://upstream.example.com"}]);
    expect(result.cacheNarinfos).not.toContain("shared0000000000.narinfo");
    expect(result.cacheNarinfos).toContain("desktop000000000.narinfo");
    expect(result.cacheNarinfos).toContain("laptop000000000.narinfo");
  });

  test("self既存narinfoを別dirに保存してplanへ分類する", async () => {
    const result = await runPublishSh({ SELF_HIT_HASH: "shared0000000000" });
    expect(result.plan.version).toBe(2);
    expect(result.plan.selfNarinfoDir).toBeTruthy();
    expect(result.plan.targets[0]?.selfExistingStorePaths).toEqual(["/nix/store/shared0000000000-shared"]);
    expect(result.plan.targets[0]?.newStorePaths).toEqual(["/nix/store/abcdef123456aaaa-system"]);
    expect(result.stagedPaths).not.toContain("/nix/store/shared0000000000-shared");
    expect(result.selfNarinfo).toContain("StorePath: /nix/store/shared0000000000-shared");
  });

  test("SELF_CACHE_URL の別名はexternalでなくselfとして照会する", async () => {
    const result = await runPublishSh({
      STUB_SELF_ALIAS: "1",
      SELF_CACHE_URL: "https://self.example.com",
      SELF_HIT_HASH: "shared0000000000",
    });
    expect(result.plan.targets[0]?.externalStorePaths).toEqual([]);
    expect(result.plan.targets[0]?.selfExistingStorePaths).toEqual(["/nix/store/shared0000000000-shared"]);
  });

  test("selfのStorePath不一致はnew扱いにする", async () => {
    const result = await runPublishSh({ SELF_HIT_HASH: "shared0000000000", SELF_MISMATCH: "1" });
    expect(result.plan.targets[0]?.selfExistingStorePaths).toEqual([]);
    expect(result.stagedPaths).toContain("/nix/store/shared0000000000-shared");
    expect(result.selfNarinfo).toBeNull();
  });

  test("selfの一時的な通信失敗はnew扱いにする", async () => {
    const result = await runPublishSh({ SELF_HIT_HASH: "shared0000000000", SELF_TRANSIENT_ERROR: "1" });
    expect(result.plan.targets[0]?.newStorePaths).toContain("/nix/store/shared0000000000-shared");
    expect(result.stagedPaths).toContain("/nix/store/shared0000000000-shared");
  });

  test("全pathがupstreamにあるとstagingを省略する", async () => {
    const result = await runPublishSh({
      UPSTREAM_ALL_HIT: "1",
    });

    expect(result.nixCommands.filter((line) => line.startsWith("store\tsign"))).toHaveLength(0);
    expect(result.cacheNarinfos).toEqual([]);
    expect(result.bunArgs[1]).toBe("--plan");
    expect(result.plan.targets[0]?.newStorePaths).toEqual([]);
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
    const result = await runPublishSh({ CLOSURE_PATH_COUNT: "3000", UPSTREAM_ALL_HIT: "1" });
    expect(result.plan.targets[0]?.closureStorePaths).toHaveLength(3001);
    expect(result.nixCommands.filter((line) => line.startsWith("store\tsign"))).toHaveLength(0);
    expect(result.plan.targets[0]?.externalStorePaths).toHaveLength(3001);
  }, 120_000);

  test("位置引数とHOSTの同時指定、重複、不正名を拒否する", async () => {
    await expect(runPublishSh({}, ["laptop"])).rejects.toMatchObject({ code: 2 });
    await expect(runPublishSh({ HOST: "" }, ["laptop", "laptop"])).rejects.toMatchObject({ code: 2 });
    await expect(runPublishSh({ HOST: "" }, ["../laptop"])).rejects.toMatchObject({ code: 2 });
  });
});
