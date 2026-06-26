import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import {
  buildClosure,
  buildManifests,
  builds,
  narFiles,
  rollbackRoots,
  storePaths,
} from "./schema";
import type { Build, BuildManifest } from "./schema";

export type { Build, BuildManifest };

// ─── エラー型 ───────────────────────────────────────────────────────────────

/** 同一 build_id が published 済みで、異なる payload で再投入しようとした場合 (409) */
export class PublishConflictError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "PublishConflictError";
  }
}

/** staging 状態の build が見つからない場合 (404) */
export class BuildNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = "BuildNotFoundError";
  }
}

// ─── ingest / finalize 用の入力型 ────────────────────────────────────────────

export interface BuildMeta {
  id: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  createdAt: number;
}

export interface NarinfoMeta {
  storeHash: string;
  storePath: string;
  narinfoKey: string;
  narKey: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  fileSize: number;
  compression: string;
  firstSeenBuildId?: string;
}

export interface ManifestMeta {
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  closureJsonKey: string;
  manifestKey: string;
  manifestHash: string;
}

export interface RollbackRootInput {
  id: string;
  host: string;
  buildId: string;
  reason?: string;
  pinned?: boolean;
  keepUntil?: number;
}

export interface LiveSet {
  liveNarKeys: string[];
  deadCandidates: string[];
}

export interface DeadStorePath {
  storeHash: string;
  narinfoKey: string;
  narKey: string;
  fileHash: string;
}

// ─── read クエリ ─────────────────────────────────────────────────────────────

/**
 * host の latest published build を返す。存在しなければ null。
 * G1: status='published' で絞り、published_at DESC で最新を取得。
 */
export async function getLatestBuild(db: Db, host: string): Promise<Build | null> {
  const rows = await db
    .select()
    .from(builds)
    .where(and(eq(builds.host, host), eq(builds.status, "published")))
    .orderBy(desc(builds.publishedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** host の build 履歴（新しい順）を返す。 */
export async function listBuilds(db: Db, host: string, limit?: number): Promise<Build[]> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.host, host))
    .orderBy(desc(builds.createdAt))
    .limit(limit ?? 50);
}

/** build_id から build_manifest を返す。存在しなければ null。 */
export async function getManifest(db: Db, buildId: string): Promise<BuildManifest | null> {
  const rows = await db
    .select()
    .from(buildManifests)
    .where(eq(buildManifests.buildId, buildId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── write クエリ ─────────────────────────────────────────────────────────────

/**
 * staging 状態の build レコードを作成する。latest pointer は変更しない。
 * 同一 build_id が published 済みなら PublishConflictError (409)。
 * staging 済みで meta 差分あり → PublishConflictError (409)、一致は冪等 200。
 */
export async function startBuild(db: Db, build: BuildMeta): Promise<{ buildId: string }> {
  const existing = await db
    .select()
    .from(builds)
    .where(eq(builds.id, build.id))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.status === "published") {
      throw new PublishConflictError(`build ${build.id} is already published`);
    }
    // staging 済み: meta の immutable フィールドを比較し差分なら 409。
    if (
      row.host !== build.host ||
      row.system !== build.system ||
      row.gitRev !== build.gitRev ||
      row.flakeLockHash !== build.flakeLockHash ||
      row.toplevelStorePath !== build.toplevelStorePath
    ) {
      throw new PublishConflictError(
        `build ${build.id} already exists as staging with different meta`,
      );
    }
    return { buildId: build.id };
  }

  await db.batch([
    db.insert(builds).values({
      id: build.id,
      host: build.host,
      system: build.system,
      gitRev: build.gitRev,
      flakeLockHash: build.flakeLockHash,
      toplevelStorePath: build.toplevelStorePath,
      status: "staging",
      createdAt: build.createdAt,
    }),
  ]);

  return { buildId: build.id };
}

/**
 * store_paths / nar_files / build_closure を chunk 単位で冪等に挿入する。
 * 対象 build が staging 以外なら PublishConflictError (409)。
 * staging build が存在しなければ BuildNotFoundError (404)。
 * 既存行と差分比較し、不一致は PublishConflictError(409)、一致は冪等 no-op（G6）。
 * 1 chunk = 1 db.batch() で atomic。
 */
export async function ingestStorePaths(
  db: Db,
  buildId: string,
  rows: NarinfoMeta[],
): Promise<void> {
  const existing = await db
    .select()
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);

  const build = existing[0];
  if (!build) {
    throw new BuildNotFoundError(`build ${buildId} not found`);
  }
  if (build.status !== "staging") {
    throw new PublishConflictError(
      `build ${buildId} is not in staging status (${build.status})`,
    );
  }

  if (rows.length === 0) return;

  // G6: 既存行との差分比較。storeHash が衝突する既存行を取得して全フィールド比較。
  // inArray は SQLite 変数上限(999)を超えないよう 999 件ごとに分割する（修正2）。
  const incomingHashes = rows.map((r) => r.storeHash);
  const existingPaths: (typeof storePaths.$inferSelect)[] = [];
  for (let i = 0; i < incomingHashes.length; i += 999) {
    const chunk = incomingHashes.slice(i, i + 999);
    const rows_ = await db
      .select()
      .from(storePaths)
      .where(inArray(storePaths.storeHash, chunk));
    existingPaths.push(...rows_);
  }

  const existingMap = new Map(existingPaths.map((p) => [p.storeHash, p]));

  for (const row of rows) {
    const ex = existingMap.get(row.storeHash);
    if (ex) {
      // 全フィールドが一致するか確認（冪等再送として許容）。
      if (
        ex.narKey !== row.narKey ||
        ex.narHash !== row.narHash ||
        ex.narSize !== row.narSize ||
        ex.fileHash !== row.fileHash ||
        ex.fileSize !== row.fileSize ||
        ex.compression !== row.compression
      ) {
        throw new PublishConflictError(
          `store_path ${row.storeHash} already exists with different payload`,
        );
      }
      // 一致する場合: 冪等 no-op（build_closure は後で全行挿入するためここではスキップ）。
    }
  }

  const now = Date.now();

  // 新規行のみ store_paths / nar_files に挿入（既存行はスキップ）。
  const newRows = rows.filter((r) => !existingMap.has(r.storeHash));

  // build_closure はこの build について全入力行に対して挿入する（修正7）。
  // 既存 store_path でも当該 build の closure 行を作ることで GC/liveset が正しくなる。
  // CHUNK_SIZE: 1 行あたり最大 3 statements (store_paths + nar_files + build_closure)。
  // 新規行 chunk: 3 × 25 = 75 statements ≤ 90（実 D1 上限 100 の安全余裕を持たせる）（修正1）。
  // build_closure のみ chunk: 1 × 90 = 90 statements（既存行のみの場合）。
  const STORE_CHUNK = 25;
  const CLOSURE_CHUNK = 90;

  // Step A: 新規 store_paths / nar_files / build_closure を chunk 単位で挿入。
  for (let i = 0; i < newRows.length; i += STORE_CHUNK) {
    const chunk = newRows.slice(i, i + STORE_CHUNK);
    const stmts = chunk.flatMap((row) => [
      db
        .insert(storePaths)
        .values({
          storeHash: row.storeHash,
          storePath: row.storePath,
          narinfoKey: row.narinfoKey,
          narKey: row.narKey,
          narHash: row.narHash,
          narSize: row.narSize,
          fileHash: row.fileHash,
          fileSize: row.fileSize,
          compression: row.compression,
          firstSeenBuildId: row.firstSeenBuildId ?? buildId,
          createdAt: now,
        })
        .onConflictDoNothing(),
      db
        .insert(narFiles)
        .values({
          fileHash: row.fileHash,
          narKey: row.narKey,
          fileSize: row.fileSize,
          compression: row.compression,
          createdAt: now,
        })
        .onConflictDoNothing(),
      db
        .insert(buildClosure)
        .values({ buildId, storeHash: row.storeHash })
        .onConflictDoNothing(),
    ]);
    await db.batch(stmts as unknown as Parameters<Db["batch"]>[0]);
  }

  // Step B: 既存 store_path に対しても build_closure を挿入する（修正7）。
  const existingRows = rows.filter((r) => existingMap.has(r.storeHash));
  for (let i = 0; i < existingRows.length; i += CLOSURE_CHUNK) {
    const chunk = existingRows.slice(i, i + CLOSURE_CHUNK);
    const stmts = chunk.map((row) =>
      db
        .insert(buildClosure)
        .values({ buildId, storeHash: row.storeHash })
        .onConflictDoNothing(),
    );
    await db.batch(stmts as unknown as Parameters<Db["batch"]>[0]);
  }
}

/**
 * build_manifests 挿入 + builds.status='published' + published_at 更新を
 * 1 db.batch() で atomic に実行する。
 * latest を動かす唯一の地点（G2: latest = status='published' ORDER BY published_at DESC の導出）。
 * 対象 build が staging 以外でも、同一 manifest payload の再送は冪等に 200 を返す（G6）。
 * staging build が存在しなければ BuildNotFoundError (404)。
 */
export async function finalizeBuild(
  db: Db,
  buildId: string,
  manifest: ManifestMeta,
): Promise<{ publishedAt: number }> {
  const existing = await db
    .select()
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);

  const build = existing[0];
  if (!build) {
    throw new BuildNotFoundError(`build ${buildId} not found`);
  }

  // G6: published 済みの場合、manifest payload を比較して同一なら冪等 200、差分は 409。
  if (build.status === "published") {
    const existingManifest = await db
      .select()
      .from(buildManifests)
      .where(eq(buildManifests.buildId, buildId))
      .limit(1);

    const exM = existingManifest[0];
    if (exM) {
      // immutable フィールドを全て比較する。
      if (
        exM.host !== manifest.host ||
        exM.system !== manifest.system ||
        exM.gitRev !== manifest.gitRev ||
        exM.flakeLockHash !== manifest.flakeLockHash ||
        exM.toplevelStorePath !== manifest.toplevelStorePath ||
        exM.closureJsonKey !== manifest.closureJsonKey ||
        exM.manifestKey !== manifest.manifestKey ||
        exM.manifestHash !== manifest.manifestHash
      ) {
        throw new PublishConflictError(
          `build ${buildId} is already published with different manifest`,
        );
      }
      // 完全一致: 冪等（200）。
      return { publishedAt: build.publishedAt ?? Date.now() };
    }
    // manifest がない published build は不整合（PublishConflictError）。
    throw new PublishConflictError(
      `build ${buildId} is published but has no manifest`,
    );
  }

  if (build.status !== "staging") {
    throw new PublishConflictError(
      `build ${buildId} is not in staging status (${build.status})`,
    );
  }

  const publishedAt = Date.now();

  await db.batch([
    db.insert(buildManifests).values({
      buildId,
      host: manifest.host,
      system: manifest.system,
      gitRev: manifest.gitRev,
      flakeLockHash: manifest.flakeLockHash,
      toplevelStorePath: manifest.toplevelStorePath,
      closureJsonKey: manifest.closureJsonKey,
      manifestKey: manifest.manifestKey,
      manifestHash: manifest.manifestHash,
      createdAt: publishedAt,
    }),
    db
      .update(builds)
      .set({ status: "published", publishedAt })
      .where(eq(builds.id, buildId)),
  ]);

  return { publishedAt };
}

/**
 * rollback_roots にレコードを追加する。
 * 参照先 build_id が存在しなければ BuildNotFoundError (404)。
 */
export async function registerRollbackRoot(db: Db, input: RollbackRootInput): Promise<void> {
  const existing = await db
    .select()
    .from(builds)
    .where(eq(builds.id, input.buildId))
    .limit(1);

  if (!existing[0]) {
    throw new BuildNotFoundError(`build ${input.buildId} not found`);
  }

  await db.batch([
    db.insert(rollbackRoots).values({
      id: input.id,
      host: input.host,
      buildId: input.buildId,
      reason: input.reason ?? null,
      pinned: input.pinned ? 1 : 0,
      keepUntil: input.keepUntil ?? null,
      createdAt: Date.now(),
    }),
  ]);
}

/**
 * dead 判定済み NAR key から削除対象 store_path を引く。
 * inArray は SQLite 変数上限(999)を超えないよう 999 件ごとに分割する。
 */
export async function listDeadStorePaths(
  db: Db,
  deadNarKeys: string[],
): Promise<DeadStorePath[]> {
  if (deadNarKeys.length === 0) return [];

  const rows: DeadStorePath[] = [];
  for (let i = 0; i < deadNarKeys.length; i += 999) {
    const chunk = deadNarKeys.slice(i, i + 999);
    const rows_ = await db
      .select({
        storeHash: storePaths.storeHash,
        narinfoKey: storePaths.narinfoKey,
        narKey: storePaths.narKey,
        fileHash: storePaths.fileHash,
      })
      .from(storePaths)
      .where(inArray(storePaths.narKey, chunk));
    rows.push(...rows_);
  }
  return rows;
}

async function countByChunks<TColumn>(
  db: Db,
  table: typeof storePaths | typeof narFiles | typeof buildClosure,
  column: TColumn,
  values: string[],
): Promise<number> {
  let total = 0;
  for (let i = 0; i < values.length; i += 999) {
    const chunk = values.slice(i, i + 999);
    const rows = await db
      .select({ value: count() })
      .from(table)
      .where(inArray(column as never, chunk));
    total += rows[0]?.value ?? 0;
  }
  return total;
}

/**
 * dead store_paths / nar_files / orphan build_closure を物理削除する。
 * D1 delete 結果の差異を避けるため、削除件数は事前 COUNT で確定する。
 */
export async function deleteDeadStorePaths(
  db: Db,
  storeHashes: string[],
  fileHashes: string[],
): Promise<{
  storePathsDeleted: number;
  narFilesDeleted: number;
  buildClosureDeleted: number;
}> {
  const uniqueStoreHashes = [...new Set(storeHashes)];
  const uniqueFileHashes = [...new Set(fileHashes)];

  const [storePathsDeleted, narFilesDeleted, buildClosureDeleted] = await Promise.all([
    countByChunks(db, storePaths, storePaths.storeHash, uniqueStoreHashes),
    countByChunks(db, narFiles, narFiles.fileHash, uniqueFileHashes),
    countByChunks(db, buildClosure, buildClosure.storeHash, uniqueStoreHashes),
  ]);

  const storePathDeletes = [];
  for (let i = 0; i < uniqueStoreHashes.length; i += 999) {
    const chunk = uniqueStoreHashes.slice(i, i + 999);
    storePathDeletes.push(db.delete(storePaths).where(inArray(storePaths.storeHash, chunk)));
  }
  if (storePathDeletes.length > 0) {
    await db.batch(storePathDeletes as unknown as Parameters<Db["batch"]>[0]);
  }

  const narFileDeletes = [];
  for (let i = 0; i < uniqueFileHashes.length; i += 999) {
    const chunk = uniqueFileHashes.slice(i, i + 999);
    narFileDeletes.push(db.delete(narFiles).where(inArray(narFiles.fileHash, chunk)));
  }
  if (narFileDeletes.length > 0) {
    await db.batch(narFileDeletes as unknown as Parameters<Db["batch"]>[0]);
  }

  const buildClosureDeletes = [];
  for (let i = 0; i < uniqueStoreHashes.length; i += 999) {
    const chunk = uniqueStoreHashes.slice(i, i + 999);
    buildClosureDeletes.push(
      db.delete(buildClosure).where(inArray(buildClosure.storeHash, chunk)),
    );
  }
  if (buildClosureDeletes.length > 0) {
    await db.batch(buildClosureDeletes as unknown as Parameters<Db["batch"]>[0]);
  }

  return { storePathsDeleted, narFilesDeleted, buildClosureDeleted };
}

/**
 * rollback_roots → builds → build_closure → nar_key の JOIN で
 * 現在 live な NAR key 集合と dead_candidates を返す（GC dry-run 用）。
 * 実 R2 削除はしない。
 * G8: latest published build の closure を live root に含める。
 */
export async function computeLiveSet(db: Db): Promise<LiveSet> {
  // 1. live build ID 集合を構築: published builds + rollback_roots の build_id の union。
  const publishedBuilds = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.status, "published"));

  const rollbackRootRows = await db
    .select({ buildId: rollbackRoots.buildId })
    .from(rollbackRoots);

  const liveBuildIds = new Set<string>([
    ...publishedBuilds.map((b) => b.id),
    ...rollbackRootRows.map((r) => r.buildId),
  ]);

  if (liveBuildIds.size === 0) {
    // live build なし: 全 store_paths の narKey を dead_candidates とする。
    const allPaths = await db.select({ narKey: storePaths.narKey }).from(storePaths);
    const deadKeys = [...new Set(allPaths.map((p) => p.narKey))];
    return { liveNarKeys: [], deadCandidates: deadKeys };
  }

  // 2. live build_id に対応する build_closure から live storeHash を取得。
  // inArray は 999 件ごとに分割（修正2: SQLite 変数上限対策）。
  const liveBuildIdList = [...liveBuildIds];
  const liveClosure: (typeof buildClosure.$inferSelect)[] = [];
  for (let i = 0; i < liveBuildIdList.length; i += 999) {
    const chunk = liveBuildIdList.slice(i, i + 999);
    const rows_ = await db
      .select({ storeHash: buildClosure.storeHash, buildId: buildClosure.buildId })
      .from(buildClosure)
      .where(inArray(buildClosure.buildId, chunk));
    liveClosure.push(...rows_);
  }

  const liveStoreHashes = new Set(liveClosure.map((c) => c.storeHash));

  if (liveStoreHashes.size === 0) {
    // live closure が空: 全 NAR は dead candidate。
    const allPaths = await db.select({ narKey: storePaths.narKey }).from(storePaths);
    const deadKeys = [...new Set(allPaths.map((p) => p.narKey))];
    return { liveNarKeys: [], deadCandidates: deadKeys };
  }

  // 3. live storeHash に対応する narKey を取得（inArray 999 件分割）。
  const liveStoreHashList = [...liveStoreHashes];
  const livePathRows: { narKey: string }[] = [];
  for (let i = 0; i < liveStoreHashList.length; i += 999) {
    const chunk = liveStoreHashList.slice(i, i + 999);
    const rows_ = await db
      .select({ narKey: storePaths.narKey })
      .from(storePaths)
      .where(inArray(storePaths.storeHash, chunk));
    livePathRows.push(...rows_);
  }

  const liveNarKeySet = new Set(livePathRows.map((p) => p.narKey));

  // 4. dead candidates: live でない narKey を持つ store_paths。
  // notInArray も 999 件制限があるため、全件取得して JS 側でフィルタする。
  const allPaths = await db.select({ narKey: storePaths.narKey }).from(storePaths);
  const deadCandidates = [...new Set(
    allPaths.map((p) => p.narKey).filter((k) => !liveNarKeySet.has(k)),
  )];

  return {
    liveNarKeys: [...liveNarKeySet],
    deadCandidates,
  };
}
