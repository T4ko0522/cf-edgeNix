# 0001: 完全なclosureを記録し、所有するpathだけを保存する

## Status

Accepted

## Context

2026-09-24に共有されたpublish runの調査では、`/nix/store`と全closureの圧縮NARを同時に保持してrunnerのディスクを使い切った。4116 pathのうち3574 pathがupstreamにあり、全件をNAR化してから除外していた。`/nix/store`のActions cacheを外したrunはpublishに成功した。この集計値のrun URLはこのrepositoryには記録されていない。

`nix copy --no-recursive` で選択pathだけを別cacheへコピーすると、参照先がそのcacheにない場合に失敗する。依存graph自体を縮小することはできない。

## Decision

- hostごとの完全なclosureを`closure.json`に保持する。
- 実効Nix substituterとself cacheを照会し、各pathを`external`、`self-existing`、`new`に分類する。self cacheは外部候補から除く。
- `new`だけをNAR化して署名narinfoを作る。参照先がstageにないpathも扱えるよう、NixのNAR出力・署名・path metadataを使う。
- manifest v2は`closure.owned`と`closure.external`を記録する。`self-existing`と`new`はownedであり、D1の`build_closure`とGCの管理対象にする。externalはD1へingestしない。
- publish jobの`/nix/store` Actions cacheは使わない。

## Consequences

- NAR生成量と一時ディスク使用量はnew pathに比例する。build時間はこの変更の対象外。
- external pathの復元には、記録した外部substituterが引き続き利用できる必要がある。
- self cacheの一時的な照会失敗ではnewとしてstageする。self-existingと判定したNARがR2にない場合はfinalize前に失敗させる。
- 旧manifestの`storePaths`もGC backfillで読めるよう維持する。既存D1行は自前R2に保存されたpathだけなのでschema migrationは不要。

## Adoption

- publish planの分類がfull closureを重複・欠落なく分割することを検証する。
- newだけがNAR upload対象、ownedだけがD1 ingest/GC対象、externalがmanifestだけに残ることをテストする。
- CIと運用文書は`availability`・`stage`・`publish`の所要時間を分けて示す。
