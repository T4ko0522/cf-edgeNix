# API リファレンス

Worker が公開する HTTP エンドポイント一覧。OpenAPI スキーマは `GET /api/openapi.json` から取得できる（hono/zod-openapi で自動生成）。

| メソッド | パス | 認証 | 説明 |
| --- | --- | --- | --- |
| GET | `/nix-cache-info` | 不要 | cache メタ情報（`StoreDir` / `WantMassQuery` / `Priority`） |
| GET | `/<store-hash>.narinfo` | 不要 | narinfo（`memory → KV → R2 → 404`） |
| GET/HEAD | `/nar/<file-hash>.nar.zst` | 不要 | NAR 本体（Range: bytes=... / 206 対応・Cache API → R2 streaming） |
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
| GET | `/api/openapi.json` | 不要 | OpenAPI 3.0 スキーマ |

## 認証

- read 系（GET/HEAD）は認証不要。`nixos-rebuild` から直接叩かれる。
- write 系（POST）は Bearer トークン必須: `Authorization: Bearer <ADMIN_TOKEN>`。
- `ADMIN_TOKEN` 未設定時は write 系を 403 で拒否する（安全側）。
- `/api/hosts/:host/latest` ・ `/api/hosts/:host/builds` ・ `/api/builds/:id/manifest.json` ・ `/api/openapi.json` は公開（git rev / flake.lock hash / store path closure が見える）。これは substituter の narinfo が既に同等情報を露出していることと、本キャッシュが個人用途であることを踏まえた設計判断。

## Range / partial fetch

NAR の `GET/HEAD` は以下を全て受け付け、適合する 206 を返す。範囲外は 416。

- `Range: bytes=<start>-<end>`
- `Range: bytes=<start>-`
- `Range: bytes=-<suffix>`

## 無料枠 kill-switch

`killed` state の間は `/api/*` 以外の read path（narinfo / NAR / nix-cache-info）が 503 を返す。詳細は [`quota.md`](quota.md) を参照。
