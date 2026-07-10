/** publish 状態機械の immutable field / 状態が不一致の場合 (409) */
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
