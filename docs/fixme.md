# FIXME / 未確定の設計課題

## 1. R2 quota kill-switch の改善

### TODO

- [x] L0 伝播の epoch 化リファクタ

## 2. Workers Cache タグ purge の Free プラン可否検証

Cache-Tag ベースの purge（`ctx.cache.purge({ tags })`）は zone cache では従来 Enterprise 限定機能だった。Workers Cache で Free プランでも使えるかはドキュメントから確定できていない。

### 検証手順（デプロイ後）

1. `POST /api/gc/execute`（`phase: narinfo`）を実行し、レスポンスの `edge_purge_attempted` が対象タグ数と一致するか確認する。
2. purge 直後に該当 `<store-hash>.narinfo` を GET し、edge miss（Worker が起動する = invocation log に出る）になることを確認する。

### 不可だった場合

purge は best-effort 実装（`src/cache/purge.ts`）なので機能は degraded で継続する: GC 後も edge の narinfo/NAR エントリは TTL 満了（narinfo 3600 秒 / NAR は eviction 任せ）まで残り、finalize 後の 404 negative cache は 60 秒で自然解消する。恒常的に不可なら `edge_purge_attempted` を response から落とすか、`pathPrefixes` purge への切り替えを検討する。

### TODO

- [ ] 実環境で `edge_purge_attempted` と purge 実効性を確認する

## 3. narinfo negative cache TTL (60 秒) が実運用で効いていない

2026-07-07 のベンチマーク（[dotfiles run 28880312114](https://github.com/T4ko0522/dotfiles/actions/runs/28880312114)、laptop closure 2,546 paths）で判明。

Nix は Priority 30 の本 cache に全 path の narinfo を最初に問い合わせるため、
cache に無い約 2,290 path 分のネガティブルックアップが毎回 KV → R2 404 まで貫通する
（404 も R2 Class B 課金対象）。実測:

| フェーズ | ΔClass B |
| --- | --- |
| edge cold run | +1,860 |
| edge warm run（約 7 分後） | +1,440 |

`src/handlers/narinfo.ts` の negative cache（`max-age=60`）は実装済みだが、
rebuild の実行間隔（数分〜数日）に対して TTL 60 秒は短すぎて全滅する。
Workers Cache API による削減は NAR 本体 + narinfo positive 分の約 420 ops (23%) のみ。

### 検討すること

- negative TTL を延ばす（例: 1〜24 時間）。publish finalize が Cache-Tag
  `narinfo-miss` / `narinfo:<storeHash>` を purge する前提なら、新規 publish 直後の
  404 残留は purge で解消できるため TTL を伸ばしても安全なはず。
- ただしこれは **課題 2（Free プランで tag purge が効くか）の検証結果に依存する**。
  purge 不可なら、publish 直後に旧 negative entry が TTL 満了まで残り、
  publish 済み path が最長 TTL 分 404 になるリスクと引き換えになる。

### TODO

- [ ] 課題 2 の purge 実効性検証を先に完了させる
- [ ] purge 可なら negative TTL を延長し、ベンチ（dotfiles `bench/cache-benchmark`）で
      warm run の ΔClass B が数十 ops 台に落ちることを確認する
