// Failure digest (§32-35): deterministic evidence selection from failed
// CI runs — NO LLM anywhere. Marker-prioritized excerpts from failing job
// logs, head+tail fallback, explicit truncation envelopes (§35/I9).

import { STACK_INFO } from "../info.ts";
import type { CiError, FailureDigest } from "./types.ts";
import type { GithubService } from "./github.ts";

const Q = STACK_INFO.quotas.digest;

const FAILURE_MARKERS: RegExp[] = [
  /##\[error\]/i,
  /\berror\b/i,
  /\bfail(?:ed|ure)\b/i,
  /\bpanic\b/i,
  /\bassertion/i,
  /\bELIFECYCLE\b/,
  /expected.*(?:to|but)/i,
  /\bat .+\(.+:\d+:\d+\)/, // stack frame boundary
  /process exited with/i,
  /\bexit code [1-9]/i,
  /\btimed out\b/i,
];

function ciError(code: CiError["code"], message: string): CiError {
  const error = new Error(message) as CiError;
  error.code = code;
  return error;
}

interface JobApi {
  name?: string;
  conclusion?: string;
  status?: string;
  id?: number;
  url?: string;
  steps?: Array<{ name?: string; conclusion?: string; number?: number }>;
}

function selectExcerptLines(logText: string): {
  lines: string[];
  truncated: boolean;
  originalLines: number;
} {
  const allLines = logText.split("\n");
  const originalLines = allLines.length;
  const maxLines = Q.maxExcerptLines;
  const matched: Array<{ index: number; line: string }> = [];
  for (let i = 0; i < allLines.length; i++) {
    if (FAILURE_MARKERS.some((re) => re.test(allLines[i]!))) {
      matched.push({ index: i, line: allLines[i]! });
      if (matched.length >= maxLines) break;
    }
  }
  if (matched.length > 0) {
    return {
      lines: matched.map((m) => m.line.slice(0, Q.maxExcerptChars)),
      truncated: originalLines > matched.length,
      originalLines,
    };
  }
  // no markers: bounded head+tail of the failing step log
  const headCount = Math.ceil(maxLines / 2);
  const tailCount = maxLines - headCount;
  const selected = [
    ...allLines.slice(0, headCount),
    ...(tailCount > 0 ? allLines.slice(-tailCount) : []),
  ];
  return {
    lines: selected.map((l) => l.slice(0, Q.maxExcerptChars)),
    truncated: originalLines > maxLines,
    originalLines,
  };
}

/**
 * Build the failure digest for a failed run: workflow, failed jobs, failed
 * steps, marker-selected log excerpts, artifact refs, URLs. Bounded by
 * quotas; every truncation explicit.
 */
export async function buildFailureDigest(
  service: GithubService,
  repository: string,
  headSha: string,
  run: { id: number; name?: string; html_url?: string },
  signal?: AbortSignal,
): Promise<FailureDigest> {
  const jobsResponse = await service.request({
    path: `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
    signal,
  });
  const jobs = (jobsResponse.data as { jobs?: JobApi[] }).jobs ?? [];
  const failedJobs = jobs.filter((j) => j.conclusion === "failure").slice(0, Q.maxFailedJobs);
  if (failedJobs.length === 0) {
    throw ciError("CI_NOT_FOUND", "no failed jobs found on this run");
  }

  const digest: FailureDigest = {
    v: 1,
    repository,
    headSha,
    runId: run.id,
    runUrl: run.html_url,
    workflow: run.name,
    failures: [],
    truncated: false,
    strategy: "marker-excerpts",
  };

  for (const job of failedJobs) {
    const failedSteps = (job.steps ?? [])
      .filter((s) => s.conclusion === "failure")
      .slice(0, Q.maxStepsPerJob);
    const stepEntries: FailureDigest["failures"][number]["failedSteps"] = [];
    if (job.id !== undefined) {
      // Prefer the job logs API; bounded download (G6).
      try {
        const logResponse = await service.request({
          path: `/repos/${repository}/actions/jobs/${job.id}/logs`,
          signal,
        });
        const logText =
          typeof logResponse.data === "string"
            ? logResponse.data
            : JSON.stringify(logResponse.data ?? "").slice(0, Q.maxLogBytes);
        for (const step of failedSteps) {
          const stepName = step.name ?? `step ${step.number ?? "?"}`;
          const selected = selectExcerptLines(logText);
          stepEntries.push({
            stepName,
            conclusion: step.conclusion,
            excerpts: selected.lines,
            truncated: selected.truncated,
            originalLines: selected.originalLines,
          });
        }
        if (failedSteps.length === 0) {
          // job failed without per-step conclusions: digest the whole log
          const selected = selectExcerptLines(logText);
          stepEntries.push({
            stepName: "(job-level)",
            excerpts: selected.lines,
            truncated: selected.truncated,
            originalLines: selected.originalLines,
          });
        }
      } catch {
        stepEntries.push({
          stepName: failedSteps[0]?.name ?? "(job-level)",
          excerpts: ["(log unavailable — open the job URL for full logs)"],
          truncated: false,
        });
      }
    }
    digest.failures.push({
      jobName: job.name ?? `job ${job.id ?? "?"}`,
      jobUrl: job.url,
      failedSteps: stepEntries,
    });
  }

  digest.truncated = digest.failures.some((f) => f.failedSteps.some((s) => s.truncated));
  return digest;
}

/** Render the digest as a bounded model-visible result. */
export function renderFailureDigest(digest: FailureDigest): string {
  const lines = [
    `CI FAILURE — ${digest.repository} @ ${digest.headSha.slice(0, 10)}`,
    `workflow: ${digest.workflow ?? "?"} · run: ${digest.runId ?? "?"}${digest.runUrl ? ` (${digest.runUrl})` : ""}`,
  ];
  for (const failure of digest.failures) {
    lines.push(`job: ${failure.jobName}`);
    for (const step of failure.failedSteps) {
      lines.push(`  step: ${step.stepName} [${step.conclusion ?? "failure"}]`);
      for (const excerpt of step.excerpts) {
        lines.push(`    | ${excerpt}`);
      }
      if (step.truncated) {
        lines.push(
          `    [log truncated: ${step.originalLines ?? "?"} total lines — use logs action for full log]`,
        );
      }
    }
  }
  return lines.join("\n");
}
