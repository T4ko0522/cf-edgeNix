#!/usr/bin/env bash
# Classify a full closure before generating any NARs.
# usage: classify-closure.sh <paths.json> <self-narinfo-dir> <self-url> <api-url> <substituters.json>
set -euo pipefail

paths_file="${1:?paths.json is required}"
self_dir="${2:?self-narinfo-dir is required}"
self_url="${3:?self-url is required}"
api_url="${4:?api-url is required}"
substituters_file="${5:?substituters.json is required}"
concurrency="${CLASSIFY_CONCURRENCY:-32}"
timeout="${CLASSIFY_TIMEOUT:-5}"

[[ "$concurrency" =~ ^[1-9][0-9]*$ ]] || { echo "CLASSIFY_CONCURRENCY must be positive" >&2; exit 2; }
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo "CLASSIFY_TIMEOUT must be positive" >&2; exit 2; }
mkdir -p "$self_dir"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# The effective Nix configuration is the authority. URLs without an HTTP narinfo
# endpoint cannot be checked here and are conservatively treated as unavailable.
jq -r --arg self "${self_url%/}" --arg api "${api_url%/}" '
  .[] | rtrimstr("/") | select(. != $self and . != $api and test("^https?://"))
' "$substituters_file" > "$work_dir/external-urls"
jq -r '.[]' "$paths_file" > "$work_dir/paths"

export CLASSIFY_EXTERNAL_URLS="$work_dir/external-urls"
export CLASSIFY_SELF_URL="${self_url%/}"
export CLASSIFY_SELF_DIR="$self_dir"
export CLASSIFY_TIMEOUT_SEC="$timeout"
export CLASSIFY_OUTPUT_DIR="$work_dir/results"
mkdir -p "$CLASSIFY_OUTPUT_DIR"

classify_one() {
  local store_path="$1" base hash url status tmp
  base="${store_path##*/}"
  hash="${base%%-*}"
  while IFS= read -r url; do
    if ! status="$(curl -sS -o /dev/null --head --max-time "$CLASSIFY_TIMEOUT_SEC" -w '%{http_code}' "${url}/${hash}.narinfo" 2>/dev/null)"; then
      continue
    fi
    if [ "$status" = "200" ]; then
      jq -cn --arg path "$store_path" --arg url "$url" '{storePath:$path, kind:"external", substituterUrl:$url}' > "$CLASSIFY_OUTPUT_DIR/$hash.json"
      return
    fi
  done < "$CLASSIFY_EXTERNAL_URLS"

  tmp="$(mktemp "$CLASSIFY_SELF_DIR/.${hash}.XXXXXX")"
  if ! status="$(curl -sS --max-time "$CLASSIFY_TIMEOUT_SEC" -o "$tmp" -w '%{http_code}' "${CLASSIFY_SELF_URL}/${hash}.narinfo" 2>/dev/null)"; then
    status="000"
  fi
  local valid=1 field
  for field in URL Compression FileHash FileSize NarHash NarSize; do
    if ! grep -Eq "^${field}: [^[:space:]]" "$tmp"; then
      valid=0
      break
    fi
  done
  if [ "$status" = "200" ] && [ "$valid" = "1" ] &&
    [ "$(grep -c '^StorePath: ' "$tmp" || true)" = "1" ] &&
    grep -Fxq "StorePath: $store_path" "$tmp"; then
    mv "$tmp" "$CLASSIFY_SELF_DIR/$hash.narinfo"
    jq -cn --arg path "$store_path" '{storePath:$path, kind:"self"}' > "$CLASSIFY_OUTPUT_DIR/$hash.json"
  else
    rm -f "$tmp"
    jq -cn --arg path "$store_path" '{storePath:$path, kind:"new"}' > "$CLASSIFY_OUTPUT_DIR/$hash.json"
  fi
}
export -f classify_one

if [ -s "$work_dir/paths" ]; then
  xargs -r -d '\n' -P "$concurrency" -I{} bash -c 'set -euo pipefail; classify_one "$1"' _ {} < "$work_dir/paths"
fi
find "$CLASSIFY_OUTPUT_DIR" -maxdepth 1 -name '*.json' -type f -exec cat {} + |
  jq -s 'map({key:.storePath, value:(del(.storePath))}) | from_entries'
