# About cf-edgeNix
# Cloudflare NativeなNixOS Binary Cache基盤の構想

## 1. テーマ

本構想は、NixOSやNix flakesによって定義された環境を、誰でも・どこでも・すぐに再現できるようにするための、自前Binary Cache基盤の設計である。

NixOSはOS構成や開発環境を宣言的に管理できるため、同じ設定から同じ環境を再現しやすい。しかし実際には、初回構築や`nixos-rebuild`時に大量のderivationをローカルでビルドする必要があり、環境が完成するまでに時間がかかる。

そこで、GitHub ActionsでNixOS構成を事前にビルドし、その成果物をCloudflareエコシステム上にglobal binary cacheとして配置する。これにより、ローカル環境では重いビルドを避け、Cloudflare上のcacheから成果物を取得して高速に環境を復元できるようにする。

一言で表すと、

> 再現可能なNixOS環境を、すぐ使えるNixOS環境にする。

ための構想である。

---

## 2. 背景と課題

NixOSやNix flakesを使うことで、OS設定・パッケージ・サービス・dotfilesなどをコードとして管理できる。

これにより、理論上は以下のようなことが可能になる。

* 新しいマシンで同じ環境を再現する
* 壊れた環境を以前の状態に戻す
* 複数端末で同じNixOS構成を共有する
* dotfilesリポジトリをcloneして環境を復元する

しかし、実際には次の課題がある。

* `nixos-rebuild`が遅い
* 初回構築時に大量のビルドが走る
* cache missするとローカルCPUに負荷がかかる
* マシン性能やネットワーク環境によって復元体験が変わる
* ローカルでGCした後、過去generationへのrollbackが難しくなることがある
* GitHub Actions上でビルドしても、その成果物をNix client向けに継続配布する仕組みが別途必要になる

つまり、NixOSは「設定の再現性」は高いが、「すぐ使える状態までの再現性」にはまだ課題がある。

---

## 3. 解決方針

解決方針は、NixOSのビルド成果物をローカルで作るのではなく、CIで事前に作り、それをglobal binary cacheとして配布することである。

全体の流れは以下の通り。

```text
GitHub Actions
  ↓
NixOS system closureをビルド
  ↓
Cloudflare R2へNAR本体を保存
  ↓
Workers KV / D1にメタデータを配置
  ↓
Cloudflare WorkersがNix binary cache endpointとして配信
  ↓
ローカルのnixos-rebuildがsubstituterとして利用
```

ローカルでは、次のようにbinary cacheを指定する。

```nix
{
  nix.settings = {
    extra-substituters = [
      "https://nix-cache.example.com"
    ];

    extra-trusted-public-keys = [
      "nix-cache.example.com-1:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="
    ];
  };
}
```

これにより、ローカルの`nixos-rebuild`は可能な限りビルド済み成果物をCloudflare上のcacheから取得する。

---

## 4. この構想の本質

この構想は、単に「NixOSのビルドを速くする」だけではない。

より本質的には、

> 一般的なNix binary cache serverを、Cloudflare Workers / KV / D1 / R2でCloudflare Nativeに再構築する

という試みである。

Nix binary cacheに必要な主な要素は以下である。

```text
nix-cache-info
<store-hash>.narinfo
nar/<file-hash>.nar.zst
```

ここで `<file-hash>` は圧縮済み `.nar.zst` の FileHash であり、store path hash や未圧縮 NAR の NarHash とは別物である（後述の D1 schema で厳密に分ける）。

これらをCloudflareの各サービスに割り当てる。

| 要素               | 役割                                              |
| ---------------- | ----------------------------------------------- |
| GitHub Actions   | NixOS system closureをビルドする（signed publisher）    |
| R2               | NAR本体と`.narinfo`の正本（source of truth / read path の終点） |
| Workers KV       | `.narinfo`や`nix-cache-info`の速度層（結果整合。正本ではない）    |
| D1               | build履歴・latest pointer・rollback root・GC live setのcontrol plane（read path には載せない） |
| Workers          | Nix client向けHTTP binary cache gateway + 管理API    |
| Cloudflare Cache | NAR本体やレスポンスのedge cache                          |
| Worker memory    | 直近アクセスされたメタデータのL0キャッシュ                          |

この構成により、Cloudflare上に小さなNix cache serviceを構築する。

---

## 5. アーキテクチャ

全体構成は以下のようになる。

```text
                       ┌────────────────┐
                       │ GitHub Actions │
                       └───────┬────────┘
                               │ nix build / nix copy --to file://
                               ▼
                       ┌────────────────┐
                       │ Publish Step   │
                       └───────┬────────┘
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   ┌────────────┐       ┌────────────┐       ┌────────────┐
   │ R2          │       │ Workers KV │       │ D1          │
   │ 正本         │       │ 速度層      │       │ control     │
   │ NAR/narinfo│       │ narinfo    │       │ build/GC    │
   └─────┬──────┘       └─────┬──────┘       └─────┬──────┘
         │  read path          │                    │ 管理API
         │  memory→KV→R2       │                    │ publish/rollback/GC
         └──────────┬──────────┘                    │
                    ▼                                │
              ┌────────────┐ ◀───────────────────────┘
              │ Workers    │
              │ Gateway    │
              └─────┬──────┘
                    ▼
            local nixos-rebuild
```

read path（narinfo / nix-cache-info）は `memory → KV → R2` で完結し、D1 を挟まない。D1 は publish / rollback / GC / manifest の control plane として、管理API側からのみ参照する。

---

## 6. キャッシュ階層

メタデータとNAR本体では扱いを分ける。

### 6.1 メタデータ

メタデータは「Nix protocol 上のキャッシュデータ」と「control plane の管理情報」に分けて扱う。

Nix protocol 上のメタデータ（read path で大量に引かれる）:

```text
nix-cache-info
<store-hash>.narinfo
```

これらは R2 上に決定的キー（`<store-hash>.narinfo` など）で保存し、store hash から lookup なしに直接引ける。
そのため read path に D1 を挟まず、次の経路で返す。

```text
GET /<hash>.narinfo
  Worker memory
    ↓ miss
  Workers KV
    ↓ miss
  R2 (deterministic key)
    ↓ miss
  404
```

役割は以下の通り。

```text
L0: Worker memory
  直近アクセスされたnarinfoを一時保持する

L1: Workers KV
  narinfo / nix-cache-info を高速に返す速度層
  結果整合なので「正しさ」には使わない（正本ではない）

L2: R2
  narinfo / NAR本体の正本（source of truth）
```

control plane の管理情報（read path には載せない）:

```text
host -> latest build
git rev -> toplevel store path
build履歴 / rollback root / GC live set
```

これらの正本は D1 に置く。`host -> latest` のような可変ポインタは D1 を正本とし、
KV へ置く場合も表示・高速化用のコピーに留める。

重要なのは、**KV miss 時に D1 へ落とさないこと**。
理由は、`nixos-rebuild` が1回で大量の `.narinfo` を引くため、KV miss が D1 へ雪崩れ込むと
D1 が control plane ではなく hot metadata server に転落するからである。
Nix protocol 上の metadata は原則 R2 から復元し、D1 は publish / rollback / GC / manifest 管理に限定する。

> KVは真実ではなく、速い噂。真実はR2とD1に置く。

---

### 6.2 NAR本体

NAR本体は大きいため、memory / KV / D1には載せない。

NAR 配信は **Worker 経由**に決定する。Worker 内で認証・統計・rate limit・ヘッダ整形を挟めることを優先する。

```text
GET /nar/<file-hash>.nar.zst
  Cloudflare Cache (Cache API)
    ↓ miss
  R2 binding (ReadableStream)
    ↓ stream
  Nix client
```

R2 object body は `ReadableStream` で返し、Worker 上で NAR を丸ごとメモリに載せない（isolate は 128MB 制限）。

採用にあたっての注意点:

- Cache API はオリジン data center 外へ自動複製されず、tiered caching とは互換でない。グローバルな広域ヒットは R2 Custom Domain ほど効かない点は受容する。
- edge cache の cacheable size 上限（Free/Pro/Business 512MB、Enterprise 既定 5GB）を超える巨大 NAR は cache に乗らず、R2 から都度 streaming になる。
- HTTP gateway として HEAD / `Range: bytes=...` / `ETag` / `Content-Length` を自前で実装する（R2 binding の range option を使う）。
- `.nar.zst` / `.nar.xz` は HTTP `Content-Encoding` ではなく Nix binary cache 上の圧縮済みファイルとして扱い、bytes をそのまま返す（HTTP decompression を効かせない）。

R2 は Custom Domain や public_bucket で直接公開しない。配信は Worker 経由に限定することで quota kill-switch（docs/quota.md）を効かせる。

---

## 7. D1の役割

当初の考えとして、D1は「R2へのリンクを貼るためのもの」として使う。

これは正しいが、最終的にはそれ以上の役割を持たせる。

D1には以下の情報を持たせる。

store path と NAR は build をまたいで共有されるため、`nar_objects` 1テーブルに `build_id` を持たせて所有させるのではなく、`store_paths` / `nar_files` / `build_closure` に分割する。

**schema の正本は `src/db/schema.ts`（Drizzle ORM 定義）である。** 以下の SQL は概念説明用であり、実際の DDL は `migrations/0001_init.sql`（drizzle-kit 生成）を参照すること。

```sql
builds(
  id,
  host,
  system,
  git_rev,
  flake_lock_hash,
  toplevel_store_path,
  status,
  retention_class,
  created_at,
  published_at
);

-- store path 単位のメタ。build をまたいで共有されるため build_id では所有しない。
store_paths(
  store_hash,            -- /nix/store/<hash>-name の先頭hash（narinfoキー）
  store_path,
  narinfo_key,           -- R2上の .narinfo key
  nar_key,               -- R2上の NAR key
  nar_hash,              -- 未圧縮NARのhash
  nar_size,
  file_hash,             -- 圧縮済み .nar.zst のhash（nar/<file_hash>.nar.zst）
  file_size,
  compression,
  first_seen_build_id,   -- 最初に観測したbuild（所有ではなく由来）
  created_at
);

-- 圧縮済みNARファイル単位。content-addressed。
nar_files(
  file_hash,
  nar_key,
  file_size,
  compression,
  created_at
);

-- build と、その closure に含まれる store path の多対多。
build_closure(
  build_id,
  store_hash
);

rollback_roots(
  id,
  host,
  build_id,
  reason,
  pinned,
  keep_until,
  created_at
);

-- 過去世代を remote から復元するための「引換票」。
-- rollback_roots が R2 に在庫を残す役割なのに対し、
-- build_manifests は「どの toplevel store path を取り出せばよいか」を記録する。
build_manifests(
  build_id,
  host,
  system,
  git_rev,
  flake_lock_hash,
  toplevel_store_path,   -- /nix/store/<hash>-nixos-system-... 復元の頂点
  closure_json_key,      -- R2上の closure.json
  manifest_key,          -- R2上の manifest.json
  manifest_hash,
  created_at
);
```

`store_hash` / `nar_hash` / `file_hash` を混同しないことが、GC や hash mismatch 調査の前提になる。

| 名前          | 意味                               |
| ----------- | -------------------------------- |
| `store_hash`  | `/nix/store/<hash>-name` の先頭hash |
| `nar_hash`    | 未圧縮NARのhash                      |
| `file_hash`   | 圧縮済み `.nar.zst` などのhash          |
| `nar_key`     | R2上のobject key                   |
| `narinfo_key` | R2上の `.narinfo` key              |

D1は以下を管理する。

* buildの成功履歴と hostごとの latest build（正本）
* rollback可能なbuild / 手動pinされた安定世代
* 過去世代を remote から復元するための manifest（`build_manifests`）
* GCしてよい / 守るべき R2 object の判定（live set）
* system closureに含まれるstore path一覧

つまりD1は単なるリンク集ではなく、remote binary cacheにおけるcontrol planeになる。

manifest の配信は管理 API として行う。

```text
GET /api/hosts/<host>/builds
GET /api/hosts/<host>/latest
GET /api/builds/<build_id>/manifest.json
```

なお manifest 自体には署名を付けない（決定）。理由と、将来 public cache 化する場合に署名 + freshness を再検討する判断軸は `fixme.md` を参照。

> GC の削除順序は本 spec では未確定。`fixme.md` を参照。

---

## 8. Rollback対応

この構成では、最新のビルドだけでなく、過去の成功ビルドもrollback用に保持する。

目的は以下である。

* 最新構成が壊れたときに戻せる
* ローカルでGCした後でも過去世代を再取得できる
* 別マシンでも同じ過去revisionへ復元できる
* dotfilesの特定git revisionを復旧点として扱える

D1上にrollback rootを持ち、保持対象buildのclosureを削除しないようにする。

保持ポリシーの例:

```text
always keep:
  - hostごとのlatest successful build
  - hostごとの直近N世代
  - 手動pinされたstable build

time-based keep:
  - 直近7日分の成功build
  - 直近4週間の週次代表build
  - 直近3か月の月次代表build

delete candidates:
  - failed build
  - staging中に中断されたobject
  - rollback rootから到達不能な古いNAR
```

重要なのは、R2 objectを単純に日付で削除しないこと。
Nix store pathは世代間で共有されるため、古いbuild由来に見えるNARが最新buildでも必要な場合がある。

そのため、D1上のrollback rootsから到達可能なclosureをlive setとして扱い、mark-and-sweep方式でGCする。

```text
rollback_roots
  ↓
builds
  ↓
build_closure
  ↓
live nar keys
  ↓
R2 GC対象判定
```

これにより、binary cacheを単なる高速化基盤ではなく、復旧可能な環境配布基盤として扱える。

なお、GC の **削除順序**（narinfo を先に unpublish → edge purge → grace period → NAR 削除）と rollback 復元用 manifest の設計は本 spec では未確定とし、`fixme.md` に課題として切り出す。

---

## 9. Publish手順

GitHub Actionsでビルドした成果物をCloudflareへpublishする。

`.narinfo` は自前生成せず、Nix 自身に binary cache 形式（署名 `Sig:` 込み）を作らせる。

```bash
set -euo pipefail

out="$(nix build ".#nixosConfigurations.${HOST}.config.system.build.toplevel" \
  --print-out-paths --no-link)"

nix path-info -r --json "$out" > closure.json

# 鍵を一時ファイルに書き出して nix copy に渡す（argv に秘密鍵を露出させない）
_key_file="$(mktemp)"
chmod 600 "$_key_file"
trap "rm -f '$_key_file'" EXIT
printf '%s' "$CACHE_PRIVATE_KEY" > "$_key_file"

# Nix が署名済み .narinfo と nar/<file-hash>.nar.zst を生成する
nix copy --to "file://${CACHE_DIR}?compression=zstd&secret-key=${_key_file}" "$out"
```

基本手順は以下。`scripts/publish.sh` が 1–3 を担い、`scripts/publish.ts`（bun）が 0・4–8 を担う。

```text
0. closure.json / manifest.json を R2 の manifests/<buildId>/ 配下に put（冪等・決定的 buildId）
1. nix build で NixOS system closure をビルド
2. nix copy --to "file://..." で署名済み .narinfo と NAR を Nix に生成させる
3. closure を列挙（nix path-info -r --json）
4. NAR本体（nar/<file-hash>.nar.zst）を R2 へ upload（重複 narKey はスキップ）
5. すべての NAR upload 完了を確認してから次へ
6. .narinfo を R2 へ upload
7. D1 確定（3 段状態遷移）:
     POST /api/publish/start          → staging build 作成（latest 不変）
     POST /api/publish/:id/ingest × N → store_paths を chunk 分割で冪等投入
     POST /api/publish/:id/finalize   → build_manifests insert + published + latest 更新（1 batch）
8. KV を warming（最後・失敗は警告のみ）
```

重要なのは公開順序である。

```text
NAR本体（R2）
  ↓
.narinfo（R2）
  ↓
D1 で published / latest を確定（control plane の正本）
  ↓
KV を warming（速度層・最後）
```

`.narinfo`を先に公開すると、Nix clientがまだ存在しないNARを取りに行って404になる可能性がある。
また KV は最後に warming する。KV は発表用のテープカットであって正本ではないため、D1 で published を確定してから速度層へ反映する。

`latest` pointer が更新されるのは `POST /api/publish/:id/finalize` の 1 ステップのみ。
`start` / `ingest` 途中で中断しても read path（narinfo / NAR）には影響しない。

詳細な運用手順・冪等再実行・トラブルシューティングは `docs/publish.md` を参照。

---

### 9.1 署名鍵・認証・サプライチェーン

binary cache の真正性は署名鍵に依存する。Nix は NAR / narinfo を `trusted-public-keys` で検証するため、鍵の扱いを設計に明記する。

```text
private key（NAR署名用）:
  - nix copy の secret-key として使用（秘密鍵の値は argv に渡さず一時ファイル経由で渡すこと）
  - GitHub Actions の secret / protected environment に置く
  - fork からの PR では絶対に露出させない

public key:
  - client の trusted-public-keys へ配布
  - cache name に suffix を付け、-1 / -2 で rotation 可能にする

key rotation:
  - 新旧 public key を一定期間併用してから旧鍵を外す

Cloudflare token（publish用）:
  - R2 write / KV write を最小権限で分離（wrangler CLI が参照する CLOUDFLARE_API_TOKEN）
  - D1 write は Worker 側の Drizzle batch（POST /api/publish/*）で行うため、
    publish スクリプトは D1 直接操作用トークンを持たない

latest / rollback API の保護:
  - NAR / narinfo は Nix が署名検証するが、
    「どの build を latest と呼ぶか」は Worker/D1 のアプリロジックであり
    Nix の署名検証の外側にある
  - write 系（POST /api/publish/*・rollback・gc/dry-run）は ADMIN_TOKEN による Bearer 認証で保護
  - ADMIN_TOKEN 未設定時は write 系を 403 で拒否（安全側）
  - read 系（GET）は認証不要（nixos-rebuild から直接叩かれるため）
```

---

## 10. Workerのリクエスト処理

想定するリクエスト処理は以下。

```text
GET /nix-cache-info
  → memory
  → KV
  → R2

GET /<hash>.narinfo
  → memory
  → KV
  → R2 (deterministic key)
  → 404

GET /nar/<file-hash>.nar.zst
  → Cloudflare Cache
  → R2 streaming
```

`.narinfo` などのメタデータは `memory → KV → R2` で返し、read path に D1 を挟まない。
NAR本体は Worker 経由で R2 から streaming で返し、Cache API に乗せる（HEAD / Range / ETag を自前実装する）。
管理系（`/api/hosts/<host>/latest`、`/api/builds/...`、rollback、GC、publish 確定）のみ D1 を参照する。

管理系エンドポイント一覧（read: 認証不要 / write: Bearer 必須）:

```text
GET  /api/hosts/:host/latest              read  host の latest published build
GET  /api/hosts/:host/builds              read  build 履歴
GET  /api/builds/:id/manifest.json        read  復元用 manifest
GET  /api/openapi.json                    read  OpenAPI 3.0 スキーマ（hono/zod-openapi 自動生成・認証不要）

POST /api/publish/start                   write  staging build 作成（latest 不変）
POST /api/publish/:build_id/ingest        write  store_paths を chunk 分割で冪等投入
POST /api/publish/:build_id/finalize      write  D1 published 確定 + latest 更新（1 batch）
POST /api/hosts/:host/rollback            write  rollback root 登録
POST /api/gc/dry-run                      write  GC live-set 計算（実削除はしない）
```

---

## 11. GitHub Actionsのみでcacheを配布する場合との差別化

GitHub Actionsのみでも、build artifactやcacheを保存することはできる。
しかし、それは主にCI内での再利用や成果物保存に向いている。

この構成との差は以下である。

| 観点           | GitHub Actionsのみ       | Cloudflare Binary Cache構成        |
| ------------ | ---------------------- | -------------------------------- |
| 主目的          | CI内のcache / artifact保存 | Nix client向けのglobal binary cache |
| 配布形式         | artifact/cache中心       | `substituter`として直接利用             |
| NAR配信        | 工夫が必要                  | R2 + Cloudflare Cacheで自然に配布      |
| `.narinfo`配信 | 設計が必要                  | KV / Workerで高速配信                 |
| rollback保持   | retention制限に影響されやすい    | D1で明示的にpolicy管理                  |
| GC           | artifact単位になりがち        | closure単位でmark-and-sweep可能       |
| 独自API        | 作りにくい                  | Workerで作れる                       |
| 管理情報         | Actions logs中心         | D1でbuild/rollback/GCを管理          |

一言で言えば、

```text
GitHub Actionsのみ:
  CIの中でcacheする

Cloudflare構成:
  CIで作ったcacheを、Nix client向けのglobal binary cache serviceとして配布・保持・管理する
```

という違いである。

---

## 12. この構想の価値

この構想の価値は、単なる高速化だけではない。

主な価値は以下。

* ローカルのビルド時間を削減できる
* 新しいマシンでも短時間で同じ環境を復元できる
* dotfilesをcloneしてすぐ環境を構築しやすくなる
* Cloudflare edgeによりglobalに成果物を配布できる
* rollback用の過去世代を保持できる
* D1でretention policyやGCを制御できる
* Workersで認証・統計・管理APIを追加できる
* NixOS構成を「設計図」だけでなく「即時復元キット」として扱える

つまり、

> 設定だけでなく、ビルド済み成果物まで含めて配布することで、NixOS環境の再現性を体験として完成させる。

ことを目指している。

---

## 13. 発表タイトル案

### 第一候補

**NixOS環境をどこでも即再現するCloudflare Binary Cache構想**
GitHub Actionsでビルドし、R2/KV/D1で配布・保持・rollbackする

### 技術寄り

**Cloudflare NativeなNix Binary Cache基盤の設計**
Workers・KV・D1・R2で一般的なNix cache serverを再構築する

### キャッチー寄り

**再現可能な環境を、すぐ使える環境にする**
CloudflareでつくるNixOS Binary Cache Platform

### 抽象度高め

**Reproducible NixOS, Instant Everywhere**
CloudflareエコシステムによるBinary Cache配布基盤の設計

---

## 14. 発表の中心メッセージ

この発表の中心メッセージは以下である。

> NixOSは環境をコードとして再現できるが、ビルドが遅いと「すぐ再現できる」とは言いにくい。そこで、GitHub Actionsで事前にビルドした成果物をCloudflare上のglobal binary cacheとして配布し、誰でも・どこでも・すぐ同じNixOS環境を復元できる仕組みを考える。

さらに短くすると、

> 再現可能な環境を、すぐ使える環境にする。

である。

---

## 15. まとめ

本構想は、NixOSの遅いビルドをCloudflare上のbinary cacheによって高速化するだけでなく、環境の即時再現性とrollback可能性を高めるための基盤である。

GitHub Actionsを signed builder、R2を NAR / narinfo の正本かつ read path の終点、KVを`.narinfo`の速度層、D1を build履歴・latest pointer・rollback root・GC live set の control plane、WorkersをNix client向けgateway + 管理APIとして使う。read path（narinfo）は `memory → KV → R2` で完結させ、D1 は挟まない。

これにより、一般的なNix binary cache serverをCloudflare Nativeに再構築し、dotfilesやflakeで定義されたNixOS環境を、どこでも短時間で復元できるようにする。

最終的な構成は以下である。

```text
build:
  GitHub Actions（nix copy で署名済み narinfo / NAR を生成）

metadata read path:
  Worker memory → Workers KV → R2（D1 は挟まない）

control plane:
  D1（build履歴 / latest pointer / rollback root / GC live set）

large blobs:
  Worker → Cache API → R2 streaming（HEAD / Range / ETag は自前実装）

retention / GC:
  D1 policy + R2 mark-and-sweep（削除順序は fixme.md）

client:
  nixos-rebuild using substituters
```

これは、単なる「NixOS高速化」ではなく、

> Cloudflare NativeなNix Binary Cache Platform

を作る構想である。
