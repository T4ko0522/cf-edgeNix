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
