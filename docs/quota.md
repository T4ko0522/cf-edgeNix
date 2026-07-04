# R2 無料枠 kill-switch

cf-edgeNix は R2 の月次無料枠を超えそうな場合に read path を自動停止する。停止対象は `/nix-cache-info`、`/<store-hash>.narinfo`、`/nar/<file-hash>.nar.zst` で、`/api/*` は状態確認と手動解除のため停止しない。

## 監視対象としきい値

Cron Trigger（`*/5 * * * *`）が Cloudflare GraphQL Analytics API を読み、月初 UTC から現在までの使用量を `META_KV` の `quota:state` に保存する。

| 指標 | 無料枠 | `warn` | `killed` |
| --- | ---: | ---: | ---: |
| R2 storage | 10 GB | 80% | 95% |
| Class A operations | 1,000,000 / month | 80% | 95% |
| Class B operations | 10,000,000 / month | 80% | 95% |

いずれか 1 指標でも 95% 以上になると `killed` になり、read path は 503 を返す。80% 以上 95% 未満では `warn` だが配信は継続する。

R2 storage は SI の 10 GB を無料枠として扱う。これは現在値 guard であり、厳密な月次 GB-month 計算ではない。R2 課金は GB-month 月平均だが、kill-switch 目的では月内の `payloadSize` 最大値で現在 R2 に載っている量を近似し、10 GB 超過を防ぐ guard として割り切る。

## Cloudflare token

`CF_ANALYTICS_TOKEN` は Cloudflare Dashboard で Account Analytics を読める API token として作成する。

1. Cloudflare Dashboard の API Tokens で Custom token を作成する。
2. Account permissions に `Account Analytics: Read` を付ける。
3. 対象 account をこの Worker の account に限定する。
4. 生成した token を Worker secret に保存する。

```bash
wrangler secret put CF_ANALYTICS_TOKEN
```

ローカル開発では `.dev.vars` に置ける。

```dotenv
CF_ANALYTICS_TOKEN="dev-only-or-leave-empty"
CF_ACCOUNT_ID="your-cloudflare-account-id"
```

`CF_ACCOUNT_ID` と `QUOTA_R2_BUCKET_NAME` は Secret ではないため、通常は `wrangler.toml` の `[vars]` に置く。`CF_ANALYTICS_TOKEN` は Secret として扱い、`wrangler.toml` には書かない。
`wrangler.toml` の `CF_ACCOUNT_ID = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"` は deploy 前に実 Cloudflare Account ID へ必ず書き換える。

## 状態確認

現在の状態は認証なしで確認できる。

```bash
curl https://cf-edgenix.example.workers.dev/api/quota/status
```

まだ Cron が state を保存していない場合は次を返す。

```json
{ "state": "ok", "checkedAt": null }
```

## 手動解除

`killed` の解除方法は 3 通りある。

1. 次の 5 分 Cron で使用量が 95% を下回れば自動で `ok` に解除される（月初の usage リセットで通常は数分で解除）。
2. 管理 API で `ok` に戻す。

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://cf-edgenix.example.workers.dev/api/quota/reset
```

L0 cache は epoch カウンタで管理されており、reset API は epoch をインクリメントするため即座に反映される。ただし他 isolate では KV edge cache の伝播遅延（最大 60 秒程度）により古い state を返す可能性がある。

3. KV の state と epoch を削除する。

```bash
bunx wrangler kv key delete --binding=META_KV quota:state
bunx wrangler kv key delete --binding=META_KV quota:epoch
```

`quota:epoch` を削除しないと、既存 isolate の L0 cache が無効化されず古い state を返し続ける。

手動解除しても同じ月の使用量が 95% 以上のままなら、次の Cron で再び `killed` になる。

## Billing alert との違い

Cloudflare Billing alert は通知だけを行い、既存の read path を停止しない。Nix client は `.narinfo` と NAR を大量に取得するため、通知に気付くまでの間にも R2 操作数が増える。この kill-switch は Worker 経由の配信を止めることで、無料枠超過時の追加消費を自動的に抑える。
