# FIXME / 未確定の設計課題

このファイルは `docs/spec.md` のレビューで挙がった課題のうち、**今は直さず後で確定する**ものを記録する。
spec 本体には「未確定」とだけ書き、詳細はここに集約する。

---

## 1. GC の削除順序（最優先の未確定事項）

### 背景

spec section 8 で mark-and-sweep 方式の GC 方針までは確定した。
しかし「dead と判定した object を **どの順序で** 消すか」は未定義のまま。

ここを詰めないと、edge や client に残った古い `.narinfo` が、
既に削除した NAR を指して **404 を撒く** 事故が起きる。

理由:

- Nix は binary cache の存在情報を local に cache する
- negative answer（存在しない）も cache する
- そのため「narinfo は見えるが NAR は消えている」状態が最も危険

### あるべき削除順序

```text
1. live set を計算（rollback_roots → builds → build_closure → live nar keys）
2. dead store path の .narinfo を unpublish 対象にする
3. KV / edge metadata を purge（narinfo を先に見えなくする）
4. grace period を置く（最低でも数日）
5. NAR file を削除（narinfo より後）
```

ポイント:

- **narinfo を先に消し、NAR を後に消す**（逆は厳禁）
- metadata TTL は短め、NAR TTL は長め / immutable に振る
- GC grace と retention policy は分離する

### 当面の方針（MVP）

個人用・小規模のうちは **NAR をほぼ消さない**。
R2 storage cost と運用事故リスクを天秤にかけると、初期段階は「消さない」が最も安全。
GC を実装するのは retention が実際に問題になってから。

### TODO

- [ ] grace period の具体値を決める（暫定: 7日）
- [ ] KV / edge purge の対象キー設計（narinfo key の一覧化）
- [ ] R2 削除を実行する worker / cron の置き場所
- [x] 削除実行前の dry-run（live set との差分ログ）— 実装済み（`POST /api/gc/dry-run`）`live_nar_keys` と `dead_candidates` を返す。実 R2 物理削除は引き続き未実装。`computeLiveSet` は published builds の closure + rollback_roots の union から `build_closure → store_paths` を辿り live/dead を算出する実装済み（`src/db/queries.ts`・999 件分割クエリ）。integration テストで動作確認済み。

---

## 2. Rollback 復元用 manifest

### 背景（役割の違い）

- `rollback_roots` = **R2 に在庫を残すタグ**。GC から closure を守り、過去世代の NAR を R2 に存在させ続ける。
- `build_manifests` = **取り出し方を記録した引換票**。「host X の generation 41 = この `toplevel_store_path`」を記録し、remote から何を引けばよいかを示す。

在庫（rollback_roots）と引換票（build_manifests）の両方がそろって初めて remote ロールバックが成立する。

### 状態: `build_manifests` は spec に追加済み・署名は不要で決定

`build_manifests` テーブルと管理 API（`/api/hosts/<host>/builds`、`/latest`、`/api/builds/<id>/manifest.json`）は
spec section 7 / 8 へ正式に取り込んだ。**manifest 署名は付けないことで決定**したため、#2 に未確定事項は残っていない。
（下の「manifest 署名」節は、なぜ署名なしで良いか／将来 public cache 化した際に再検討する判断軸として残す。）

### 復元手段: 専用 CLI は作らない

専用にインストールさせる CLI は不要と判断。
やるとしても **`nix-shell` か `npx`** で都度実行できる薄いスクリプトに留める（インストール不要・使い捨て）。
当面は manifest を手で見て、以下を手打ちすれば復元できる。

```bash
nix-store -r /nix/store/...-nixos-system-myhost-... \
  --option substituters https://nix-cache.example.com \
  --option trusted-public-keys "nix-cache.example.com-1:..."

sudo /nix/store/...-nixos-system-myhost-.../bin/switch-to-configuration boot
```

### manifest 署名（決定: 付けない／将来の再検討メモ）

manifest は「どの build を選ぶか」の selection 情報であり、**Nix の署名検証（narinfo の `Sig:`）の外側**にある。
Nix の署名は中身の真正性しか守らないため、manifest が改ざんされると、
**中身は正規署名のまま selection だけすり替える**攻撃が成立する。

- ダウングレード攻撃（既知脆弱性のある古い正規 build へ戻させる）
- クロスホスト混同（同じ鍵で署名された別ホスト構成を掴ませる）
- メタデータ詐称（git_rev などを偽る）

manifest に署名を付けると、復元側が取り出す前に「正規 publisher が作った改ざんされていない対応付け」を検証できる。
ただし `latest` は可変なので、署名 + **freshness（timestamp / 単調増加カウンタ）** で古い署名済み manifest のリプレイも防ぐ必要がある。

**決定: 署名なし**（個人用・publish も自分のみ・TLS + Worker を信頼する前提）。
将来 複数人共有 / public cache にする場合のみ **署名 + freshness** を再検討する。

### TODO

- [x] manifest（manifest.json）の JSON フォーマット確定 — `src/publish/types.ts` の `PublishPayload.manifest`（`ManifestMeta` 型）で定義済み。`host` / `system` / `gitRev` / `flakeLockHash` / `toplevelStorePath` / `closureJsonKey` / `manifestKey` / `manifestHash` フィールドを持つ。
- [ ] （任意）`nix-shell` / `npx` で動く薄い復元スクリプト
- [ ] （将来 public cache 化する場合のみ）manifest 署名 + freshness の方式決定

---

## 3. NAR 配信方式（決定済み: Worker 経由）

**決定: A（Worker 経由 / Cache API + R2 streaming）を採用。**
理由は、認証・統計・rate limit・ヘッダ整形を配信パスに挟みたいため。
B（R2 Custom Domain + Cache Rules + Tiered Cache）は広域ヒット率では有利だが、
パブリック blob 配信に最適化されており認証を足すと結局 Worker が前段に必要になるため見送る。

受容するトレードオフ:

- Cache API はオリジン data center 外へ自動複製されず tiered caching 非対応 → 広域ヒットは B 比で弱い
- edge cache の cacheable size 上限（Free/Pro/Business 512MB、Enterprise 既定 5GB）超の巨大 NAR は cache に乗らず都度 streaming

採用に伴う実装課題（spec section 6.2 に方針記載済み、詳細はここで詰める）:

### TODO

- [x] HEAD / `Range: bytes=...` / `ETag` / `Content-Length` の自前実装 — 実装済み（`handlers/nar.ts`）。`parseSingleRange` で `bytes=start-end` / `bytes=start-` / `bytes=-suffix` を解析し 206 を返す。範囲外は 416。HEAD は body なしで `Content-Length` / `ETag` / `Accept-Ranges` を返す。
- [x] R2 binding の range option を使った部分取得 — 実装済み（`handlers/nar.ts`）。`r2.getObject(env, key, { range: parsed.range })` で部分取得。suffix range も 206 化。
- [ ] 巨大 NAR（>512MB）の streaming 経路の検証（cache miss 前提の挙動）
- [x] `.nar.zst` を `Content-Encoding` ではなく bytes そのまま返す確認 — 実装済み（`handlers/nar.ts`）。`content-type: application/x-nix-nar` で返し、`Content-Encoding` ヘッダは付けない。
- [x] Cache API のキャッシュキー設計（immutable / long TTL） — 実装済み（`handlers/nar.ts`）。`cache-control: public, max-age=31536000, immutable` を付与。206 レスポンスはキャッシュに載せない。
- [ ] （将来）広域ヒット率が問題化したら B へ移行 or 併用を再検討

---

## 4. R2 quota kill-switch の精度改善

### TODO

- [ ] R2 storage の GB-month 厳密計算（現状: 月内 `payloadSize` の max で近似）
- [ ] L0 伝播の epoch 化リファクタ
