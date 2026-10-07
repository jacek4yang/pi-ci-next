// Watch registry + wait engine (§25-§27, §18-§23).
//
// WATCH: bounded registry over immutable repo+SHA targets (I2). PR watches
// bind to the head SHA resolved ONCE; head movement supersedes (I3).
// Persistence: minimal watch records in the agent dir; after reopen the
// remote is ALWAYS re-queried — persisted "running" is never authoritative
// (I8/§26). GC: terminal watches bounded, active watches never dropped.
//
// WAIT: one model call parks on adaptive internal polling (I1) —
// immediate check, shorter interval while progressing, longer when
// unchanged, AbortSignal-aware, bounded deadline. Timeout returns
// state=running + waitTimedOut WITHOUT touching the workflow (I5);
// local abort likewise never cancels CI (I4).

import { STACK_INFO } from "../info.ts";
import type {
  CiError,
  CiRunState,
  CiTarget,
  CiWatch,
  RunSelector,
  RunSnapshot,
  TerminalResult,
  WatchState,
} from "./types.ts";
import {
  fetchJobs,
  isTerminalCiState,
  listRunsForSha,
  toSnapshot,
  type GithubService,
} from "./github.ts";

const Q = STACK_INFO.quotas;

function ciError(code: CiError["code"], message: string): CiError {
  const error = new Error(message) as CiError;
  error.code = code;
  return error;
}

let seq = 0;
export function nextWatchId(): string {
  return `watch_${Date.now().toString(36)}_${(++seq).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export interface PollSnapshot {
  snapshot: RunSnapshot | null;
  /** True when remote shows the PR head moved past our bound SHA. */
  superseded: boolean;
  /** The NEW head SHA when superseded (for supersededByHeadSha). */
  supersededHead?: string;
}

/** Shared GitHub-backed lookup: runs bound to a target + job progress. */
export async function snapshotForTarget(
  service: GithubService,
  target: CiTarget,
  selector: RunSelector,
  signal?: AbortSignal,
): Promise<PollSnapshot> {
  // Supersede check (I3): a PR-bound watch re-queries the PR head; movement
  // past our bound SHA ends the watch. Explicit-SHA watches are immutable
  // and never superseded.
  if (target.prNumber !== undefined) {
    try {
      const prResponse = await service.request({
        path: `/repos/${target.repository}/pulls/${target.prNumber}`,
        signal,
      });
      const head = (prResponse.data as { head?: { sha?: string } }).head?.sha;
      if (head && head !== target.sha)
        return { snapshot: null, superseded: true, supersededHead: head };
    } catch {
      // PR probe is best-effort; run matching below still applies
    }
  }
  const runs = await listRunsForSha(
    service,
    target.repository,
    target.sha,
    selector.workflow,
    signal,
  );
  const mine = runs.find((r) => r.head_sha === target.sha);
  if (!mine) return { snapshot: null, superseded: false };
  const snapshot = toSnapshot(mine);
  if (snapshot.state === "in_progress" || snapshot.state === "queued") {
    try {
      const jobs = await fetchJobs(service, target.repository, mine.id, signal);
      snapshot.jobs = jobs.map((j) => ({
        name: j.name,
        state: (j.status === "completed" ? "terminal" : (j.status as CiRunState)) as CiRunState,
        conclusion: j.conclusion,
      }));
    } catch {
      // job progress is best-effort
    }
  }
  return { snapshot, superseded: false };
}

export class WatchRegistry {
  private watches = new Map<string, CiWatch>();

  constructor(private readonly now: () => number = Date.now) {}

  create(target: CiTarget, selector: RunSelector, deadline?: number): CiWatch {
    if (this.active().length >= Q.maxActiveWatches) {
      throw ciError(
        "WATCH_NOT_FOUND",
        `active watch limit reached (${Q.maxActiveWatches}); await or cancel one`,
      );
    }
    if (!/^[0-9a-f]{7,40}$/.test(target.sha)) {
      throw ciError("TARGET_INVALID", `target SHA invalid: ${target.sha}`);
    }
    const watch: CiWatch = {
      v: 1,
      watchId: nextWatchId(),
      target,
      selector,
      state: "pending",
      createdAt: this.now(),
      deadline,
    };
    this.watches.set(watch.watchId, watch);
    this.gc();
    return watch;
  }

  get(watchId: string): CiWatch | undefined {
    return this.watches.get(watchId);
  }

  mustGet(watchId: string): CiWatch {
    const watch = this.watches.get(watchId);
    if (!watch) throw ciError("WATCH_NOT_FOUND", `no watch ${watchId}`);
    return watch;
  }

  update(watchId: string, patch: Partial<CiWatch>): CiWatch {
    const watch = this.mustGet(watchId);
    Object.assign(watch, patch);
    return watch;
  }

  /** Mark superseded when the target head SHA is no longer the PR head (I3). */
  supersede(watchId: string, newHeadSha: string): CiWatch {
    const watch = this.mustGet(watchId);
    watch.state = "superseded";
    watch.supersededByHeadSha = newHeadSha;
    watch.terminalResult = {
      state: "superseded" as never,
      headSha: watch.target.sha,
      runId: watch.lastSnapshot?.runId,
      concludedAt: this.now(),
    };
    return watch;
  }

  terminal(watchId: string, result: TerminalResult): CiWatch {
    const watch = this.mustGet(watchId);
    watch.state = "terminal";
    watch.terminalResult = result;
    return watch;
  }

  cancel(watchId: string): CiWatch {
    const watch = this.mustGet(watchId);
    watch.state = "cancelled";
    return watch;
  }

  active(): CiWatch[] {
    return [...this.watches.values()].filter((w) => w.state === "pending" || w.state === "running");
  }

  all(): CiWatch[] {
    return [...this.watches.values()];
  }

  /** Deterministic GC: oldest terminal watches beyond the bound. */
  private gc(): void {
    const terminal = this.all().filter(
      (w) =>
        w.state === "terminal" ||
        w.state === "expired" ||
        w.state === "cancelled" ||
        w.state === "superseded",
    );
    const excess = terminal.length - Q.maxTerminalRetained;
    if (excess <= 0) return;
    for (const watch of terminal.sort((a, b) => a.createdAt - b.createdAt).slice(0, excess)) {
      this.watches.delete(watch.watchId);
    }
  }

  /** Persistence records (bounded; refs only, never logs). */
  persistenceRecords(): Array<Record<string, unknown>> {
    return this.all()
      .filter((w) => w.state === "pending" || w.state === "running" || w.state === "terminal")
      .slice(0, Q.maxActiveWatches + Q.maxTerminalRetained)
      .map((w) => ({
        v: 1,
        watchId: w.watchId,
        target: w.target,
        selector: w.selector,
        state: w.state,
        createdAt: w.createdAt,
        deadline: w.deadline,
        terminalState: w.terminalResult?.state,
      }));
  }

  /** Restore persisted records; state stays provisional until re-queried. */
  restore(records: Array<Record<string, unknown>>): number {
    let restored = 0;
    for (const record of records) {
      const r = record as {
        v?: number;
        watchId?: string;
        target?: CiTarget;
        selector?: RunSelector;
        state?: WatchState;
        createdAt?: number;
        deadline?: number;
      };
      if (r?.v !== 1 || !r.watchId || !r.target || !/^[0-9a-f]{7,40}$/.test(r.target.sha ?? ""))
        continue;
      if (this.watches.has(r.watchId)) continue;
      const state: WatchState = r.state === "terminal" ? "terminal" : "pending"; // running is NOT trusted (I8)
      this.watches.set(r.watchId, {
        v: 1,
        watchId: r.watchId,
        target: r.target,
        selector: r.selector ?? {},
        state,
        createdAt: r.createdAt ?? this.now(),
        deadline: r.deadline,
      });
      restored++;
    }
    return restored;
  }
}

export interface WaitOutcome {
  watchId: string;
  state: WatchState;
  terminal: boolean;
  waitTimedOut: boolean;
  snapshot: RunSnapshot | null;
  terminalResult?: TerminalResult;
}

/** Adaptive internal poll loop (§19): RUNTIME POLLING != MODEL POLLING. */
export async function waitForWatch(
  service: GithubService,
  registry: WatchRegistry,
  watchId: string,
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (snapshot: RunSnapshot | null) => void;
    now?: () => number;
    /** Injectable pause (tests pass an immediate resolve). */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<WaitOutcome> {
  const watch = registry.mustGet(watchId);
  const nowFn = opts?.now ?? Date.now;
  const timeoutMs = Math.min(opts?.timeoutMs ?? Q.defaultWaitTimeoutMs, Q.maxWaitTimeoutMs);
  const deadline = nowFn() + timeoutMs;
  if (opts?.timeoutMs !== undefined) registry.update(watchId, { deadline });
  registry.update(watchId, { state: "running" });

  const pollCfg: {
    initialDelayMs: number;
    activeIntervalMs: number;
    unchangedIntervalMs: number;
    maxIntervalMs: number;
  } = Q.poll;
  let delay = pollCfg.initialDelayMs;
  let lastState: CiRunState | null = null;
  let lastSnapshot: RunSnapshot | null = watch.lastSnapshot ?? null;

  for (;;) {
    if (watch.state === "superseded" || watch.state === "cancelled") {
      return {
        watchId,
        state: watch.state,
        terminal: true,
        waitTimedOut: false,
        snapshot: lastSnapshot,
        terminalResult: watch.terminalResult,
      };
    }
    const poll = await snapshotForTarget(service, watch.target, watch.selector, opts?.signal);
    if (poll.superseded) {
      registry.supersede(watchId, poll.supersededHead ?? poll.snapshot?.headSha ?? "");
    }
    if (poll.snapshot) {
      lastSnapshot = poll.snapshot;
      registry.update(watchId, { lastSnapshot: poll.snapshot });
      // Supersede check: GitHub reports this run's head != our bound SHA.
      if (poll.snapshot.headSha && poll.snapshot.headSha !== watch.target.sha) {
        registry.supersede(watchId, poll.snapshot.headSha);
        return {
          watchId,
          state: "superseded",
          terminal: true,
          waitTimedOut: false,
          snapshot: lastSnapshot,
          terminalResult: watch.terminalResult,
        };
      }
    }
    const state = poll.snapshot?.state ?? "unknown";
    if (state !== lastState) {
      opts?.onProgress?.(lastSnapshot);
      lastState = state;
      delay = pollCfg.activeIntervalMs; // progress observed → stay attentive
    } else {
      delay = Math.min(delay * 2, pollCfg.maxIntervalMs); // unchanged → back off
    }
    if (isTerminalCiState(state) && poll.snapshot) {
      const result: TerminalResult = {
        state,
        headSha: poll.snapshot.headSha,
        runId: poll.snapshot.runId,
        runUrl: poll.snapshot.runUrl,
        concludedAt: nowFn(),
      };
      registry.terminal(watchId, result);
      return {
        watchId,
        state: "terminal",
        terminal: true,
        waitTimedOut: false,
        snapshot: lastSnapshot,
        terminalResult: result,
      };
    }
    if (nowFn() >= deadline) {
      // Timeout: local wait ends; the workflow keeps running (I5).
      return {
        watchId,
        state: watch.state === "running" ? "running" : watch.state,
        terminal: false,
        waitTimedOut: true,
        snapshot: lastSnapshot,
      };
    }
    if (opts?.signal?.aborted) {
      // Local abort: stop waiting only — CI keeps running (I4).
      registry.update(watchId, { state: "pending" });
      return {
        watchId,
        state: "pending",
        terminal: false,
        waitTimedOut: false,
        snapshot: lastSnapshot,
      };
    }
    await (opts?.sleep ?? sleep)(Math.min(delay, Math.max(1, deadline - nowFn())));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export type { WatchState, TerminalResult };
