export interface BuildMeta {
  id: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  createdAt: number;
}

export interface NarinfoMeta {
  storeHash: string;
  storePath: string;
  narinfoKey: string;
  narKey: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  fileSize: number;
  compression: string;
  firstSeenBuildId?: string;
}

export interface ManifestMeta {
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  closureJsonKey: string;
  manifestKey: string;
  manifestHash: string;
}

export interface RollbackRootInput {
  id: string;
  host: string;
  buildId: string;
  reason?: string;
  pinned?: boolean;
  keepUntil?: number;
}

export interface LiveSet {
  liveNarKeys: string[];
  deadCandidates: string[];
}

export interface DeadStorePath {
  storeHash: string;
  narinfoKey: string;
  narKey: string;
  fileHash: string;
}
