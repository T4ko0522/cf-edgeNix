# cf-edgeNix

Cloudflare-native な NixOS Binary Cache 基盤。GitHub Actions でビルドした NixOS
system closure を、Cloudflare（R2 / KV / D1 / Workers）上の global binary cache
として配布・保持・rollback する。

設計の詳細は [`docs/spec.md`](docs/spec.md)、未確定の課題は [`docs/fixme.md`](docs/fixme.md)、
publish 運用手順は [`docs/publish.md`](docs/publish.md) を参照。

## 役割分担

| サービス | 役割 |
| --- | --- |
| GitHub Actions | NixOS closure をビルドする signed builder |
| R2 (`NAR_BUCKET`) | NAR / `.narinfo` の正本（source of truth・read path の終点） |
| KV (`META_KV`) | `.narinfo` / `nix-cache-info` の速度層（結果整合・正本ではない） |
| D1 (`CONTROL_DB`) | build履歴 / latest / rollback root / GC live set の control plane |
| Workers | Nix client 向け HTTP gateway + 管理API |

**read path（narinfo / nix-cache-info）は `memory → KV → R2` で完結し D1 を挟まない。**

## ディレクトリ構成

```
src/
  index.ts            Worker entry（ルーティング）
  router.ts           パス → Route 解決
  types.ts            Env binding 型
  auth.ts             Bearer 認証ロジック（純粋関数）
  cache/memory.ts     L0 isolate ローカルキャッシュ
  storage/            KV / R2 / キー命名
  handlers/           cache-info / narinfo / nar / api(D1)
  db/
    schema.ts         Drizzle ORM スキーマ定義（6 テーブル）
    client.ts         getDb(env) — Drizzle インスタンス生成
    queries.ts        Drizzle ベースの read / write クエリ
  publish/
    types.ts          PublishPayload 型・入力バリデーション
    transform.ts      narinfo → D1 行への変換（純粋関数）
    orchestrate.ts    runPublish — publish 副作用オーケストレーション
scripts/
  publish.sh          nix build / nix copy → publish.ts 委譲
  publish.ts          R2 upload / API 呼び出し / KV warming のオーケストレーション
drizzle.config.ts     drizzle-kit 設定
migrations/           D1 schema SQL（drizzle-kit 生成・wrangler で適用）
.github/workflows/    build-and-publish
test/                 vitest（unit: node env / integration: @cloudflare/vitest-pool-workers）
```

## エンドポイント

| メソッド | パス | 認証 | 説明 |
| --- | --- | --- | --- |
| GET | `/nix-cache-info` | 不要 | cache メタ情報 |
| GET | `/<store-hash>.narinfo` | 不要 | narinfo（memory→KV→R2→404） |
| GET/HEAD | `/nar/<file-hash>.nar.zst` | 不要 | NAR 本体（Range: bytes=... / 206 対応・Cache API→R2 streaming） |
| GET | `/api/hosts/:host/latest` | 不要 | host の latest published build |
| GET | `/api/hosts/:host/builds` | 不要 | build 履歴 |
| GET | `/api/builds/:id/manifest.json` | 不要 | 復元用 manifest |
| GET | `/api/quota/status` | 不要 | R2 無料枠 kill-switch の現在 state |
| GET | `/api/quota/metrics` | Bearer | R2 無料枠 kill-switch の詳細 metrics |
| POST | `/api/publish/start` | Bearer | staging build 作成（latest 不変） |
| POST | `/api/publish/:build_id/ingest` | Bearer | store_paths を chunk 分割で冪等投入 |
| POST | `/api/publish/:build_id/finalize` | Bearer | D1 published 確定 + latest 更新（1 batch） |
| POST | `/api/hosts/:host/rollback` | Bearer | rollback root 登録 |
| POST | `/api/gc/dry-run` | Bearer | GC live-set 計算（削除はしない） |
| POST | `/api/quota/reset` | Bearer | kill-switch state を `ok` に手動解除 |
| GET | `/api/openapi.json` | 不要 | OpenAPI 3.0 スキーマ（hono/zod-openapi 自動生成） |

- read 系（GET/HEAD）は認証不要。`nixos-rebuild` から直接叩かれる。
- write 系（POST）は Bearer トークン必須: `Authorization: Bearer <ADMIN_TOKEN>`。
- `ADMIN_TOKEN` 未設定時は write 系を 403 で拒否（安全側）。
- NAR の `GET/HEAD` は `Range: bytes=start-end` / `bytes=start-` / `bytes=-suffix` に対応し 206 を返す。範囲外は 416。

## Quick Start

初めてセットアップする場合の導線。`nix develop` でシェルに入ってから実行すること。

### 1. 署名鍵の生成

```bash
# 署名鍵を生成（キー名は "nix-cache.example.com-1" など。-1 は rotation 番号）
nix-store --generate-binary-cache-key nix-cache.example.com-1 \
  /path/to/cache-private-key.pem \
  /path/to/cache-public-key.pem

cat /path/to/cache-public-key.pem   # → "nix-cache.example.com-1:xxxx=" をメモ
```

生成した公開鍵は NixOS 設定の `trusted-public-keys` に追加する（後述のクライアント設定参照）。
秘密鍵は GitHub Actions の `CACHE_PRIVATE_KEY` secret にのみ置き、リポジトリにコミットしない。

### 2. Cloudflare リソース作成

```bash
wrangler r2 bucket create cf-edgenix-nar
wrangler kv namespace create META_KV          # 出た id を wrangler.toml の META_KV id へ
wrangler d1 create cf-edgenix-control         # 出た id を wrangler.toml の CONTROL_DB database_id へ
```

### 3. D1 migration 適用

```bash
bun run db:migrate:remote
```

### 4. Worker デプロイ

deploy 前に `wrangler.toml` の `[vars]` にある `CF_ACCOUNT_ID = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"` を実 Cloudflare Account ID へ書き換える。

```bash
bun run deploy
# 出力の URL（例: https://cf-edgenix.<account>.workers.dev）を API_BASE_URL として記録する
```

### 5. クライアント側設定（NixOS）

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cf-edgenix.<account>.workers.dev" ];
    extra-trusted-public-keys = [ "nix-cache.example.com-1:xxxx=" ];
  };
}
```

### 6. 初回 publish

GitHub Actions の `CACHE_PRIVATE_KEY` / `ADMIN_TOKEN` / `CLOUDFLARE_API_TOKEN` などの secret を設定してから push または手動実行する。
詳細は [`docs/publish.md`](docs/publish.md) を参照。

## 開発

```bash
# devShell に入る（bun / nodejs / zstd / nix はここで提供される）
nix develop

bun install
bun run typecheck

# unit テスト（node 環境）
bun run test          # = vitest run --project unit

# integration テスト（@cloudflare/vitest-pool-workers / workerd 使用）
# CI (Ubuntu) では:
npx vitest run --project integration
# NixOS 環境では workerd バイナリに動的リンクが必要なため steam-run 必須:
steam-run npx vitest run --project integration

# Drizzle schema から migration SQL を再生成（src/db/schema.ts を変更した場合）
bun run db:generate          # drizzle/ ディレクトリに差分 SQL を生成
# 内容を確認後、migrations/0001_init.sql へ反映してから:
bun run db:migrate:local     # ローカル D1 へ適用

# 管理トークンの設定（ローカル開発）
echo 'ADMIN_TOKEN=dev-secret' >> .dev.vars   # .dev.vars は .gitignore 済み

# ローカル起動（要 wrangler.toml の binding id 設定・.dev.vars に ADMIN_TOKEN）
bun run dev
```

### .dev.vars の例

`.dev.vars` は wrangler がローカル開発時に読む秘密値ファイル。`.gitignore` 済みなのでコミットされない。

```
ADMIN_TOKEN=dev-secret
CF_ANALYTICS_TOKEN=dev-only-or-leave-empty
CF_ACCOUNT_ID=your-cloudflare-account-id
```

### Cloudflare リソース作成（初回）

```bash
wrangler r2 bucket create cf-edgenix-nar
wrangler kv namespace create META_KV          # 出た id を wrangler.toml へ
wrangler d1 create cf-edgenix-control         # 出た id を wrangler.toml へ
bun run db:migrate:remote
```

### publish を手動実行する

```bash
HOST=myhost \
CACHE_DIR=/tmp/nix-cache \
CACHE_PRIVATE_KEY="$(cat /path/to/cache-private-key.pem)" \
API_BASE_URL=https://cf-edgenix.<account>.workers.dev \
ADMIN_TOKEN=your-token \
R2_BUCKET_NAME=cf-edgenix-nar \
KV_NAMESPACE_ID=<kv-namespace-id> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<r2-kv-write-token> \
bash scripts/publish.sh
```

## 環境変数・Secret

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
- `wrangler.toml` の `[vars]` には `CACHE_INFO_PRIORITY` / `CF_ACCOUNT_ID` / `QUOTA_R2_BUCKET_NAME` などの非 Secret のみ置く。Secret 類は絶対に `[vars]` に書かない。
- `CF_ACCOUNT_ID` のプレースホルダーは deploy 前に実 Cloudflare Account ID へ書き換える。
- `drizzle.config.ts` の `dbCredentials` は環境変数参照のみ（`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID` / `CLOUDFLARE_D1_TOKEN`）。

## 無料枠 kill-switch

Cron Trigger が 5 分ごとに Cloudflare GraphQL Analytics API を読み、R2 の storage / Class A / Class B 操作数が月次無料枠の 80% 以上で `warn`、95% 以上で `killed` に遷移する。`killed` 中は `/api/*` 以外の read path が 503 を返す。

現在 state は `GET /api/quota/status` で確認できる。詳細 metrics は `GET /api/quota/metrics` を Bearer 認証付きで取得する。運用手順、必要な Cloudflare token 権限、手動解除方法は [`docs/quota.md`](docs/quota.md) を参照。

### 管理 read API の公開について

`/api/hosts/:host/latest`・`/api/hosts/:host/builds`・`/api/builds/:id/manifest.json`・`/api/openapi.json` は**認証不要で公開**されており、git rev / flake.lock hash / store path closure が見える。これは意図した設計である。substituter として Nix client が直接叩く narinfo は既に同等情報を公開しており、本キャッシュは個人用途のため、管理 read API も同様に公開することを受容する。write 系（publish / rollback / GC）は引き続き Bearer 認証で保護する。

## クライアント側設定

```nix
{
  nix.settings = {
    extra-substituters = [ "https://nix-cache.example.com" ];
    extra-trusted-public-keys = [ "nix-cache.example.com-1:xxxx=" ];
  };
}
```
