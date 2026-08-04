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

export PRUNE_UPSTREAM="$upstream"
export PRUNE_TIMEOUT_SEC="$timeout"

prune_one() {
  local narinfo_file="$1"
  local hash status
  hash="$(basename "$narinfo_file" .narinfo)"

  status="$(curl -sS -o /dev/null --head \
    --max-time "$PRUNE_TIMEOUT_SEC" \
    -w '%{http_code}' \
    "${PRUNE_UPSTREAM}/${hash}.narinfo" 2>/dev/null || echo "000")"

  if [ "$status" = "200" ]; then
    rm -f "$narinfo_file"
    printf 'pruned %s\n' "$hash"
  fi
}
export -f prune_one

pruned_count="$(
  printf '%s\n' "${narinfos[@]}" \
    | xargs -I{} -P "$concurrency" bash -c 'set -euo pipefail; prune_one "$@"' _ {} \
    | wc -l
)"

after=$((before - pruned_count))
echo "[prune] removed ${pruned_count}/${before} (kept ${after} to upload)"
