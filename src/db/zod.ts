import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
  buildClosure,
  buildManifests,
  builds,
  narFiles,
  pinnedBuilds,
  rollbackRoots,
  storePaths,
} from "./schema";

// ─── DB 層 schema（API schema とは別物）─────────────────────────────────────
// drizzle-zod が Drizzle テーブル定義から自動生成する。
// これらは DB insert/select の入出力形を表し、API contract (src/schemas/) とは分離する。

export const BuildSelectSchema = createSelectSchema(builds);
export const BuildInsertSchema = createInsertSchema(builds);

export const StorePathSelectSchema = createSelectSchema(storePaths);
export const StorePathInsertSchema = createInsertSchema(storePaths);

export const NarFileSelectSchema = createSelectSchema(narFiles);
export const NarFileInsertSchema = createInsertSchema(narFiles);

export const PinnedBuildSelectSchema = createSelectSchema(pinnedBuilds);
export const PinnedBuildInsertSchema = createInsertSchema(pinnedBuilds);

export const BuildClosureSelectSchema = createSelectSchema(buildClosure);
export const BuildClosureInsertSchema = createInsertSchema(buildClosure);

export const RollbackRootSelectSchema = createSelectSchema(rollbackRoots);
export const RollbackRootInsertSchema = createInsertSchema(rollbackRoots);

export const BuildManifestSelectSchema = createSelectSchema(buildManifests);
export const BuildManifestInsertSchema = createInsertSchema(buildManifests);
