# セットアップガイド

cf-edgeNix を初めて立ち上げる人向けの完全な導線。`nix develop` で devShell に入ってから実行すること。

---

## 1. 署名鍵の生成

```bash
# 署名鍵を生成（キー名は "nix-cache.example.com-1" など。-1 は rotation 番号）
nix-store --generate-binary-cache-key nix-cache.example.com-1 \
  /path/to/cache-private-key.pem \
  /path/to/cache-public-key.pem

cat /path/to/cache-public-key.pem   # → "nix-cache.example.com-1:xxxx=" をメモ
```

生成した公開鍵は NixOS 設定の `extra-trusted-public-keys` に追加する（後述）。
秘密鍵は GitHub Actions の `CACHE_PRIVATE_KEY` secret にのみ置き、リポジトリにコミットしない。

## 2. Cloudflare リソース作成

```bash
wrangler r2 bucket create cf-edgenix-nar
wrangler kv namespace create META_KV          # 出た id を wrangler.toml の META_KV id へ
wrangler d1 create cf-edgenix-control         # 出た id を wrangler.toml の CONTROL_DB database_id へ
```

## 3. D1 migration 適用

```bash
bun run db:migrate:remote
```

## 4. Worker デプロイ

deploy 前に `wrangler.toml` の `[vars]` にある `CF_ACCOUNT_ID = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"` を実 Cloudflare Account ID へ書き換える。

### 初回デプロイ（手動・疎通確認用）

```bash
bun run deploy
# 出力の URL（例: https://cf-edgenix.<account>.workers.dev）を API_BASE_URL として記録する
```

### 以後の自動デプロイ（Cloudflare Workers Builds）

`main` への push を契機に Cloudflare 側で自動 deploy する。GitHub Actions の deploy workflow は持たない。

Cloudflare Dashboard → Workers & Pages → `cf-edgenix` → Settings → **Build** で GitHub repo を connect し、以下を設定する:

- **Production branch**: `main`
- **Build command**: `bun install`
- **Deploy command**: `npx wrangler d1 migrations apply CONTROL_DB --remote && npx wrangler deploy`
- **Root directory**: `/`

CF 側に置く必要があるのは Workers Builds 用の Cloudflare 権限のみで、GitHub Secret に Cloudflare token は不要になる。

## 5. クライアント側設定（NixOS）

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cf-edgenix.<account>.workers.dev" ];
    extra-trusted-public-keys = [ "nix-cache.example.com-1:xxxx=" ];
  };
}
```

`sudo nixos-rebuild switch --flake .#<host>` で反映。コマンドラインで一度だけ試したい場合は `--option extra-substituters ...` / `--option extra-trusted-public-keys ...` を渡す。

実際にどのエンドポイントが叩かれるか / 疎通確認方法は README §Using the cache from `nixos-rebuild` を参照。

## 6. 初回 publish

publish workflow は **このレポではなく、flake を持つ側の repo** （例: `t4ko0522/dotfiles`）に置く。テンプレート [`.github/templates/publish-cache.yml`](../.github/templates/publish-cache.yml) を相手側の `.github/workflows/` にコピーし、`matrix.host` を実 nixosConfiguration 名に書き換える。

呼び出し側 repo の Environment (`production`) に以下の Secret / Variable を登録してから push または手動実行する。

| 名前 | 種別 | 用途 |
| --- | --- | --- |
| `CACHE_PRIVATE_KEY` | Secret | NAR 署名用秘密鍵（§1 で生成したもの） |
| `ADMIN_TOKEN` | Secret | Worker 管理 API の Bearer トークン |
| `CLOUDFLARE_API_TOKEN` | Secret | R2 write / KV write 最小権限トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare アカウント ID |
| `API_BASE_URL` | Variable | §4 で記録した Worker の URL |
| `R2_BUCKET_NAME` | Variable | R2 バケット名（例: `cf-edgenix-nar`） |
| `KV_NAMESPACE_ID` | Variable | KV 名前空間 ID |

各値の詳細・トークン権限・publish フロー全体は [`publish.md`](publish.md) を参照。
