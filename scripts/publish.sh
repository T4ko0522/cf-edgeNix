#!/usr/bin/env bash
# cf-edgeNix batch publish step (spec docs/spec.md §9)
set -euo pipefail

total_started=$SECONDS
log_timing() {
  local phase="$1"
  local started="$2"
  echo "[timing] ${phase}=$(( SECONDS - started ))s"
}

: "${CACHE_DIR:?CACHE_DIR is required}"
: "${CACHE_PRIVATE_KEY:?CACHE_PRIVATE_KEY is required}"
: "${ZSTD_LEVEL:=9}"

if [ "$#" -gt 0 ] && [ -n "${HOST:-}" ]; then
  echo "hosts must be specified by positional arguments or HOST, not both" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  : "${HOST:?HOST or positional host arguments are required}"
  hosts=("$HOST")
else
  hosts=("$@")
fi

declare -A seen_hosts=()
for host in "${hosts[@]}"; do
  if ! [[ "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "invalid host name: $host" >&2
    exit 2
  fi
  if [ -n "${seen_hosts[$host]:-}" ]; then
    echo "duplicate host: $host" >&2
    exit 2
  fi
  seen_hosts[$host]=1
done

if ! [[ "$ZSTD_LEVEL" =~ ^-?[0-9]+$ ]]; then
  echo "ZSTD_LEVEL must be an integer" >&2
  exit 2
fi
if [ ! -d "$CACHE_DIR" ]; then
  echo "CACHE_DIR must already exist: $CACHE_DIR" >&2
  exit 2
fi
if [ -n "$(find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "CACHE_DIR must be empty: $CACHE_DIR" >&2
  exit 2
fi

: "${API_BASE_URL:?API_BASE_URL is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME is required}"
: "${KV_NAMESPACE_ID:?KV_NAMESPACE_ID is required}"

git_rev="${GIT_REV:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
flake_lock_hash="${FLAKE_LOCK_HASH:-unknown}"

work_dir="$(mktemp -d)"
key_file="${work_dir}/cache-private-key"
targets_file="${work_dir}/targets.jsonl"
plan_file="${work_dir}/publish-plan.json"
closure_paths_file="${work_dir}/closure-paths"
self_candidates_file="${work_dir}/self-candidates"
copy_paths_file="${work_dir}/copy-paths"
trap 'rm -rf "$work_dir"' EXIT
chmod 700 "$work_dir"
printf '%s' "$CACHE_PRIVATE_KEY" > "$key_file"
chmod 600 "$key_file"

installables=()
for host in "${hosts[@]}"; do
  installables+=(".#nixosConfigurations.\"${host}\".config.system.build.toplevel")
done
phase_started=$SECONDS
nix build "${installables[@]}" --no-link
log_timing "build" "$phase_started"

phase_started=$SECONDS
for host in "${hosts[@]}"; do
  installable=".#nixosConfigurations.\"${host}\".config.system.build.toplevel"
  out="$(nix eval --raw "$installable")"
  if ! [[ "$out" == /nix/store/* ]]; then
    echo "nix eval returned an invalid toplevel for $host: $out" >&2
    exit 1
  fi
  target_system="${SYSTEM:-$(nix eval --raw ".#nixosConfigurations.\"${host}\".pkgs.system")}"

  target_dir="${work_dir}/targets/${host}"
  closure_json_path="${target_dir}/closure.json"
  mkdir -p "$target_dir"
  nix path-info -r --json "$out" > "$closure_json_path"
  jq -r 'keys[]' "$closure_json_path" >> "$closure_paths_file"
  jq -cn \
    --slurpfile closure "$closure_json_path" \
    --arg host "$host" \
    --arg system "$target_system" \
    --arg gitRev "$git_rev" \
    --arg flakeLockHash "$flake_lock_hash" \
    --arg toplevelStorePath "$out" \
    --arg closureJsonPath "$closure_json_path" \
    '{host: $host, system: $system, gitRev: $gitRev, flakeLockHash: $flakeLockHash,
      toplevelStorePath: $toplevelStorePath, closureJsonPath: $closureJsonPath,
      closureStorePaths: ($closure[0] | keys)}' >> "$targets_file"
done
log_timing "closure-metadata" "$phase_started"

sort -u -o "$closure_paths_file" "$closure_paths_file"
closure_count="$(wc -l < "$closure_paths_file")"

phase_started=$SECONDS
if [ "${SKIP_UPSTREAM_PRUNE:-0}" = "1" ]; then
  cp "$closure_paths_file" "$self_candidates_file"
  echo "[preflight] SKIP_UPSTREAM_PRUNE=1, passing all ${closure_count} paths to self cache check"
else
  upstream="${UPSTREAM_CACHE_URL:-https://cache.nixos.org}"
  upstream="${upstream%/}"
  concurrency="${PRUNE_CONCURRENCY:-32}"
  timeout="${PRUNE_TIMEOUT:-5}"
  export PREFLIGHT_UPSTREAM="$upstream"
  export PREFLIGHT_TIMEOUT_SEC="$timeout"

  select_missing_path() {
    local store_path="$1"
    local base store_hash status
    base="${store_path##*/}"
    store_hash="${base%%-*}"
    status="$(curl -sS -o /dev/null --head \
      --max-time "$PREFLIGHT_TIMEOUT_SEC" \
      -w '%{http_code}' \
      "${PREFLIGHT_UPSTREAM}/${store_hash}.narinfo" 2>/dev/null || echo "000")"
    if [ "$status" != "200" ]; then
      printf '%s\n' "$store_path"
    fi
  }
  export -f select_missing_path

  xargs -r -P "$concurrency" -n 1 bash -c \
    'set -euo pipefail; select_missing_path "$1"' _ \
    < "$closure_paths_file" \
    | sort > "$self_candidates_file"

  self_candidate_count="$(wc -l < "$self_candidates_file")"
  upstream_count=$(( closure_count - self_candidate_count ))
  echo "[preflight] upstream owns ${upstream_count}/${closure_count}; self candidates ${self_candidate_count}"
fi
log_timing "upstream-preflight" "$phase_started"

self_candidate_count="$(wc -l < "$self_candidates_file")"
phase_started=$SECONDS
if [ "${SKIP_SELF_CACHE_REUSE:-0}" = "1" ]; then
  cp "$self_candidates_file" "$copy_paths_file"
  echo "[preflight] SKIP_SELF_CACHE_REUSE=1, copying ${self_candidate_count} self candidates"
else
  self_cache_url="${SELF_CACHE_URL:-$API_BASE_URL}"
  self_cache_url="${self_cache_url%/}"
  self_concurrency="${SELF_CACHE_CONCURRENCY:-${PRUNE_CONCURRENCY:-32}}"
  self_timeout="${SELF_CACHE_TIMEOUT:-${PRUNE_TIMEOUT:-5}}"
  export PREFLIGHT_SELF_CACHE_URL="$self_cache_url"
  export PREFLIGHT_SELF_TIMEOUT_SEC="$self_timeout"
  export PREFLIGHT_CACHE_DIR="$CACHE_DIR"

  reuse_or_select_path() {
    local store_path="$1"
    local base store_hash tmp status
    base="${store_path##*/}"
    store_hash="${base%%-*}"
    tmp="${PREFLIGHT_CACHE_DIR}/.${store_hash}.narinfo.tmp.$$"
    status="$(curl -sS -o "$tmp" \
      --max-time "$PREFLIGHT_SELF_TIMEOUT_SEC" \
      -w '%{http_code}' \
      "${PREFLIGHT_SELF_CACHE_URL}/${store_hash}.narinfo" 2>/dev/null || echo "000")"
    if [ "$status" = "200" ] \
      && grep -Fqx "StorePath: ${store_path}" "$tmp" \
      && grep -Eq '^URL: nar/[0-9a-z]+\.nar(\.(xz|zst|gz|br))?$' "$tmp"; then
      mv "$tmp" "${PREFLIGHT_CACHE_DIR}/${store_hash}.narinfo"
      return 0
    fi
    rm -f "$tmp"
    printf '%s\n' "$store_path"
  }
  export -f reuse_or_select_path

  xargs -r -P "$self_concurrency" -n 1 bash -c \
    'set -euo pipefail; reuse_or_select_path "$1"' _ \
    < "$self_candidates_file" \
    | sort > "$copy_paths_file"

  copy_count="$(wc -l < "$copy_paths_file")"
  reused_count=$(( self_candidate_count - copy_count ))
  echo "[preflight] self cache reuses ${reused_count}/${self_candidate_count}; copying ${copy_count}"
fi
log_timing "self-cache-preflight" "$phase_started"

copy_count="$(wc -l < "$copy_paths_file")"
phase_started=$SECONDS
if [ "$copy_count" -gt 0 ]; then
  nix copy \
    --to "file://${CACHE_DIR}?compression=zstd&compression-level=${ZSTD_LEVEL}&secret-key=${key_file}" \
    --no-recursive \
    --stdin \
    < "$copy_paths_file"
else
  echo "[copy] no self-hosted paths to copy"
fi
log_timing "copy" "$phase_started"

jq -s --arg cacheDir "$CACHE_DIR" \
  '{version: 1, cacheDir: $cacheDir, targets: .}' \
  "$targets_file" > "$plan_file"

echo "Uploading ${#hosts[@]} host(s) to R2/D1/KV via scripts/publish.ts..."
phase_started=$SECONDS
bun "$(dirname "$0")/publish.ts" --plan "$plan_file"
log_timing "publish" "$phase_started"
log_timing "total" "$total_started"
echo "publish.ts complete"
