#!/usr/bin/env bash
# cf-edgeNix publish step (spec docs/spec.md §9)
#
# 公開順序を厳守する:
#   NAR本体(R2) → .narinfo(R2) → D1 で published/latest 確定 → KV warming(最後)
# .narinfo を先に公開すると、Nix client が存在しない NAR を取りに行って 404 になる。
#
# 必要な env:
#   HOST               対象 nixosConfiguration 名
#   CACHE_DIR          nix copy の出力先（file:// ローカル binary cache）
#   CACHE_PRIVATE_KEY  NAR 署名用 secret key（fork PR では絶対に露出させない・§9.1）
#   API_BASE_URL       Worker の URL
#   ADMIN_TOKEN        管理API Bearer トークン
#   R2_BUCKET_NAME     R2 バケット名
#   KV_NAMESPACE_ID    KV 名前空間 ID
set -euo pipefail

: "${HOST:?HOST is required}"
: "${CACHE_DIR:?CACHE_DIR is required}"
: "${CACHE_PRIVATE_KEY:?CACHE_PRIVATE_KEY is required}"

# ─── Phase 1: nix build + nix copy（署名付き binary cache 生成） ──────────────

# 1. NixOS system closure をビルド
out="$(nix build ".#nixosConfigurations.${HOST}.config.system.build.toplevel" \
  --print-out-paths --no-link)"

# 2. closure を列挙（復元用 manifest / build_closure の素材）
nix path-info -r --json "$out" > closure.json

# 3. 鍵を一時ファイルに書き出して nix copy に渡す（argv に秘密鍵を露出させない・G9）
#    trap で確実に削除し、パーミッション 600 を維持する。
_key_file="$(mktemp)"
chmod 600 "$_key_file"
# shellcheck disable=SC2064  # _key_file を展開時に確定させる（意図的）
trap "rm -f '$_key_file'" EXIT

printf '%s' "$CACHE_PRIVATE_KEY" > "$_key_file"

nix copy --to "file://${CACHE_DIR}?compression=zstd&secret-key=${_key_file}" "$out"

echo "build out path: $out"
echo "local binary cache generated at: ${CACHE_DIR}"

# ─── Phase 2: R2/D1/KV への反映（publish.ts に委譲・env 検証はここで行う） ───

: "${API_BASE_URL:?API_BASE_URL is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME is required}"
: "${KV_NAMESPACE_ID:?KV_NAMESPACE_ID is required}"

export HOST CACHE_DIR API_BASE_URL ADMIN_TOKEN R2_BUCKET_NAME KV_NAMESPACE_ID
export GIT_REV="${GIT_REV:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
export SYSTEM="${SYSTEM:-x86_64-linux}"
export FLAKE_LOCK_HASH="${FLAKE_LOCK_HASH:-unknown}"
# toplevel store path を closure.json から渡す
export TOPLEVEL_STORE_PATH="$out"

echo "Uploading to R2/D1/KV via scripts/publish.ts..."
bun "$(dirname "$0")/publish.ts"
echo "publish.ts complete"
