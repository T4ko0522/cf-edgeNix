import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import { buildClosure, builds, narFiles, pinnedBuilds, rollbackRoots, storePaths } from "../schema";
import { BuildNotFoundError } from "./errors";
import type { DeadStorePath, LiveSet } from "./types";

/**
 * build を GC 保護対象として pinned_builds に登録する。
 * 参照先 build_id が存在しなければ BuildNotFoundError (404)。
 */
export async function pinBuild(db: Db, buildId: string, reason?: string): Promise<void> {
  const existing = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);

  if (!existing[0]) {
    throw new BuildNotFoundError(`build ${buildId} not found`);
  }

  const now = Date.now();
  const reasonValue = reason ?? null;
  await db
    .insert(pinnedBuilds)
    .values({
      buildId,
      pinnedAt: now,
      reason: reasonValue,
    })
    .onConflictDoUpdate({
      target: pinnedBuilds.buildId,
      set: {
        pinnedAt: now,
        reason: reasonValue,
      },
    });
}

/**
 * build の GC 保護 pin を解除する。
 * 参照先 build_id が存在しなければ BuildNotFoundError (404)。
 */
export async function unpinBuild(db: Db, buildId: string): Promise<void> {
  const existing = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);

  if (!existing[0]) {
    throw new BuildNotFoundError(`build ${buildId} not found`);
  }

  await db.delete(pinnedBuilds).where(eq(pinnedBuilds.buildId, buildId));
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
export async function computeLiveSet(db: Db, keepGenerations = 3): Promise<LiveSet> {
  const generationLimit = Math.max(0, keepGenerations);

  // 1. live build ID 集合を構築: published builds + rollback_roots + protected builds。
  const [allBuildRows, rollbackRootRows, pinnedBuildRows] = await Promise.all([
    db.select({
      id: builds.id,
      host: builds.host,
      status: builds.status,
      createdAt: builds.createdAt,
      publishedAt: builds.publishedAt,
    }).from(builds),
    db.select({ buildId: rollbackRoots.buildId }).from(rollbackRoots),
    db.select({ buildId: pinnedBuilds.buildId }).from(pinnedBuilds),
  ]);

  const rollbackBuildIds = new Set(rollbackRootRows.map((r) => r.buildId));
  const liveBuildIds = new Set<string>();
  for (const build of allBuildRows) {
    if (build.status === "published") {
      liveBuildIds.add(build.id);
    }
  }
  for (const buildId of rollbackBuildIds) {
    liveBuildIds.add(buildId);
  }

  const deadBuildRows = allBuildRows.filter(
    (build) =>
      build.status !== "published" &&
      build.status !== "staging" &&
      !rollbackBuildIds.has(build.id),
  );
  const deadBuildsByHost = new Map<string, typeof deadBuildRows>();
  for (const build of deadBuildRows) {
    const hostBuilds = deadBuildsByHost.get(build.host) ?? [];
    hostBuilds.push(build);
    deadBuildsByHost.set(build.host, hostBuilds);
  }
  for (const hostBuilds of deadBuildsByHost.values()) {
    hostBuilds
      .sort((a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt))
      .slice(0, generationLimit)
      .forEach((build) => liveBuildIds.add(build.id));
  }
  for (const pinned of pinnedBuildRows) {
    liveBuildIds.add(pinned.buildId);
  }

  // 2. live build_id に対応する build_closure から live storeHash を取得。
  // inArray は 999 件ごとに分割（SQLite 変数上限対策）。
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
  const allPaths = await db
    .select({ storeHash: storePaths.storeHash, narKey: storePaths.narKey })
    .from(storePaths);
  const storeHashToNarKey = new Map(allPaths.map((p) => [p.storeHash, p.narKey]));
  const candidateNarKeys = new Set(
    allPaths.map((p) => p.narKey).filter((narKey) => !liveNarKeySet.has(narKey)),
  );

  // 5. staleness: 候補を参照する dead build の MAX(published_at)。
  const deadBuildIdList = deadBuildRows.map((build) => build.id);
  const deadPublishedAtByBuildId = new Map(
    deadBuildRows.map((build) => [build.id, build.publishedAt]),
  );
  const candidateStalenessByNarKey = new Map<string, number | null>();
  for (let i = 0; i < deadBuildIdList.length; i += 999) {
    const chunk = deadBuildIdList.slice(i, i + 999);
    const rows_ = await db
      .select({ buildId: buildClosure.buildId, storeHash: buildClosure.storeHash })
      .from(buildClosure)
      .where(inArray(buildClosure.buildId, chunk));

    for (const row of rows_) {
      const narKey = storeHashToNarKey.get(row.storeHash);
      if (!narKey || !candidateNarKeys.has(narKey)) continue;

      const publishedAt = deadPublishedAtByBuildId.get(row.buildId) ?? null;
      if (publishedAt === null) {
        candidateStalenessByNarKey.set(
          narKey,
          candidateStalenessByNarKey.get(narKey) ?? null,
        );
        continue;
      }

      const current = candidateStalenessByNarKey.get(narKey);
      if (current === undefined || current === null || publishedAt > current) {
        candidateStalenessByNarKey.set(narKey, publishedAt);
      }
    }
  }

  const stalenessValue = (narKey: string) => candidateStalenessByNarKey.get(narKey) ?? null;
  const deadCandidates = [...candidateNarKeys].sort((a, b) => {
    const stalenessA = stalenessValue(a);
    const stalenessB = stalenessValue(b);
    if (stalenessA === null && stalenessB === null) return a.localeCompare(b);
    if (stalenessA === null) return -1;
    if (stalenessB === null) return 1;
    return stalenessA - stalenessB || a.localeCompare(b);
  });

  return {
    liveNarKeys: [...liveNarKeySet],
    deadCandidates,
  };
}
