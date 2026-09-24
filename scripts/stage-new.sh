#!/usr/bin/env bash
# Produce signed narinfo and compressed NAR for selected paths without copying references.
# usage: stage-new.sh <paths-file> <cache-dir> <secret-key-file> <zstd-level>
set -euo pipefail

paths_file="${1:?paths-file is required}"
cache_dir="${2:?cache-dir is required}"
key_file="${3:?secret-key-file is required}"
zstd_level="${4:?zstd-level is required}"

if [ ! -s "$paths_file" ]; then
  exit 0
fi

IFS= read -r secret_key_line < "$key_file" || [ -n "$secret_key_line" ]
key_name="${secret_key_line%%:*}"
if [ -z "$key_name" ] || [ "$key_name" = "$secret_key_line" ]; then
  echo "invalid Nix secret key" >&2
  exit 2
fi

mkdir -p "$cache_dir/nar"
nix store sign --key-file "$key_file" --stdin < "$paths_file"
nix path-info --json --json-format 1 --sigs --stdin < "$paths_file" > "$cache_dir/.new-path-info.json"

if [ "$zstd_level" = "-1" ] || [ "$zstd_level" = "0" ]; then
  zstd_args=()
elif [ "$zstd_level" -lt -1 ]; then
  zstd_args=("--fast=${zstd_level#-}")
elif [ "$zstd_level" -gt 19 ]; then
  zstd_args=(--ultra "-$zstd_level")
else
  zstd_args=("-$zstd_level")
fi

while IFS= read -r store_path; do
  base="${store_path##*/}"
  store_hash="${base%%-*}"
  nar_tmp="$(mktemp "$cache_dir/nar/.${store_hash}.XXXXXX")"
  nix nar dump-path "$store_path" | zstd -q -f "${zstd_args[@]}" -o "$nar_tmp"
  file_hash="$(nix hash file --type sha256 --base32 "$nar_tmp")"
  file_size="$(stat -c %s "$nar_tmp")"
  nar_name="${file_hash}.nar.zst"
  mv "$nar_tmp" "$cache_dir/nar/$nar_name"

  jq -er --arg storePath "$store_path" --arg keyName "$key_name" \
    --arg fileHash "$file_hash" --argjson fileSize "$file_size" \
    --arg narName "$nar_name" '
    .[$storePath] as $info |
    ($info.signatures | map(select(startswith($keyName + ":")))) as $sigs |
    if $info == null or ($sigs | length) == 0 then error("missing signed path info") else
      ["StorePath: " + $storePath,
       "URL: nar/" + $narName,
       "Compression: zstd",
       "FileHash: sha256:" + $fileHash,
       "FileSize: " + ($fileSize | tostring),
       "NarHash: " + $info.narHash,
       "NarSize: " + ($info.narSize | tostring),
       "References: " + ($info.references | map(split("/")[-1]) | join(" "))]
      + (if $info.deriver == null then [] else ["Deriver: " + ($info.deriver | split("/")[-1])] end)
      + (if $info.ca == null then [] else ["CA: " + $info.ca] end)
      + ($sigs | map("Sig: " + .)) | join("\n")
    end
  ' "$cache_dir/.new-path-info.json" > "$cache_dir/$store_hash.narinfo"
done < "$paths_file"
