import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const builds = sqliteTable(
  "builds",
  {
    id: text("id").primaryKey(),
    host: text("host").notNull(),
    system: text("system").notNull(),
    gitRev: text("git_rev").notNull(),
    flakeLockHash: text("flake_lock_hash").notNull(),
    toplevelStorePath: text("toplevel_store_path").notNull(),
    status: text("status", { enum: ["staging", "published", "failed"] })
      .notNull()
      .default("staging"),
    retentionClass: text("retention_class"),
    createdAt: integer("created_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (t) => [index("idx_builds_host_published").on(t.host, t.publishedAt)],
);

export const storePaths = sqliteTable("store_paths", {
  storeHash: text("store_hash").primaryKey(),
  storePath: text("store_path").notNull(),
  narinfoKey: text("narinfo_key").notNull(),
  narKey: text("nar_key").notNull(),
  narHash: text("nar_hash").notNull(),
  narSize: integer("nar_size").notNull(),
  fileHash: text("file_hash").notNull(),
  fileSize: integer("file_size").notNull(),
  compression: text("compression").notNull(),
  firstSeenBuildId: text("first_seen_build_id"),
  createdAt: integer("created_at").notNull(),
});

export const narFiles = sqliteTable("nar_files", {
  fileHash: text("file_hash").primaryKey(),
  narKey: text("nar_key").notNull(),
  fileSize: integer("file_size").notNull(),
  compression: text("compression").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const buildClosure = sqliteTable(
  "build_closure",
  {
    buildId: text("build_id").notNull(),
    storeHash: text("store_hash").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.buildId, t.storeHash] }),
    index("idx_build_closure_store").on(t.storeHash),
  ],
);

export const rollbackRoots = sqliteTable("rollback_roots", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  buildId: text("build_id").notNull(),
  reason: text("reason"),
  pinned: integer("pinned").notNull().default(0),
  keepUntil: integer("keep_until"),
  createdAt: integer("created_at").notNull(),
});

export const pinnedBuilds = sqliteTable("pinned_builds", {
  buildId: text("build_id").primaryKey(),
  pinnedAt: integer("pinned_at").notNull(),
  reason: text("reason"),
});

export const buildManifests = sqliteTable(
  "build_manifests",
  {
    buildId: text("build_id").primaryKey(),
    host: text("host").notNull(),
    system: text("system").notNull(),
    gitRev: text("git_rev").notNull(),
    flakeLockHash: text("flake_lock_hash").notNull(),
    toplevelStorePath: text("toplevel_store_path").notNull(),
    closureJsonKey: text("closure_json_key").notNull(),
    manifestKey: text("manifest_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_build_manifests_host").on(t.host, t.createdAt)],
);

export type Build = typeof builds.$inferSelect;
export type StorePath = typeof storePaths.$inferSelect;
export type NarFile = typeof narFiles.$inferSelect;
export type BuildClosure = typeof buildClosure.$inferSelect;
export type RollbackRoot = typeof rollbackRoots.$inferSelect;
export type PinnedBuild = typeof pinnedBuilds.$inferSelect;
export type BuildManifest = typeof buildManifests.$inferSelect;
