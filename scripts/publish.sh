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
out_paths=()
for host in "${hosts[@]}"; do
  installable=".#nixosConfigurations.\"${host}\".config.system.build.toplevel"
  out="$(nix eval --raw "$installable")"
  if ! [[ "$out" == /nix/store/* ]]; then
    echo "nix eval returned an invalid toplevel for $host: $out" >&2
    exit 1
  fi
  out_paths+=("$out")
  target_system="${SYSTEM:-$(nix eval --raw ".#nixosConfigurations.\"${host}\".pkgs.system")}"

  target_dir="${work_dir}/targets/${host}"
  closure_json_path="${target_dir}/closure.json"
  mkdir -p "$target_dir"
  nix path-info -r --json "$out" > "$closure_json_path"
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

phase_started=$SECONDS
nix copy \
  --to "file://${CACHE_DIR}?compression=zstd&compression-level=${ZSTD_LEVEL}&secret-key=${key_file}" \
  "${out_paths[@]}"
log_timing "copy" "$phase_started"

phase_started=$SECONDS
if [ "${SKIP_UPSTREAM_PRUNE:-0}" = "1" ]; then
  echo "[prune] SKIP_UPSTREAM_PRUNE=1, skipping upstream subtraction"
else
  bash "$(dirname "$0")/prune-upstream.sh" \
    "$CACHE_DIR" \
    "${UPSTREAM_CACHE_URL:-https://cache.nixos.org}"
fi
log_timing "upstream-prune" "$phase_started"

jq -s --arg cacheDir "$CACHE_DIR" \
  '{version: 1, cacheDir: $cacheDir, targets: .}' \
  "$targets_file" > "$plan_file"

echo "Uploading ${#hosts[@]} host(s) to R2/D1/KV via scripts/publish.ts..."
phase_started=$SECONDS
bun "$(dirname "$0")/publish.ts" --plan "$plan_file"
log_timing "publish" "$phase_started"
log_timing "total" "$total_started"
echo "publish.ts complete"
