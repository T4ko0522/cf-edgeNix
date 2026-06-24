import { z } from "zod";

/** ホスト名: ASCII 英数字 / ドット / ハイフン / アンダースコアのみ */
export const HostSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, "Invalid host format");

/** build ID: UUID またはハイフン区切り英数字 */
export const BuildIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9-]+$/, "Invalid build ID format");

/** store hash: Nix base32 小文字英数字 */
export const StoreHashSchema = z
  .string()
  .min(1)
  .regex(/^[0-9a-z]+$/, "Invalid store hash format (must be lowercase base32)");

export type Host = z.infer<typeof HostSchema>;
export type BuildId = z.infer<typeof BuildIdSchema>;
export type StoreHash = z.infer<typeof StoreHashSchema>;
