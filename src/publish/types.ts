// ─── publish ペイロード型 ────────────────────────────────────────────────────

/** .narinfo をパースした 1 エントリのメタ情報。 */
export interface NarinfoMeta {
  storeHash: string;
  storePath: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  fileSize: number;
  compression: string;
  narinfoKey: string;
  narKey: string;
}

/** publish API へ送る build 基本情報。 */
export interface BuildMeta {
  id: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  createdAt: number;
}

/** publish finalize API へ送る manifest 情報。 */
export interface ManifestMeta {
  closureJsonKey: string;
  manifestKey: string;
  manifestHash: string;
}

/** POST /api/publish/start のリクエストボディ。 */
export interface PublishStartBody {
  build: BuildMeta;
}

/** POST /api/publish/:build_id/ingest のリクエストボディ。 */
export interface PublishIngestBody {
  storePaths: NarinfoMeta[];
}

/** POST /api/publish/:build_id/finalize のリクエストボディ。 */
export interface PublishFinalizeBody {
  manifest: ManifestMeta & {
    host: string;
    system: string;
    gitRev: string;
    flakeLockHash: string;
    toplevelStorePath: string;
  };
}

/** scripts/publish.ts が使う完全な publish ペイロード。 */
export interface PublishPayload {
  build: BuildMeta;
  storePaths: NarinfoMeta[];
  manifest: ManifestMeta & {
    host: string;
    system: string;
    gitRev: string;
    flakeLockHash: string;
    toplevelStorePath: string;
  };
}
