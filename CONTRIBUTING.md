# Contributing / 開発

## devShell

```bash
# bun / nodejs / zstd / nix が揃った devShell に入る
nix develop

bun install
bun run typecheck
```

## テスト

```bash
# unit テスト（node 環境）
bun run test          # = vitest run --project unit

# integration テスト（@cloudflare/vitest-pool-workers / workerd 使用）
bun run test:integration
```

## D1 schema 変更

```bash
# src/db/schema.ts を変更したら:
bun run db:generate          # drizzle/ ディレクトリに差分 SQL を生成
# 内容を確認後、migrations/0001_init.sql へ反映してから:
bun run db:migrate:local     # ローカル D1 へ適用
```

## ローカル起動

```bash
# 管理トークンの設定（.dev.vars は .gitignore 済み）
echo 'ADMIN_TOKEN=dev-secret' >> .dev.vars

bun run dev
```

### `.dev.vars` の例

`.dev.vars` は wrangler がローカル開発時に読む秘密値ファイル。`.gitignore` 済みなのでコミットされない。

```
ADMIN_TOKEN=dev-secret
CF_ANALYTICS_TOKEN=dev-only-or-leave-empty
CF_ACCOUNT_ID=your-cloudflare-account-id
```

## publish を手元から叩く

[`docs/publish.md` §手動実行](docs/publish.md#手動実行) を参照。

## 環境変数 / Secret リファレンス

| 変数名 | 種別 | 用途 | 設定場所 |
| --- | --- | --- | --- |
| `CACHE_PRIVATE_KEY` | Secret | `nix copy` が生成する NAR / narinfo の署名秘密鍵。fork PR に絶対露出させない。 | GitHub Actions Secret（protected environment `production`） |
| `ADMIN_TOKEN` | Secret | Worker 管理 API（write 系）の Bearer トークン。未設定時は write 系が 403 になる。 | `.dev.vars`（ローカル）/ GitHub Actions Secret |
| `CF_ANALYTICS_TOKEN` | Secret | Cron が Cloudflare GraphQL Analytics API から R2 月次使用量を読むためのトークン。 | `.dev.vars`（ローカル）/ `wrangler secret put` |
| `CLOUDFLARE_API_TOKEN` | Secret | R2 write / KV write 最小権限の Cloudflare トークン（wrangler CLI が参照）。 | GitHub Actions Secret |
| `CF_ACCOUNT_ID` | 変数 | Worker の quota Cron が参照する Cloudflare アカウント ID。 | `wrangler.toml` `[vars]` / `.dev.vars` |
| `CLOUDFLARE_ACCOUNT_ID` | 変数 | Cloudflare アカウント ID（wrangler CLI が参照）。 | GitHub Actions Variable |
| `API_BASE_URL` | 変数 | デプロイ済み Worker の URL（例: `https://cf-edgenix.<account>.workers.dev`）。 | GitHub Actions Variable |
| `QUOTA_R2_BUCKET_NAME` | 変数 | quota 監視対象の R2 バケット名（例: `cf-edgenix-nar`）。 | `wrangler.toml` `[vars]` |
| `R2_BUCKET_NAME` | 変数 | R2 バケット名（例: `cf-edgenix-nar`）。 | GitHub Actions Variable |
| `KV_NAMESPACE_ID` | 変数 | KV 名前空間 ID。 | GitHub Actions Variable |
| `HOST` | 変数 | publish 対象の nixosConfiguration 名（例: `myhost`）。 | GitHub Actions input / スクリプト引数 |
| `CACHE_DIR` | 変数 | `nix copy --to file://` の出力先ディレクトリ（CI は `runner.temp` など）。 | スクリプト引数 |
| `CLOUDFLARE_D1_DATABASE_ID` | 変数 | drizzle-kit が使う D1 database ID（`db:generate` 実行時のみ必要）。 | ローカル開発環境 |
| `CLOUDFLARE_D1_TOKEN` | 変数 | drizzle-kit が使う D1 API トークン（`db:generate` 実行時のみ必要）。 | ローカル開発環境 |

- `CLOUDFLARE_API_TOKEN` は R2 write と KV write を最小権限でカバーするトークンを使う。
- `wrangler.toml` の `[vars]` には `CACHE_INFO_PRIORITY` / `CF_ACCOUNT_ID` / `QUOTA_R2_BUCKET_NAME` などの非 Secret のみ置く。Secret 類は絶対に `[vars]` に書かない。`CF_ACCOUNT_ID` のプレースホルダー書き換えは [`docs/setup.md` §4](docs/setup.md#4-worker-デプロイ) を参照。
- `drizzle.config.ts` の `dbCredentials` は環境変数参照のみ（`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID` / `CLOUDFLARE_D1_TOKEN`）。
