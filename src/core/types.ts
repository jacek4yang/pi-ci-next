// Pure CI core types. No Pi imports.

/** Terminal CI states (GitHub Actions semantics + local watch states). */
export type CiRunState =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "unknown";

export type WatchState =
  "pending" | "running" | "terminal" | "superseded" | "cancelled" | "expired";

/**
 * The authoritative CI target: repository + commit SHA (§15).
 * A PR resolves to its head SHA ONCE; head changes supersede the watch.
 */
export interface CiTarget {
  repository: string; // owner/name
  sha: string; // immutable commit SHA
  /** Optional provenance (never used for identity). */
  prNumber?: number;
  branch?: string;
}

/** Selector for finding runs bound to a target. */
export interface RunSelector {
  /** Workflow name or file filter (e.g. "ci.yml"); undefined = any workflow. */
  workflow?: string;
}

export interface RunSnapshot {
  runId: number;
  runUrl?: string;
  state: CiRunState;
  conclusion?: string;
  headSha: string;
  workflowName?: string;
  /** Job-level progress when available. */
  jobs?: Array<{ name: string; state: CiRunState; conclusion?: string }>;
  fetchedAt: number;
}

export interface CiWatch {
  v: 1;
  watchId: string;
  target: CiTarget;
  selector: RunSelector;
  state: WatchState;
  createdAt: number;
  /** Wall-clock deadline for waits bound to this watch (null = none). */
  deadline?: number;
  lastSnapshot?: RunSnapshot;
  /** Terminal result once reached (filled on terminal/superseded). */
  terminalResult?: TerminalResult;
  supersededByHeadSha?: string;
}

export interface TerminalResult {
  state: CiRunState; // success | failure | cancelled | skipped | neutral | superseded
  headSha?: string;
  runId?: number;
  runUrl?: string;
  /** Failure digest reference for failure outcomes. */
  failureDigest?: FailureDigest;
  concludedAt: number;
}

export interface WatchPersistenceRecord extends Record<string, unknown> {
  v: 1;
  watchId: string;
  target: CiTarget;
  selector: RunSelector;
  state: WatchState;
  createdAt: number;
  deadline?: number;
  terminalState?: string;
}

/** Deterministic failure evidence (§32-35) — no LLM anywhere. */
export interface FailureDigest {
  v: 1;
  repository: string;
  headSha: string;
  runId?: number;
  runUrl?: string;
  workflow?: string;
  failures: Array<{
    jobName: string;
    jobUrl?: string;
    failedSteps: Array<{
      stepName: string;
      conclusion?: string;
      /** Deterministic marker-selected excerpts. */
      excerpts: string[];
      truncated: boolean;
      originalLines?: number;
    }>;
  }>;
  /** Explicit truncation envelope summary. */
  truncated: boolean;
  strategy: "marker-excerpts" | "head-tail";
}

export interface ArtifactMeta {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  url?: string;
}

export interface CiError extends Error {
  code:
    | "CI_NOT_FOUND"
    | "CI_AUTH"
    | "CI_PERMISSION"
    | "CI_RATE_LIMITED"
    | "CI_NETWORK"
    | "CI_SERVICE_UNAVAILABLE"
    | "WATCH_NOT_FOUND"
    | "WATCH_TERMINAL"
    | "TARGET_INVALID";
}
