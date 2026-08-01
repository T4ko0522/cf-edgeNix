# publish 運用手順

cf-edgeNix の publish は「nix copy でローカルに生成した binary cache を、R2/D1/KV へ決まった順序で反映する」一連の処理である。

publish を実行する主体は GitHub Actions（`publish.yml`）だが、手動実行やデバッグにも使う。

---

## 前提: 必要な環境変数・Secret

publish 実行に必要な値は、性質が違う 2 つに分かれる。

### A. 呼び出し側 repo に登録する Secret / Variable

GitHub Actions の Environment (`production`) に事前登録する値。

| 変数名 | 種別 | 説明 |
| --- | --- | --- |
| `CACHE_PRIVATE_KEY` | Secret | NAR / narinfo の署名秘密鍵。`nix copy` が `Sig:` フィールドに書き込む。 |
| `ADMIN_TOKEN` | Secret | Worker 管理 API（write 系）の Bearer トークン。 |
| `CLOUDFLARE_API_TOKEN` | Secret | KV write 権限を持つ Cloudflare API トークン。 |
| `R2_ACCESS_KEY_ID` | Secret | R2 S3 互換 API のアクセスキー。 |
| `R2_SECRET_ACCESS_KEY` | Secret | R2 S3 互換 API のシークレットキー。 |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare アカウント ID。 |
| `API_BASE_URL` | Variable | デプロイ済み Worker の URL（例: `https://cf-edgenix.<account>.workers.dev`）。 |
| `R2_BUCKET_NAME` | Variable | R2 バケット名（例: `cf-edgenix-nar`）。 |
| `KV_NAMESPACE_ID` | Variable | KV 名前空間 ID。 |

- Secret 類は `protected environment: production` の Environment Secrets に置く（fork PR からアクセス不可）。
- Variable 類は Environment Variables または Repository Variables に置く。
- ローカル開発では `.dev.vars` に `ADMIN_TOKEN` を書くことで write 系 API を叩ける。

### B. workflow / スクリプトが実行時に渡す値

呼び出しごとに変わる値。Secret/Variable として登録するものではなく、workflow input やスクリプト引数で渡す。

| 変数名 | 用途 |
| --- | --- |
| 位置引数 / `HOST` | 対象の nixosConfiguration 名。複数は位置引数、単一は従来どおり `HOST` でも指定可能。両方の同時指定は不可。 |
| `CACHE_DIR` | 全対象で共有する `nix copy --to file://` の出力先。既存ファイルの混入を防ぐため、実行開始時に空でなければならない。 |

---

## publish の全体フロー

```
全 host を単一 nix build            ← NixOS system closure をビルド
  ↓
nix copy --to file://$CACHE_DIR       ← 署名済み .narinfo と nar/*.nar.zst を生成
  ↓
scripts/prune-upstream.sh             ← cache.nixos.org に既にある path を除外
  ↓
scripts/publish.ts --plan <JSON>      ← R2/D1/KV への一括反映
  │
  ├── Step 0: 全 host の D1 start → ingest（staging closure を先に GC 保護）
  ├── Step 1: host 別 closure.json / manifest.json を R2 に put
  ├── Step 2: NAR upload (R2)
  ├── Step 3: narinfo upload (R2)
  ├── Step 4: host ごとに D1 finalize（latest 更新）
  └── Step 5: 全 host の和集合を KV warming（1回、失敗は警告のみ）
```

`scripts/publish.sh` は全hostを一度の build / copy / upstream prune で処理し、秘密情報を含まない一時publish planを `scripts/publish.ts` へ渡す。共有 `CACHE_DIR` は一度だけ走査される。各hostのmanifestは `host closure ∩ prune後のnarinfo` で作り、他host専用pathを混入させない。全pathがupstreamにあるhostは空closureとしてfinalizeする。

### upstream prune（R2 容量節約）

`nix copy` は closure 全体（nixpkgs 由来の path を含む）を `CACHE_DIR` に吐く。これをそのまま R2 に上げると、cache.nixos.org に既にある path で容量を浪費する。

`scripts/prune-upstream.sh` は `CACHE_DIR` 直下の各 `<storeHash>.narinfo` について `https://cache.nixos.org/<storeHash>.narinfo` を HEAD で確認し、200 を返す **narinfoだけ**を削除する。NAR本体は別のstore pathから共有される可能性があるため削除しない。`publish.ts` は残ったnarinfoを起点にR2/D1/KVへ反映する。

Nix client 側は `extra-substituters = [ "https://nix.t4ko.pet" ];` のように cf-edgeNix と cache.nixos.org の **両方**を持つ前提なので、自前 cache に無い path は upstream から fetch される。`docs/setup.md` の C4 設定が守られていれば破綻しない。

挙動制御:

| 環境変数 | 既定 | 用途 |
| --- | --- | --- |
| `UPSTREAM_CACHE_URL` | `https://cache.nixos.org` | 対象 substituter URL（自前で複数階層 cache を運用するときに使用） |
| `SKIP_UPSTREAM_PRUNE` | `0` | `1` にすると prune ステップを丸ごとスキップ（デバッグ用） |
| `PRUNE_CONCURRENCY` | `32` | 並列 curl 数 |
| `PRUNE_TIMEOUT` | `5` | 1 リクエストの最大秒数 |

upstream が不通の場合（DNS NXDOMAIN / timeout / 5xx 等）は **削除しない**（=「無い扱い」ではなく「不明扱い」で安全側に倒す）。結果として R2 容量節約は効かないが、誤って必要な NAR を消す事故は起きない。

---

## 状態遷移: staging → ingest → finalize

publish の D1 確定は 3 段の状態遷移になっている。

```
POST /api/publish/start
  → builds テーブルに status='staging' 行を作成
  → latest は変わらない（read path に影響なし）

POST /api/publish/:build_id/ingest  （最大15件、chunk を分けて複数回呼べる）
  → store_paths / nar_files / build_closure を upsert
  → 同一 store_hash の NAR メタデータが変わった場合は最新 narinfo に更新
  → staging 状態の build にのみ適用可能

POST /api/publish/:build_id/finalize
  → build_manifests に manifest 情報を insert
  → builds.status を 'published'、published_at を更新
  → latest pointer を更新（1 つの db.batch() で atomic）
  → これが latest を動かす唯一の地点
```

`latest` が更新されるのは `finalize` のみ。`start` や `ingest` の途中で中断しても read path には影響しない。

### 冪等性

- 同一 `build_id` で `start` を再実行 → staging のままなら冪等に 200 を返す。
- 同一 `build_id` で `ingest` を再実行 → 同一 payload は冪等、同一 `store_hash` の NAR メタデータ差分は最新 narinfo に更新。
- 同一 `build_id` で `finalize` を再実行 → manifest が同一なら冪等に 200、差分があれば 409 を返す。
- NAR upload は `narKey`（`nar/<file-hash>.nar.zst`）が content-addressed なので、存在する場合は上書きしても安全（同一内容）。重複 `narKey` を持つ narinfo は Set でまとめてから upload する。

---

## 公開順序の保証と理由

```
D1 start / ingest（staging closure を GC 保護）
  ↓
host 別 manifest (R2)
  ↓
NAR 本体 (R2)
  ↓  ← narinfo が先だと Nix client が存在しない NAR へ 404 を起こす
.narinfo (R2)
  ↓
D1 で published / latest を確定（control plane の正本）
  ↓  ← KV は結果整合・速度層なので D1 確定後に warming
KV warming
```

この順序を破ると:
- `.narinfo` が先に見えると Nix client が NAR を取りに行って 404 になる。
- KV を D1 より先に更新すると、R2 には NAR がないのに KV には narinfo が載る中間状態が生まれる。

`scripts/publish.ts` はこの順序をコードで保証し、`test/publish/publish-script.test.ts` で staging closure が R2 より先、finalize が R2 より後になることを検証している。

---

## KV warming 失敗時の扱い

KV warming は `try/catch` で包まれており、失敗しても publish 全体を失敗にしない。

理由: `finalize` で D1 の `published` 確定が済んでいるため、KV にデータがなくても read path は KV miss → R2 へフォールバックして正しく応答できる。KV warming は速度層の充填であり、正本（R2/D1）が生きていれば機能上問題ない。

KV warming に失敗した場合はログに `[KV] warming failed (non-fatal):` と警告が出る。read path は R2 fallback で動作するため復旧操作は必須ではない。現時点では KV warming だけを再実行する専用コマンドはない。

---

## 手動実行

```bash
# nix develop 内で実行すること。CACHE_DIR は空にする。
mkdir -p /tmp/nix-cache
CACHE_DIR=/tmp/nix-cache \
CACHE_PRIVATE_KEY="$(cat /path/to/cache-private-key.pem)" \
ZSTD_LEVEL=9 \
API_BASE_URL=https://cf-edgenix.<account>.workers.dev \
ADMIN_TOKEN=your-token \
R2_BUCKET_NAME=cf-edgenix-nar \
KV_NAMESPACE_ID=<kv-namespace-id> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<kv-write-token> \
R2_ACCESS_KEY_ID=<r2-access-key> \
R2_SECRET_ACCESS_KEY=<r2-secret-key> \
bash scripts/publish.sh laptop desktop
```

単一hostは `HOST=myhost bash scripts/publish.sh` も引き続き利用できる。

`scripts/publish.sh` は内部で以下を順に実行する:
1. 全installableを単一の `nix build` でbuild
2. 各flake属性を `nix eval` し、hostとtoplevelを出力順に依存せず対応付け
3. host別closure JSONを生成
4. 全toplevelを単一の `nix copy` で共有 `CACHE_DIR` へ出力
5. upstream pruneを一度だけ実行
6. `bun scripts/publish.ts --plan <plan.json>` を一度だけ実行

`ZSTD_LEVEL` は Nix の binary cache store URL に渡す `compression-level` で、省略時は `9`（CI 時間と R2 サイズのバランス重視）。Nix 側の既定値を使いたい場合は `ZSTD_LEVEL=-1` を指定する。

`system` は各hostの `nixosConfigurations.<host>.pkgs.system` から取得する。`SYSTEM` を明示した場合だけ全targetへのoverrideとして扱う。

---

## GitHub Actions での実行

テンプレートの `Build, sign & publish` ステップが `bash scripts/publish.sh host1 host2` を一度だけ実行する。`workflow_dispatch.inputs.host` 指定時は単一引数になる。

必要な Secret / Variable は [§前提 A](#a-呼び出し側-repo-に登録する-secret--variable) に集約。テンプレートは `workflow_call`（別workflowからの再利用）と `workflow_dispatch`（手動実行・host入力）に対応する。

---

## 再 publish（冪等再実行）

`build_id` は `host:system:gitRev:flakeLockHash:toplevelStorePath` を SHA256 でハッシュした先頭 36 字から**決定的に生成**される。同一 commit・同一 host の再実行では必ず同一 `build_id` になる。

これにより、中断した staging publish は同じ条件で再開できる:
- `start` は既に staging なら冪等に 200 を返して保護期限を更新する。published / failed / pruned なら 409。
- `ingest` は同一 payload なら冪等に通過し、同一 `store_hash` の NAR メタデータ差分は最新 narinfo に更新する。
- `finalize` は既に published でも manifest が同一なら冪等に 200、差分があれば 409 を返す。

staging で中断した場合は、同じ条件で再実行すれば途中から続行できる。完了済み published build の再実行は `start` で 409 になる。環境変数 `BUILD_ID` を手動指定する仕組みは不要である。

batchの一部だけがfinalize後に失敗した場合、完了済みbuildへの再startは409になる。現行APIは複数host全体のatomicなlatest更新を保証しないため、未完了hostだけを単一引数で再実行する。

---

## 過去世代を GC する

GC は host ごとの最新 3 published 世代、pin、rollback root、作成から 24 時間以内の staging build を保持する。世代ごとの `build_closure.nar_key` を live-set の正本とし、同じ store hash の NAR が世代間で変化しても個別に判定する。

migration `0003_safe_generational_gc.sql` の適用直後は、旧 closure の `nar_key` が未解決である間、GC は fail-closed で全 NAR を live として扱う。`0004_gc_review_fixes.sql` は既存 build を `restorable=0` から開始して復元可否を永続化し、`build_closure.nar_key` の index を追加する。backfill が closure 全体の整合性を確認できた build だけを `restorable=1` にする。R2 manifest から参照を復元し、`closure_rows_remaining` が 0 になるまで backfill を繰り返す。

```bash
curl -X POST https://cf-edgenix.<account>.workers.dev/api/gc/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"max_rows":20}'
```

published build の manifest が欠落・破損している場合、D1 の `manifest_hash` と一致しない場合、または manifest 未作成の staging が24時間の保護期間内にある場合は `errors` に残る。manifest を持たない failed / pruned / 期限切れ staging は `closure_rows_pruned` として安全に整理される。`next_cursor` が返った場合は、次回リクエストの `cursor` に指定すると失敗行を飛ばして後続を処理できる。最終的には cursor なしで再実行し、`closure_rows_remaining` が 0 になることを確認する。

### dry-run

```bash
curl -X POST https://cf-edgenix.<account>.workers.dev/api/gc/dry-run \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

レスポンス:
```json
{
  "live_nar_keys": ["nar/abc123.nar.zst", ...],
  "dead_candidates": ["nar/old456.nar.zst", ...]
}
```

`dead_candidates` は保持対象 build から到達できない NAR の一覧。内容を確認してから二段階の削除を開始する。

`ingest` upsert で `store_paths.narKey` が最新 NAR に置き換わった場合、古い `nar_files` 行と R2 の `nar/<old-fileHash>.nar.zst` は `store_paths` からは辿れなくなる。GC は `store_paths.narKey` に加えて `nar_files.narKey` と `build_closure.narKey` も dead 判定源として走査する。orphan の grace を開始する前に、関連する R2 narinfo の `URL` が対象 NAR を指していないことを確認する。publish 途中で古い narinfo がまだ公開されている場合は tombstone を pending のまま残し、次回 batch で再確認する。

### Phase 1: narinfo を非公開化

```bash
curl -X POST https://cf-edgenix.<account>.workers.dev/api/gc/execute \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phase":"narinfo","max_deletes":10}'
```

`dead_remaining` が 0 になるまで繰り返す。処理済み NAR は `gc_marks` に記録されるため、次の呼び出しは未処理候補へ進む。

### Phase 2: 1時間後に NAR を物理削除

最後の Phase 1 実行から 1 時間以上待って実行する。API 自体も tombstone の時刻を検証するため、早く実行しても NAR は削除されない。

```bash
curl -X POST https://cf-edgenix.<account>.workers.dev/api/gc/execute \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phase":"nar","max_deletes":10}'
```

物理削除直前に live-set を再計算する。GC tombstone が付いた build への pin、rollback、ingest、finalize は 409 になるため、GC バッチ完了後に publish を再実行する。手動操作等で再び live になった NAR は削除対象から外れ、tombstone も破棄される。NAR が1件でも削除対象になった build は履歴上 `pruned` になり、manifest API の `restorable` が `false` になる。

---

## トラブルシューティング

### staging に止まった build がある

`finalize` が走っていない状態。原因は ingest 途中の中断、または finalize のネットワークエラー。

- `GET /api/hosts/<host>/latest` を確認し、latest が旧 build のままなら問題なし（read path は正常）。
- GC dry-run で当該 `build_id` に対応する NAR が `dead_candidates` に入るのを確認してから無視するか、同じ `build_id` で `finalize` だけ再送する。

### narinfo は見えるが NAR が 404 になる

publish の公開順序（NAR → narinfo）が守られていれば起きないはずだが、R2 upload が途中で失敗した場合に起こりうる。

- R2 に対象 NAR が存在するか確認: `wrangler r2 object get <bucket>/<nar-key> --head`。
- 存在しない場合は `publish.sh` を再実行して NAR を再 upload する（content-addressed なので安全）。

### KV に古い narinfo が残っている

KV は正本ではないため、古いデータが残っても読み取りは最終的に R2 へフォールバックする。緊急の場合は `wrangler kv key delete --namespace-id <id> narinfo:<store-hash>` で手動削除できる。
