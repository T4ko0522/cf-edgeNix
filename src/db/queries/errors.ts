/** 同一 build_id が published 済みで、異なる payload で再投入しようとした場合 (409) */
export class PublishConflictError extends Error {
  readonly status = 409 as const;
  /** 衝突した store_paths.store_hash（ingest 経路でのみ設定される）。 */
  readonly conflictingStoreHash?: string;
  constructor(message: string, opts?: { conflictingStoreHash?: string }) {
    super(message);
    this.name = "PublishConflictError";
    if (opts?.conflictingStoreHash) {
      this.conflictingStoreHash = opts.conflictingStoreHash;
    }
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
