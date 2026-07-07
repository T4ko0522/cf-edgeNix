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
