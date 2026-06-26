#!/usr/bin/env bash
# upstream substituter に既にある path を CACHE_DIR から除外する。詳細は docs/publish.md。
# usage: prune-upstream.sh <CACHE_DIR> [UPSTREAM_URL]
set -euo pipefail

cache_dir="${1:-}"
upstream="${2:-https://cache.nixos.org}"

if [ -z "$cache_dir" ]; then
  echo "usage: $0 <CACHE_DIR> [UPSTREAM_URL]" >&2
  exit 1
fi
if [ ! -d "$cache_dir" ]; then
  echo "[prune] CACHE_DIR not found: $cache_dir" >&2
  exit 1
fi

# trailing slash を取り除いて以降の URL 連結を安定化
upstream="${upstream%/}"

concurrency="${PRUNE_CONCURRENCY:-32}"
timeout="${PRUNE_TIMEOUT:-5}"

mapfile -t narinfos < <(find "$cache_dir" -maxdepth 1 -name '*.narinfo' -type f | sort)

before="${#narinfos[@]}"
if [ "$before" -eq 0 ]; then
  echo "[prune] no narinfo to check in $cache_dir"
  exit 0
fi

echo "[prune] checking $before narinfo against $upstream (concurrency=$concurrency, timeout=${timeout}s)"

export PRUNE_CACHE_DIR="$cache_dir"
export PRUNE_UPSTREAM="$upstream"
export PRUNE_TIMEOUT_SEC="$timeout"

# curl -f は 404 で exit 22 になり stdout を失うので使わず、http_code を文字列比較する。
prune_one() {
  local narinfo_file="$1"
  local hash status nar_rel
  hash="$(basename "$narinfo_file" .narinfo)"

  status="$(curl -sS -o /dev/null --head \
    --max-time "$PRUNE_TIMEOUT_SEC" \
    -w '%{http_code}' \
    "${PRUNE_UPSTREAM}/${hash}.narinfo" 2>/dev/null || echo "000")"

  if [ "$status" != "200" ]; then
    return 0
  fi

  nar_rel="$(awk -F': ' '/^URL:/ {print $2; exit}' "$narinfo_file" | tr -d '\r')"

  rm -f "$narinfo_file"
  if [ -n "$nar_rel" ]; then
    rm -f "${PRUNE_CACHE_DIR}/${nar_rel}"
  fi
  printf 'pruned %s\n' "$hash"
}
export -f prune_one

# bash -c は親の set を継承しないので子側で再宣言する。
pruned_count="$(
  printf '%s\n' "${narinfos[@]}" \
    | xargs -I{} -P "$concurrency" bash -c 'set -euo pipefail; prune_one "$@"' _ {} \
    | wc -l
)"

after=$(( before - pruned_count ))
echo "[prune] removed ${pruned_count}/${before} (kept ${after} to upload)"
