// GitHub service client (CONTRACTS §12): obtains pi-github-next's shared
// stack over the event-bus handshake. Structural interface — no sibling
// imports. Single auth/cache/rate-limit/mutation-journal instance.

import type { ArtifactMeta, CiError, CiRunState, RunSnapshot } from "./types.ts";
import { STACK_INFO } from "../info.ts";

export interface GithubService {
  read(
    ref: unknown,
    opts?: { signal?: AbortSignal; withFiles?: boolean },
  ): Promise<{ projection: string; snapshotId: string; outcome: string; apiCalls: number }>;
  request(opts: {
    path: string;
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    allowRetry?: boolean;
  }): Promise<{
    status: number;
    data: unknown;
    etag: string | null;
    headers: Record<string, string>;
  }>;
  mutate(
    intent: unknown,
    opts?: { signal?: AbortSignal; cancelled?: () => boolean },
  ): Promise<{
    state: string;
    resultRef?: string;
    reason?: string;
    record: { operationId: string };
  }>;
  rateLimit(): { limit: number | null; remaining: number | null; reset: number | null } | null;
  authenticated(): boolean;
  health(): { cache: { entries: number; bytes: number } };
}

/** Obtain the shared GitHub service (bounded retries while plugins load). */
export function requestGithubService(
  pi: { events: { emit: (channel: string, payload: unknown) => void } },
  attempts = 20,
): Promise<GithubService> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      n++;
      let answered = false;
      pi.events.emit(STACK_INFO.consumed.githubService, {
        v: 1,
        serve: (service: GithubService) => {
          answered = true;
          resolve(service);
        },
      });
      if (answered) return;
      if (n >= attempts) {
        const error = new Error(
          "github service unavailable — pi-github-next must be installed and enabled",
        ) as CiError;
        error.code = "CI_SERVICE_UNAVAILABLE";
        reject(error);
        return;
      }
      setTimeout(tryOnce, 50);
    };
    tryOnce();
  });
}

function ciError(code: CiError["code"], message: string): CiError {
  const error = new Error(message) as CiError;
  error.code = code;
  return error;
}

/** Resolve a PR to its head SHA (once — §15). */
export async function resolvePrHead(
  service: GithubService,
  repository: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<{ sha: string; state: string }> {
  const response = await service.request({
    path: `/repos/${repository}/pulls/${prNumber}`,
    signal,
  });
  const pr = response.data as { head?: { sha?: string }; state?: string };
  if (!pr?.head?.sha) throw ciError("TARGET_INVALID", `PR #${prNumber} has no head SHA`);
  return { sha: pr.head.sha, state: pr.state ?? "unknown" };
}

/** List workflow runs bound to a repo+SHA (target identity, §15). */
export async function listRunsForSha(
  service: GithubService,
  repository: string,
  sha: string,
  workflow?: string,
  signal?: AbortSignal,
): Promise<
  Array<{
    id: number;
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string;
    html_url?: string;
  }>
> {
  const wf = workflow ? `&workflow=${encodeURIComponent(workflow)}` : "";
  const response = await service.request({
    path: `/repos/${repository}/actions/runs?head_sha=${sha}${wf}&per_page=20`,
    signal,
  });
  const data = response.data as { workflow_runs?: Array<Record<string, unknown>> };
  return Array.isArray(data?.workflow_runs) ? (data.workflow_runs as never) : [];
}

/** Fetch job list for a run. */
export async function fetchJobs(
  service: GithubService,
  repository: string,
  runId: number,
  signal?: AbortSignal,
): Promise<
  Array<{
    name: string;
    status?: string;
    conclusion?: string;
    started_at?: string;
    completed_at?: string;
    url?: string;
    id?: number;
  }>
> {
  const response = await service.request({
    path: `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
    signal,
  });
  const data = response.data as { jobs?: Array<Record<string, unknown>> };
  return Array.isArray(data?.jobs) ? (data.jobs as never) : [];
}

/** Map GitHub run status+conclusion to our state vocabulary. */
export function runStateOf(status?: string, conclusion?: string): CiRunState {
  switch (status) {
    case "queued":
    case "waiting":
    case "pending":
      return "queued";
    case "in_progress":
      return "in_progress";
    case "completed":
      switch (conclusion) {
        case "success":
          return "success";
        case "failure":
          return "failure";
        case "cancelled":
          return "cancelled";
        case "skipped":
          return "skipped";
        case "neutral":
          return "neutral";
        default:
          return "unknown";
      }
    default:
      return "unknown";
  }
}

export function toSnapshot(
  run: {
    id: number;
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string;
    html_url?: string;
  },
  jobs?: Array<{ name: string; status?: string; conclusion?: string }>,
): RunSnapshot {
  const state = runStateOf(run.status, run.conclusion);
  return {
    runId: run.id,
    runUrl: run.html_url,
    state,
    conclusion: run.conclusion,
    headSha: run.head_sha ?? "",
    workflowName: run.name,
    ...(jobs
      ? {
          jobs: jobs.map((j) => ({
            name: j.name,
            state: runStateOf(j.status, j.conclusion),
            conclusion: j.conclusion,
          })),
        }
      : {}),
    fetchedAt: Date.now(),
  };
}

/** Artifact metadata (§36) — identities only, no downloads. */
export async function listArtifacts(
  service: GithubService,
  repository: string,
  runId: number,
  signal?: AbortSignal,
): Promise<ArtifactMeta[]> {
  const response = await service.request({
    path: `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=50`,
    signal,
  });
  const data = response.data as {
    artifacts?: Array<{
      id: number;
      name: string;
      size_in_bytes?: number;
      expired?: boolean;
      archive_download_url?: string;
    }>;
  };
  return Array.isArray(data?.artifacts)
    ? data.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        sizeBytes: a.size_in_bytes ?? 0,
        expired: a.expired === true,
        url: a.archive_download_url,
      }))
    : [];
}

/** Terminate terminal-state set. */
export function isTerminalCiState(state: CiRunState): boolean {
  return (
    state === "success" ||
    state === "failure" ||
    state === "cancelled" ||
    state === "skipped" ||
    state === "neutral" ||
    state === "unknown"
  );
}
