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
| `CLOUDFLARE_API_TOKEN` | Secret | R2 write / KV write 権限を持つ Cloudflare トークン（wrangler CLI が参照）。 |
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
| `HOST` | publish 対象の nixosConfiguration 名（例: `myhost`）。`matrix.host` または `workflow_dispatch` input。 |
| `CACHE_DIR` | `nix copy --to file://` の出力先ディレクトリ。CI では `${{ runner.temp }}/nix-cache` など一時パス。 |

---

## publish の全体フロー

```
nix build                          ← NixOS system closure をビルド
  ↓
nix copy --to file://$CACHE_DIR       ← 署名済み .narinfo と nar/*.nar.zst を生成
  ↓
scripts/prune-upstream.sh             ← cache.nixos.org に既にある path を除外
  ↓
scripts/publish.ts                    ← R2/D1/KV への反映（以下の 5 段）
  │
  ├── Step 0: closure.json / manifest.json を R2 の manifests/<buildId>/ に put
  ├── Step 1: NAR upload (R2)
  ├── Step 2: narinfo upload (R2)
  ├── Step 3: D1 確定 (start → ingest × N → finalize)
  └── Step 4: KV warming（失敗は警告のみ）
```

`scripts/publish.sh` が nix build / copy / upstream prune を行い、続けて `scripts/publish.ts`（bun）に委譲して Step 0–4 を実行する。

### upstream prune（R2 容量節約）

`nix copy` は closure 全体（nixpkgs 由来の path を含む）を `CACHE_DIR` に吐く。これをそのまま R2 に上げると、cache.nixos.org に既にある path で容量を浪費する。

`scripts/prune-upstream.sh` は `CACHE_DIR` 直下の各 `<storeHash>.narinfo` について `https://cache.nixos.org/<storeHash>.narinfo` を HEAD で確認し、200 を返すものは narinfo と対応する `nar/<fileHash>.nar.zst` をローカル CACHE_DIR から削除する。`publish.ts` は CACHE_DIR を列挙して R2/D1/KV に反映するため、削除した分は **自動的に全レイヤから除外**される（D1 build_closure にも入らない）。

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

POST /api/publish/:build_id/ingest  （chunk を分けて複数回呼べる）
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
- 同一 `build_id` で `finalize` を再実行 → 既に published の場合は 409 を返す。
- NAR upload は `narKey`（`nar/<file-hash>.nar.zst`）が content-addressed なので、存在する場合は上書きしても安全（同一内容）。重複 `narKey` を持つ narinfo は Set でまとめてから upload する。

---

## 公開順序の保証と理由

```
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

`scripts/publish.ts` はこの順序をコードで保証し、テスト（`test/publish/order.test.ts`）でスパイにより `nar→narinfo→d1→kv` の順を assert している。

---

## KV warming 失敗時の扱い

KV warming は `try/catch` で包まれており、失敗しても publish 全体を失敗にしない。

理由: `finalize` で D1 の `published` 確定が済んでいるため、KV にデータがなくても read path は KV miss → R2 へフォールバックして正しく応答できる。KV warming は速度層の充填であり、正本（R2/D1）が生きていれば機能上問題ない。

KV warming に失敗した場合: ログに `[KV] warming failed (non-fatal):` と警告が出る。必要なら同じ `CACHE_DIR` で `scripts/publish.sh` を再実行すれば `build_id` は同一入力（`host:system:gitRev:flakeLockHash:toplevelStorePath`）から決定的に再現され、`start` と `ingest` は冪等に通過し、`finalize` が 409 を返した後 KV warming のみ再実行する形になる（現時点では KV warming だけを再実行する専用コマンドはないため、publish 全体を再実行する）。

---

## 手動実行

```bash
# nix develop 内で実行すること（bun は devShell が提供する）
HOST=myhost \
CACHE_DIR=/tmp/nix-cache \
CACHE_PRIVATE_KEY="$(cat /path/to/cache-private-key.pem)" \
ZSTD_LEVEL=9 \
API_BASE_URL=https://cf-edgenix.<account>.workers.dev \
ADMIN_TOKEN=your-token \
R2_BUCKET_NAME=cf-edgenix-nar \
KV_NAMESPACE_ID=<kv-namespace-id> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<r2-kv-write-token> \
bash scripts/publish.sh
```

`scripts/publish.sh` は内部で以下を順に実行する:
1. `nix build .#nixosConfigurations.<HOST>.config.system.build.toplevel`
2. `nix path-info -r --json <out> > closure.json`
3. `nix copy --to "file://$CACHE_DIR?compression=zstd&compression-level=$ZSTD_LEVEL&secret-key=$CACHE_PRIVATE_KEY" <out>`
4. `bun scripts/publish.ts`（R2/D1/KV 反映）

`ZSTD_LEVEL` は Nix の binary cache store URL に渡す `compression-level` で、省略時は `9`（CI 時間と R2 サイズのバランス重視）。Nix 側の既定値を使いたい場合は `ZSTD_LEVEL=-1` を指定する。

---

## GitHub Actions での実行

`.github/workflows/publish.yml` の `Build, sign & publish to R2/D1/KV` ステップが全 env を付与して `bash scripts/publish.sh` を実行する（publish.sh 内で publish.ts に委譲）。

必要な Secret / Variable は [§前提 A](#a-呼び出し側-repo-に登録する-secret--variable) に集約。workflow は `push: branches: [main]` および `workflow_dispatch`（手動実行・host 入力）でトリガーされる。

---

## 再 publish（冪等再実行）

`build_id` は `host:system:gitRev:flakeLockHash:toplevelStorePath` を SHA256 でハッシュした先頭 36 字から**決定的に生成**される。同一 commit・同一 host の再実行では必ず同一 `build_id` になる。

これにより:
- `start` は冪等に 200 を返す（既に staging 行が存在する場合も安全）。
- `ingest` は同一 payload なら冪等に通過し、同一 `store_hash` の NAR メタデータ差分は最新 narinfo に更新する。
- `finalize` は既に published の場合 409 を返して安全に終了する。

つまり、中断後に同じ条件で再実行すれば、完了済みのステップは冪等に通過し、途中から続行できる。環境変数 `BUILD_ID` を手動指定する仕組みは不要である。

---

## GC dry-run で dead_candidates を確認する

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

`dead_candidates` は `rollback_roots` から到達できない NAR の一覧。実 R2 物理削除は現時点では未実装（`fixme.md` §1 参照）。

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
