import { and, asc, count, eq, gt, inArray, isNull, lt, lte, notExists, or } from "drizzle-orm";
import type { Db } from "../client";
import {
  buildClosure,
  buildManifests,
  builds,
  gcMarks,
  narFiles,
  pinnedBuilds,
  rollbackRoots,
  storePaths,
} from "../schema";
import { BuildNotFoundError, PublishConflictError } from "./errors";
import { isBuildRestorable, refreshBuildRestorable } from "./builds";
import type { DeadStorePath, LiveSet } from "./types";

/**
 * build を GC 保護対象として pinned_builds に登録する。
 * 参照先 build_id が存在しなければ BuildNotFoundError (404)。
 */
export async function pinBuild(db: Db, buildId: string, reason?: string): Promise<void> {
  const existing = await db
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);

  if (!existing[0] || existing[0].status === "pruned") {
    throw new BuildNotFoundError(`build ${buildId} not found`);
  }
  if (!await isBuildRestorable(db, buildId)) {
    throw new PublishConflictError(`build ${buildId} is not restorable`);
  }
  const marked = await db
    .select({ narKey: gcMarks.narKey })
    .from(buildClosure)
    .innerJoin(gcMarks, eq(gcMarks.narKey, buildClosure.narKey))
    .where(eq(buildClosure.buildId, buildId))
    .limit(1);
  if (marked[0]) throw new PublishConflictError(`build ${buildId} is pending GC`);

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

export async function listPendingClosureBackfills(
  db: Db,
  limit: number,
  after?: { buildId: string; storeHash: string },
): Promise<Array<{
  buildId: string;
  storeHash: string;
  manifestKey: string | null;
  manifestHash: string | null;
  status: "staging" | "published" | "failed" | "pruned";
  createdAt: number;
}>> {
  return db
    .select({
      buildId: buildClosure.buildId,
      storeHash: buildClosure.storeHash,
      manifestKey: buildManifests.manifestKey,
      manifestHash: buildManifests.manifestHash,
      status: builds.status,
      createdAt: builds.createdAt,
    })
    .from(buildClosure)
    .innerJoin(builds, eq(builds.id, buildClosure.buildId))
    .leftJoin(buildManifests, eq(buildManifests.buildId, buildClosure.buildId))
    .where(and(
      isNull(buildClosure.narKey),
      after
        ? or(
          gt(buildClosure.buildId, after.buildId),
          and(
            eq(buildClosure.buildId, after.buildId),
            gt(buildClosure.storeHash, after.storeHash),
          ),
        )
        : undefined,
    ))
    .orderBy(asc(buildClosure.buildId), asc(buildClosure.storeHash))
    .limit(limit);
}

export async function backfillClosureNarKeys(
  db: Db,
  buildId: string,
  storePaths_: Array<{ storeHash: string; narKey: string }>,
): Promise<number> {
  let updated = 0;
  for (let i = 0; i < storePaths_.length; i += 20) {
    const statements = storePaths_.slice(i, i + 20).map((row) => db
      .update(buildClosure)
      .set({ narKey: row.narKey })
      .where(and(
        eq(buildClosure.buildId, buildId),
        eq(buildClosure.storeHash, row.storeHash),
        isNull(buildClosure.narKey),
      )));
    const results = await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
    updated += results.reduce((sum, result) => sum + result.meta.changes, 0);
  }
  await refreshBuildRestorable(db, buildId);
  return updated;
}

export async function claimUnresolvedBuildForPrune(
  db: Db,
  buildId: string,
  stagingCutoff: number,
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({ status: "pruned", restorable: 0 })
    .where(and(
      eq(builds.id, buildId),
      or(
        inArray(builds.status, ["failed", "pruned"]),
        and(eq(builds.status, "staging"), lt(builds.createdAt, stagingCutoff)),
      ),
      notExists(
        db.select({ buildId: pinnedBuilds.buildId })
          .from(pinnedBuilds)
          .where(eq(pinnedBuilds.buildId, builds.id)),
      ),
      notExists(
        db.select({ buildId: rollbackRoots.buildId })
          .from(rollbackRoots)
          .where(eq(rollbackRoots.buildId, builds.id)),
      ),
    ));
  return result.meta.changes > 0;
}

export async function deleteUnresolvedBuildClosure(
  db: Db,
  buildId: string,
  storeHashes: string[],
): Promise<number> {
  if (storeHashes.length === 0) return 0;
  const result = await db.delete(buildClosure).where(and(
    eq(buildClosure.buildId, buildId),
    inArray(buildClosure.storeHash, storeHashes),
    isNull(buildClosure.narKey),
  ));
  return result.meta.changes;
}

export async function countPendingClosureBackfills(db: Db): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(buildClosure)
    .where(isNull(buildClosure.narKey));
  return rows[0]?.value ?? 0;
}

/**
 * dead 判定済み NAR key のうち、store_paths からは参照されなくなった orphan
 * nar_files 行を返す。ingest upsert で store_paths.narKey が上書きされたあと
 * 残る古い nar_files/R2 オブジェクトを GC が回収するために使う。
 * store_paths に対応行がある narKey は含めない（そちらは listDeadStorePaths で処理する）。
 */
export async function listOrphanedNarFiles(
  db: Db,
  targetNarKeys: string[],
): Promise<{ narKey: string; fileHash: string }[]> {
  if (targetNarKeys.length === 0) return [];

  const seen = new Set<string>();
  const rows: { narKey: string; fileHash: string }[] = [];
  for (let i = 0; i < targetNarKeys.length; i += 90) {
    const chunk = targetNarKeys.slice(i, i + 90);
    const [narRows, storeRows] = await Promise.all([
      db
        .select({ narKey: narFiles.narKey, fileHash: narFiles.fileHash })
        .from(narFiles)
        .where(inArray(narFiles.narKey, chunk)),
      db
        .select({ narKey: storePaths.narKey })
        .from(storePaths)
        .where(inArray(storePaths.narKey, chunk)),
    ]);
    const referenced = new Set(storeRows.map((s) => s.narKey));
    for (const row of narRows) {
      if (referenced.has(row.narKey)) continue;
      if (seen.has(row.narKey)) continue;
      seen.add(row.narKey);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * dead 判定済み NAR key から削除対象 store_path を引く。
 * D1 の bind parameter 上限に余裕を持たせ、90件ごとに分割する。
 */
export async function listDeadStorePaths(
  db: Db,
  deadNarKeys: string[],
): Promise<DeadStorePath[]> {
  if (deadNarKeys.length === 0) return [];

  const rows: DeadStorePath[] = [];
  for (let i = 0; i < deadNarKeys.length; i += 90) {
    const chunk = deadNarKeys.slice(i, i + 90);
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

export async function listNarinfoReferences(
  db: Db,
  narKeys: string[],
): Promise<Array<{
  narKey: string;
  storeHash: string;
  narinfoKey: string;
  currentNarKey: string;
}>> {
  if (narKeys.length === 0) return [];
  return db
    .select({
      narKey: buildClosure.narKey,
      storeHash: buildClosure.storeHash,
      narinfoKey: storePaths.narinfoKey,
      currentNarKey: storePaths.narKey,
    })
    .from(buildClosure)
    .innerJoin(storePaths, eq(storePaths.storeHash, buildClosure.storeHash))
    .where(inArray(buildClosure.narKey, narKeys))
    .then((rows) => rows.flatMap((row) => row.narKey ? [{ ...row, narKey: row.narKey }] : []));
}

/**
 * NAR 削除により復元不能になる build を先に pruned として記録する。
 */
export async function markBuildsPrunedForNarKeys(
  db: Db,
  narKeys: string[],
): Promise<number> {
  if (narKeys.length === 0) return 0;
  const affectedBuilds = db
    .selectDistinct({ id: buildClosure.buildId })
    .from(buildClosure)
    .where(inArray(buildClosure.narKey, [...new Set(narKeys)]));
  const result = await db
    .update(builds)
    .set({ status: "pruned", restorable: 0 })
    .where(inArray(builds.id, affectedBuilds));
  return result.meta.changes;
}

/** dead store_paths / nar_files / build_closure を 1 batch で整合的に削除する。 */
export async function deleteDeadStorePaths(
  db: Db,
  deadStorePaths: DeadStorePath[],
  narKeys: string[],
): Promise<{
  storePathsDeleted: number;
  narFilesDeleted: number;
  buildClosureDeleted: number;
}> {
  const uniqueNarKeys = [...new Set(narKeys)];
  const statements = [];
  const storePathIndex = statements.length;
  if (deadStorePaths.length > 0) {
    statements.push(db.delete(storePaths).where(inArray(storePaths.narKey, uniqueNarKeys)));
  }
  const narFileIndex = statements.length;
  if (uniqueNarKeys.length > 0) {
    statements.push(db.delete(narFiles).where(inArray(narFiles.narKey, uniqueNarKeys)) as never);
  }
  const closureIndex = statements.length;
  if (uniqueNarKeys.length > 0) {
    statements.push(
      db.delete(buildClosure).where(inArray(buildClosure.narKey, uniqueNarKeys)) as never,
    );
  }
  if (uniqueNarKeys.length > 0) {
    statements.push(db.delete(gcMarks).where(inArray(gcMarks.narKey, uniqueNarKeys)) as never);
  }
  if (statements.length === 0) {
    return { storePathsDeleted: 0, narFilesDeleted: 0, buildClosureDeleted: 0 };
  }
  const results = await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
  return {
    storePathsDeleted: deadStorePaths.length > 0 ? results[storePathIndex]?.meta.changes ?? 0 : 0,
    narFilesDeleted: uniqueNarKeys.length > 0 ? results[narFileIndex]?.meta.changes ?? 0 : 0,
    buildClosureDeleted: uniqueNarKeys.length > 0 ? results[closureIndex]?.meta.changes ?? 0 : 0,
  };
}

export async function markGcCandidates(
  db: Db,
  narKeys: string[],
  now = Date.now(),
): Promise<void> {
  const uniqueNarKeys = [...new Set(narKeys)];
  for (let i = 0; i < uniqueNarKeys.length; i += 20) {
    const statements = uniqueNarKeys.slice(i, i + 20).map((narKey) =>
      db.insert(gcMarks).values({
        narKey,
        markedAt: now,
        narinfoDeletedAt: null,
      }).onConflictDoNothing()
    );
    await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
  }
}

export async function confirmNarinfoDeleted(
  db: Db,
  narKeys: string[],
  now = Date.now(),
): Promise<void> {
  if (narKeys.length === 0) return;
  await db
    .update(gcMarks)
    .set({ narinfoDeletedAt: now })
    .where(inArray(gcMarks.narKey, [...new Set(narKeys)]));
}

export async function listGraceElapsedNarKeys(
  db: Db,
  deadNarKeys: string[],
  now = Date.now(),
  graceMs = 60 * 60 * 1000,
): Promise<string[]> {
  if (deadNarKeys.length === 0) return [];
  const rows = await db
    .select({ narKey: gcMarks.narKey })
    .from(gcMarks)
    .where(lte(gcMarks.narinfoDeletedAt, now - graceMs));
  const eligible = new Set(rows.map((row) => row.narKey));
  return deadNarKeys.filter((narKey) => eligible.has(narKey));
}

export async function listPendingNarinfoKeys(db: Db, deadNarKeys: string[]): Promise<string[]> {
  const rows = await db
    .select({ narKey: gcMarks.narKey, deletedAt: gcMarks.narinfoDeletedAt })
    .from(gcMarks);
  const marks = new Map(rows.map((row) => [row.narKey, row.deletedAt]));
  return deadNarKeys.filter((narKey) => !marks.has(narKey) || marks.get(narKey) === null);
}

export async function deleteGcMarks(db: Db, narKeys: string[]): Promise<void> {
  for (let i = 0; i < narKeys.length; i += 90) {
    await db.delete(gcMarks).where(inArray(gcMarks.narKey, narKeys.slice(i, i + 90)));
  }
}

export async function deleteLiveGcMarks(db: Db, liveNarKeys: string[]): Promise<void> {
  if (liveNarKeys.length === 0) return;
  const live = new Set(liveNarKeys);
  const marks = await db.select({ narKey: gcMarks.narKey }).from(gcMarks);
  await deleteGcMarks(db, marks.flatMap((row) => live.has(row.narKey) ? [row.narKey] : []));
}

/**
 * rollback_roots → builds → build_closure → nar_key の JOIN で
 * 現在 live な NAR key 集合と dead_candidates を返す（GC dry-run 用）。
 * 実 R2 削除はしない。
 * G8: latest published build の closure を live root に含める。
 */
export async function computeLiveSet(db: Db, keepGenerations = 3): Promise<LiveSet> {
  const generationLimit = Math.max(0, keepGenerations);

  // 1. live build ID 集合を構築: host ごとの最新 published、rollback、pin、進行中 staging。
  const [
    allBuildRows,
    rollbackRootRows,
    pinnedBuildRows,
    allClosureRows,
    allPaths,
    allNarFileRows,
  ] = await Promise.all([
    db.select({
      id: builds.id,
      host: builds.host,
      status: builds.status,
      createdAt: builds.createdAt,
      publishedAt: builds.publishedAt,
    }).from(builds),
    db.select({ buildId: rollbackRoots.buildId }).from(rollbackRoots),
    db.select({ buildId: pinnedBuilds.buildId }).from(pinnedBuilds),
    db.select().from(buildClosure),
    db.select({ storeHash: storePaths.storeHash, narKey: storePaths.narKey }).from(storePaths),
    db.select({ narKey: narFiles.narKey }).from(narFiles),
  ]);

  const rollbackBuildIds = new Set(rollbackRootRows.map((r) => r.buildId));
  const liveBuildIds = new Set<string>();
  const publishedByHost = new Map<string, typeof allBuildRows>();
  for (const build of allBuildRows.filter((row) => row.status === "published")) {
    const hostBuilds = publishedByHost.get(build.host) ?? [];
    hostBuilds.push(build);
    publishedByHost.set(build.host, hostBuilds);
  }
  for (const hostBuilds of publishedByHost.values()) {
    hostBuilds
      .sort((a, b) =>
        (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt) ||
        b.id.localeCompare(a.id))
      .slice(0, generationLimit)
      .forEach((build) => liveBuildIds.add(build.id));
  }
  const stagingCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const build of allBuildRows) {
    if (build.status === "staging" && build.createdAt >= stagingCutoff) liveBuildIds.add(build.id);
  }
  for (const buildId of rollbackBuildIds) {
    liveBuildIds.add(buildId);
  }

  for (const pinned of pinnedBuildRows) {
    liveBuildIds.add(pinned.buildId);
  }

  // 2. migration 前の closure が残る間は fail-closed で全 NAR を保護する。
  if (allClosureRows.some((row) => row.narKey === null)) {
    return {
      liveNarKeys: [...new Set([
        ...allPaths.map((row) => row.narKey),
        ...allNarFileRows.map((row) => row.narKey),
        ...allClosureRows.flatMap((row) => row.narKey ? [row.narKey] : []),
      ])],
      liveStoreHashes: [...new Set(allPaths.map((row) => row.storeHash))],
      deadCandidates: [],
    };
  }

  const liveClosure = allClosureRows.filter((row) => liveBuildIds.has(row.buildId));
  const liveStoreHashSet = new Set(liveClosure.map((row) => row.storeHash));
  const liveNarKeySet = new Set([
    ...liveClosure.flatMap((row) => row.narKey ? [row.narKey] : []),
    ...allPaths.flatMap((row) => liveStoreHashSet.has(row.storeHash) ? [row.narKey] : []),
  ]);

  // 4. dead candidates: live でない narKey。
  // 候補源は store_paths / nar_files / build_closure。途中失敗で前二者だけが
  // 消えても closure から再試行できるようにする。
  // ingest upsert で store_paths.narKey が最新 NAR に置き換わったあとに残る
  // orphan な nar_files 行（および対応する R2 オブジェクト）を GC の到達範囲に
  // 含めるため。全件取得し JS 側で live-set と照合する。
  const candidateNarKeys = new Set<string>();
  for (const path of allPaths) {
    if (!liveNarKeySet.has(path.narKey)) candidateNarKeys.add(path.narKey);
  }
  for (const row of allNarFileRows) {
    if (!liveNarKeySet.has(row.narKey)) candidateNarKeys.add(row.narKey);
  }
  for (const row of allClosureRows) {
    if (row.narKey && !liveNarKeySet.has(row.narKey)) candidateNarKeys.add(row.narKey);
  }

  // 5. staleness: 候補を参照する dead build の MAX(published_at)。
  const deadBuildRows = allBuildRows.filter((build) => !liveBuildIds.has(build.id));
  const deadPublishedAtByBuildId = new Map(deadBuildRows.map((build) => [
    build.id,
    build.publishedAt ?? build.createdAt,
  ]));
  const candidateStalenessByNarKey = new Map<string, number | null>();
  for (const row of allClosureRows) {
    if (deadPublishedAtByBuildId.has(row.buildId)) {
      const narKey = row.narKey;
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
    liveStoreHashes: [...liveStoreHashSet],
    deadCandidates,
  };
}
