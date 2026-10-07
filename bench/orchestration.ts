// CI orchestration benchmark (§49): deterministic model-call reduction
// measurements against simulated old (model-driven polling) vs new
// (internal adaptive polling) workflows. No live GitHub, no LLM.

import { WatchRegistry, waitForWatch } from "../src/core/watches.ts";
import { buildFailureDigest, renderFailureDigest } from "../src/core/digest.ts";
import type { GithubService } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;
const NO_SLEEP = () => Promise.resolve();

function makeService(
  pollResult: Array<"queued" | "in_progress" | "success" | "failure">,
  failedLog?: string,
) {
  let polls = 0;
  let jobListCalls = 0;
  let jobLogCalls = 0;
  const service: GithubService = {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts: { path: string; method?: string; etag?: string }) => {
      const path = opts.path;
      if (path.includes("/actions/runs?head_sha=")) {
        const state = pollResult[Math.min(polls, pollResult.length - 1)]!;
        polls++;
        const sha = /head_sha=([0-9a-f]+)/.exec(path)?.[1] ?? "a".repeat(40);
        return {
          status: 200,
          data: {
            workflow_runs: [
              {
                id: 9001,
                head_sha: sha, // echo the requested SHA so every target matches
                status: state === "success" ? "completed" : state,
                conclusion:
                  state === "success" ? "success" : state === "failure" ? "failure" : undefined,
                html_url: "run-url",
                name: "CI",
              },
            ],
          },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/jobs?per_page")) {
        jobListCalls++;
        return {
          status: 200,
          data: { jobs: [{ id: 1, name: "test", conclusion: "failure", url: "j" }] },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/logs")) {
        jobLogCalls++;
        return { status: 200, data: failedLog ?? "", etag: null, headers: {} };
      }
      return { status: 200, data: {}, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => ({ limit: 5000, remaining: 4900, reset: null }),
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  };
  return {
    service,
    polls: () => polls,
    jobListCalls: () => jobListCalls,
    jobLogCalls: () => jobLogCalls,
  };
}

const results: Record<string, unknown> = {};

// ---- Scenario A: one long CI run ----
{
  const w = makeService(["queued", "in_progress", "in_progress", "in_progress", "success"]);
  const registry = new WatchRegistry(now);
  const watch = registry.create({ repository: "o/r", sha: "a".repeat(40) }, {});
  const outcome = await waitForWatch(w.service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  const oldModelCalls = 5; // status-sleep-status-sleep-... one per state observation
  results.A_single_long_ci = {
    newModelCalls: 1,
    oldModelCalls,
    internalPolls: w.polls(),
    githubApiRequests: w.polls(),
    modelVisibleBytes: Buffer.byteLength(
      `watch ${watch.watchId} → terminal (success)\n  run: run-url`,
      "utf8",
    ),
    terminalState: outcome.terminalResult?.state,
  };
}

// ---- Scenario B: 8-repo barrier ----
{
  const w = makeService(["in_progress", "in_progress", "success"]);
  const registry = new WatchRegistry(now);
  const targets = Array.from({ length: 8 }, (_, i) => ({
    repository: `o/r${i}`,
    sha: `${String(i).repeat(2)}${"a".repeat(38)}`,
  }));
  const watches = targets.map((t) => registry.create(t, {}));
  const startCalls = w.polls();
  const outcomes = await Promise.all(
    watches.map((watch) =>
      waitForWatch(w.service, registry, watch.watchId, { timeoutMs: 60_000, now, sleep: NO_SLEEP }),
    ),
  );
  const apiCalls = w.polls() - startCalls;
  const allTerminal = outcomes.every((o) => o.terminal);
  const oldModelCalls = 8 * 3; // per-repo status/wait loops (24 model turns)
  results.B_eight_repo_barrier = {
    newModelCalls: 1,
    oldModelCalls,
    allTerminalInOneCall: allTerminal,
    underlyingApiRequests: apiCalls,
    modelVisibleBytes: Buffer.byteLength(
      outcomes.map((o) => `watch ${o.watchId} → terminal (success)`).join("\n"),
      "utf8",
    ),
  };
}

// ---- Scenario C: failure diagnosis ----
{
  const failedLog =
    Array.from({ length: 500 }, (_, i) => `log line ${i}`).join("\n") +
    "\nerror Command failed with exit code 1.";
  const w = makeService(["failure"], failedLog);
  const digest = await buildFailureDigest(w.service, "o/r", "a".repeat(40), {
    id: 9001,
    name: "CI",
  });
  const rendered = renderFailureDigest(digest);
  const oldModelCalls = 5; // run → jobs → job → logs → (manual scan context)
  const oldVisibleBytes = failedLog.length; // naive: whole log into context
  results.C_failure_diagnosis = {
    newModelCalls: 1,
    oldModelCalls,
    apiCalls: { jobList: w.jobListCalls(), jobLog: w.jobLogCalls() },
    modelVisibleBytes: Buffer.byteLength(rendered, "utf8"),
    oldModelVisibleBytes: oldVisibleBytes,
    bytesSaved: oldVisibleBytes - Buffer.byteLength(rendered, "utf8"),
    markerSelected: rendered.includes("error Command failed with exit code 1"),
  };
}

process.stdout.write(
  JSON.stringify({ bench: "pi-ci-next orchestration", results }, null, 2) + "\n",
);
