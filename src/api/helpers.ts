import { BuildNotFoundError, PublishConflictError } from "../db/queries";

export function errorStatus(err: unknown): 400 | 404 | 409 | 500 {
  if (err instanceof PublishConflictError) return 409;
  if (err instanceof BuildNotFoundError) return 404;
  return 500;
}

/**
 * 既知エラー型は意味あるメッセージを返す。
 * それ以外（DB 例外等）は汎用 500 メッセージのみ（内部 message/スタックを body に出さない）。
 * 修正12: D1 制約名・テーブル名等の内部情報を漏らさない。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof PublishConflictError) return err.message;
  if (err instanceof BuildNotFoundError) return err.message;
  return "internal server error";
}

/**
 * PublishConflictError に conflictingStoreHash が付いている場合のみ、その値を含む
 * 構造化 body を返す。それ以外は { error } のみ。
 * ApiErrorSchema の conflictingStoreHash は optional なので他エンドポイントの
 * レスポンスに影響しない。
 */
export function errorBody(err: unknown): { error: string; conflictingStoreHash?: string } {
  const base = { error: errorMessage(err) };
  if (err instanceof PublishConflictError && err.conflictingStoreHash) {
    return { ...base, conflictingStoreHash: err.conflictingStoreHash };
  }
  return base;
}
