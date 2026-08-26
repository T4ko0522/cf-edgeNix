import { count, eq, inArray } from "drizzle-orm";
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
import { BuildNotFoundError } from "./errors";
import { assertBuildClosureCanBecomeLiveRoot } from "./builds";
import type { DeadStorePath, LiveSet } from "./types";

interface OrphanedNarFile {
  narKey: string;
  fileHash: string;
}

interface ReclaimableNarObjects {
  narKeys: string[];
  fileHashes: string[];
}

interface CollectableManifestObjects {
  closureJsonKeys: string[];
  manifestKeys: string[];
}

interface DeleteDeadStorePathsResult {
  storePathsDeleted: number;
  narFilesDeleted: number;
  buildClosureDeleted: number;
}

export async function pinBuild(db: Db, buildId: string, reason?: string): Promise<void> {
  const rows = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  if (!rows[0]) throw new BuildNotFoundError(`build ${buildId} not found`);

  await assertBuildClosureCanBecomeLiveRoot(db, buildId);

  const pinnedAt = Date.now();
  await db
    .insert(pinnedBuilds)
    .values({ buildId, pinnedAt, reason: reason ?? null })
    .onConflictDoUpdate({
      target: pinnedBuilds.buildId,
      set: { pinnedAt, reason: reason ?? null },
    });
}

export async function unpinBuild(db: Db, buildId: string): Promise<void> {
  const rows = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  if (!rows[0]) throw new BuildNotFoundError(`build ${buildId} not found`);
  await db.delete(pinnedBuilds).where(eq(pinnedBuilds.buildId, buildId));
}

export async function listOrphanedNarFiles(
  db: Db,
  targetNarKeys: string[],
): Promise<OrphanedNarFile[]> {
  if (!targetNarKeys.length) return [];
  const [files, paths] = await Promise.all([
    db.select({ narKey: narFiles.narKey, fileHash: narFiles.fileHash }).from(narFiles),
    db.select({ narKey: storePaths.narKey }).from(storePaths),
  ]);
  const targets = new Set(targetNarKeys);
  const referenced = new Set(paths.map((row) => row.narKey));
  return files.filter((row) => targets.has(row.narKey) && !referenced.has(row.narKey));
}

export async function listDeadStorePaths(db: Db, storeHashes: string[]): Promise<DeadStorePath[]> {
  if (!storeHashes.length) return [];
  const result: DeadStorePath[] = [];
  for (let i = 0; i < storeHashes.length; i += 999) {
    const chunk = storeHashes.slice(i, i + 999);
    const rows = await db
      .select({
        storeHash: storePaths.storeHash,
        narinfoKey: storePaths.narinfoKey,
        narKey: storePaths.narKey,
        fileHash: storePaths.fileHash,
      })
      .from(storePaths)
      .where(inArray(storePaths.storeHash, chunk));
    result.push(...rows);
  }
  return result;
}

/** narinfo をまだunpublishしていない dead store path を全件返す。 */
export async function listUnmarkedDeadStorePaths(
  db: Db,
  deadStorePaths: DeadStorePath[],
): Promise<DeadStorePath[]> {
  if (deadStorePaths.length === 0) return [];
  const marks = await db.select({ storeHash: gcMarks.storeHash }).from(gcMarks);
  const marked = new Set(marks.map((mark) => mark.storeHash));
  return deadStorePaths.filter((path) => !marked.has(path.storeHash));
}

/** grace period後にNAR削除できる、mark済みの dead store path を全件返す。 */
export async function listMarkedDeadStorePaths(
  db: Db,
  deadStorePaths: DeadStorePath[],
): Promise<DeadStorePath[]> {
  if (deadStorePaths.length === 0) return [];
  const marks = await db
    .select({ storeHash: gcMarks.storeHash, markedAt: gcMarks.markedAt })
    .from(gcMarks)
    .orderBy(gcMarks.markedAt, gcMarks.storeHash);
  const pathsByHash = new Map(deadStorePaths.map((path) => [path.storeHash, path]));
  return marks.flatMap((mark) => {
    const path = pathsByHash.get(mark.storeHash);
    return path ? [path] : [];
  });
}

export async function markStorePathsForGc(db: Db, storeHashes: string[]): Promise<void> {
  const now = Date.now();
  const uniqueHashes = [...new Set(storeHashes)];
  for (let i = 0; i < uniqueHashes.length; i += 90) {
    const statements = uniqueHashes.slice(i, i + 90).map((storeHash) =>
      db
        .insert(gcMarks)
        .values({ storeHash, markedAt: now })
        .onConflictDoNothing(),
    );
    await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
  }
}

export async function deleteGcMarks(db: Db, storeHashes: string[]): Promise<void> {
  for (let i = 0; i < storeHashes.length; i += 999) {
    await db
      .delete(gcMarks)
      .where(inArray(gcMarks.storeHash, storeHashes.slice(i, i + 999)));
  }
}

/** liveに戻ったpathや既に消えたpathの古いmarkを掃除し、nar phaseの誤削除を防ぐ。 */
export async function deleteStaleGcMarks(
  db: Db,
  deadStoreHashes: string[],
): Promise<void> {
  const marks = await db.select({ storeHash: gcMarks.storeHash }).from(gcMarks);
  const deadHashes = new Set(deadStoreHashes);
  await deleteGcMarks(
    db,
    marks
      .map((mark) => mark.storeHash)
      .filter((storeHash) => !deadHashes.has(storeHash)),
  );
}

type CountableTable =
  | typeof storePaths
  | typeof narFiles
  | typeof buildClosure
  | typeof builds;

async function countByChunks(
  db: Db,
  table: CountableTable,
  column: unknown,
  values: string[],
): Promise<number> {
  let total = 0;
  for (let i = 0; i < values.length; i += 999) {
    const rows = await db
      .select({ value: count() })
      .from(table)
      .where(inArray(column as never, values.slice(i, i + 999)));
    total += rows[0]?.value ?? 0;
  }
  return total;
}

/** 対象 storeHash の closure だけを消し、live build の closure を保存する。 */
export async function deleteDeadStorePaths(
  db: Db,
  storeHashes: string[],
  fileHashes: string[],
): Promise<DeleteDeadStorePathsResult> {
  const hashes = [...new Set(storeHashes)];
  const files = [...new Set(fileHashes)];
  const [storePathsDeleted, narFilesDeleted, buildClosureDeleted] = await Promise.all([
    countByChunks(db, storePaths, storePaths.storeHash, hashes),
    countByChunks(db, narFiles, narFiles.fileHash, files),
    countByChunks(db, buildClosure, buildClosure.storeHash, hashes),
  ]);
  const statements = [];
  for (let i = 0; i < hashes.length; i += 999) {
    const chunk = hashes.slice(i, i + 999);
    statements.push(
      db.delete(buildClosure).where(inArray(buildClosure.storeHash, chunk)),
      db.delete(storePaths).where(inArray(storePaths.storeHash, chunk)),
    );
  }
  for (let i = 0; i < files.length; i += 999) {
    statements.push(
      db.delete(narFiles).where(inArray(narFiles.fileHash, files.slice(i, i + 999))),
    );
  }
  if (statements.length) {
    await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
  }
  return { storePathsDeleted, narFilesDeleted, buildClosureDeleted };
}

/** 選択した store path を消した後に参照が残らない NAR の nar_files を返す。 */
export async function listReclaimableNarFiles(
  db: Db,
  selectedStorePaths: DeadStorePath[],
  orphanFiles: OrphanedNarFile[],
): Promise<ReclaimableNarObjects> {
  const selectedHashes = new Set(selectedStorePaths.map((row) => row.storeHash));
  const candidateKeys = new Set([
    ...selectedStorePaths.map((row) => row.narKey),
    ...orphanFiles.map((row) => row.narKey),
  ]);
  if (!candidateKeys.size) return { narKeys: [], fileHashes: [] };
  const [paths, files] = await Promise.all([
    db.select({ storeHash: storePaths.storeHash, narKey: storePaths.narKey }).from(storePaths),
    db.select({ narKey: narFiles.narKey, fileHash: narFiles.fileHash }).from(narFiles),
  ]);
  const hasRemainingPath = new Set(
    paths
      .filter((row) => !selectedHashes.has(row.storeHash))
      .map((row) => row.narKey),
  );
  const narKeys = [...candidateKeys].filter((key) => !hasRemainingPath.has(key));
  const reclaimableKeys = new Set(narKeys);
  return {
    narKeys,
    fileHashes: files
      .filter((row) => reclaimableKeys.has(row.narKey))
      .map((row) => row.fileHash),
  };
}

/**
 * 対象batchだけが参照するmanifest R2 keyを返す。
 * batch外のlive/dead buildとkeyを共有する場合は、後者のhistoryが消えるまでR2を残す。
 */
export async function listCollectableBuilds(
  db: Db,
  deadBuildIds: string[],
): Promise<CollectableManifestObjects> {
  if (!deadBuildIds.length) return { closureJsonKeys: [], manifestKeys: [] };
  const manifests = await db
    .select({
      buildId: buildManifests.buildId,
      closureJsonKey: buildManifests.closureJsonKey,
      manifestKey: buildManifests.manifestKey,
    })
    .from(buildManifests);
  const targetIds = new Set(deadBuildIds);
  // 同じR2 keyが相手側のどちらの列から参照されていても削除できない。
  // closure_json_key / manifest_key は別用途だが、R2 namespace は共通である。
  const sharedKeys = new Set(
    manifests
      .filter((manifest) => !targetIds.has(manifest.buildId))
      .flatMap((manifest) => [manifest.closureJsonKey, manifest.manifestKey]),
  );
  const targetManifests = manifests.filter((manifest) => targetIds.has(manifest.buildId));
  return {
    closureJsonKeys: [
      ...new Set(
        targetManifests
          .map((manifest) => manifest.closureJsonKey)
          .filter((key) => !sharedKeys.has(key)),
      ),
    ],
    manifestKeys: [
      ...new Set(
        targetManifests
          .map((manifest) => manifest.manifestKey)
          .filter((key) => !sharedKeys.has(key)),
      ),
    ],
  };
}

export async function deleteBuildHistory(db: Db, buildIds: string[]): Promise<number> {
  if (!buildIds.length) return 0;
  const deleted = await countByChunks(db, builds, builds.id, buildIds);
  for (let i = 0; i < buildIds.length; i += 999) {
    const chunk = buildIds.slice(i, i + 999);
    await db.batch([
      db.delete(buildClosure).where(inArray(buildClosure.buildId, chunk)),
      db.delete(buildManifests).where(inArray(buildManifests.buildId, chunk)),
      db.delete(rollbackRoots).where(inArray(rollbackRoots.buildId, chunk)),
      db.delete(builds).where(inArray(builds.id, chunk)),
    ] as unknown as Parameters<Db["batch"]>[0]);
  }
  return deleted;
}

/** staging、最新 N published、有効 rollback root、手動 pin を live root とする。 */
export async function computeLiveSet(db: Db, keepGenerations = 3): Promise<LiveSet> {
  const generations =
    Number.isSafeInteger(keepGenerations) && keepGenerations > 0
      ? keepGenerations
      : 0;
  const now = Date.now();
  const [allBuilds, roots, pins, paths, files] = await Promise.all([
    db
      .select({
        id: builds.id,
        host: builds.host,
        status: builds.status,
        createdAt: builds.createdAt,
        publishedAt: builds.publishedAt,
      })
      .from(builds),
    db
      .select({
        buildId: rollbackRoots.buildId,
        pinned: rollbackRoots.pinned,
        keepUntil: rollbackRoots.keepUntil,
      })
      .from(rollbackRoots),
    db.select({ buildId: pinnedBuilds.buildId }).from(pinnedBuilds),
    db
      .select({
        storeHash: storePaths.storeHash,
        narinfoKey: storePaths.narinfoKey,
        narKey: storePaths.narKey,
        fileHash: storePaths.fileHash,
      })
      .from(storePaths),
    db.select({ narKey: narFiles.narKey }).from(narFiles),
  ]);
  const liveBuildIds = new Set(
    allBuilds
      .filter((build) => build.status === "staging")
      .map((build) => build.id),
  );
  const publishedByHost = new Map<string, typeof allBuilds>();
  for (const build of allBuilds) {
    if (build.status !== "published") continue;
    const list = publishedByHost.get(build.host) ?? [];
    list.push(build);
    publishedByHost.set(build.host, list);
  }
  for (const list of publishedByHost.values()) {
    list.sort((a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt));
    for (const build of list.slice(0, generations)) liveBuildIds.add(build.id);
  }
  for (const root of roots) {
    // keep_until 未指定は従来どおり無期限の rollback root として扱う。
    if (root.pinned === 1 || root.keepUntil === null || root.keepUntil > now) {
      liveBuildIds.add(root.buildId);
    }
  }
  for (const pin of pins) liveBuildIds.add(pin.buildId);

  const liveClosure: { storeHash: string }[] = [];
  const ids = [...liveBuildIds];
  for (let i = 0; i < ids.length; i += 999) {
    const rows = await db
      .select({ storeHash: buildClosure.storeHash })
      .from(buildClosure)
      .where(inArray(buildClosure.buildId, ids.slice(i, i + 999)));
    liveClosure.push(...rows);
  }
  const liveStores = new Set(liveClosure.map((row) => row.storeHash));
  const liveNarKeys = new Set(
    paths
      .filter((path) => liveStores.has(path.storeHash))
      .map((path) => path.narKey),
  );
  return {
    liveNarKeys: [...liveNarKeys],
    deadCandidates: [
      ...new Set(
        files
          .map((file) => file.narKey)
          .filter((key) => !liveNarKeys.has(key)),
      ),
    ].sort(),
    deadStorePaths: paths
      .filter((path) => !liveStores.has(path.storeHash))
      .sort((a, b) => a.storeHash.localeCompare(b.storeHash)),
    deadBuildIds: allBuilds
      .filter((build) => !liveBuildIds.has(build.id))
      .sort(
        (a, b) =>
          (a.publishedAt ?? a.createdAt) - (b.publishedAt ?? b.createdAt),
      )
      .map((build) => build.id),
  };
}
