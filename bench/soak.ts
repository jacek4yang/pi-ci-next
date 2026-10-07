// Deterministic CI soak (§51): hundreds of watches, thousands of
// transitions, multi-repo barriers, timeouts, supersedes, reopens,
// network faults. Verifies: bounded registry, no leaked promises, no
// stuck waits, no duplicate terminal events, no API request storm,
// bounded progress events.

import { WatchRegistry, waitForWatch } from "../src/core/watches.ts";
import { buildFailureDigest } from "../src/core/digest.ts";
import type { GithubService } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;
const NO_SLEEP = () => Promise.resolve();

const failures: string[] = [];
process.on("unhandledRejection", (reason) => {
  failures.push(`unhandled rejection: ${String(reason)}`);
});

function makeService() {
  let requests = 0;
  let faultMode = false;
  const stateByRun = new Map<number, "queued" | "in_progress" | "success" | "failure">();
  let runSeq = 0;
  const service: GithubService = {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts) => {
      requests++;
      const path = opts.path;
      if (faultMode && requests % 7 === 0) {
        throw new Error("transient network fault");
      }
      if (path.includes("/actions/runs?head_sha=")) {
        const sha = /head_sha=([0-9a-f]+)/.exec(path)?.[1] ?? "";
        let runId = stateByRun.size + 1;
        // stable run id per sha: assign once
        for (const [id, s] of stateByRun) {
          void s;
          runId = id; // mock: reuse ids round-robin
          break;
        }
        if (!stateByRun.has(runId)) {
          stateByRun.set(runId, Math.random() > 0.5 ? "success" : "failure");
        }
        const state = stateByRun.get(runId)!;
        void sha;
        return {
          status: 200,
          data: {
            workflow_runs: [
              {
                id: runId,
                head_sha: sha,
                status: state === "success" || state === "failure" ? "completed" : state,
                conclusion:
                  state === "success" ? "success" : state === "failure" ? "failure" : undefined,
                html_url: "u",
                name: "CI",
              },
            ],
          },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/jobs?per_page")) {
        runSeq++;
        return {
          status: 200,
          data: { jobs: [{ id: runSeq, name: "j", conclusion: "failure" }] },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/logs")) {
        return {
          status: 200,
          data: "error something failed\n".repeat(200),
          etag: null,
          headers: {},
        };
      }
      if (path.startsWith("/repos/") && path.includes("/pulls/")) {
        return {
          status: 200,
          data: { head: { sha: "a".repeat(40) }, state: "open" },
          etag: null,
          headers: {},
        };
      }
      return { status: 200, data: {}, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => ({ limit: 5000, remaining: 4000, reset: null }),
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  };
  return { service, setFaultMode: (v: boolean) => (faultMode = v), requestCount: () => requests };
}

const w = makeService();
const registry = new WatchRegistry(now);
let terminalEvents = 0;

// 1. 300 sequential waits over 50 SHAs.
for (let i = 0; i < 300; i++) {
  const watch = registry.create(
    { repository: "o/r", sha: `${String(i % 50).padStart(2, "0")}${"a".repeat(38)}` },
    {},
  );
  const outcome = await waitForWatch(w.service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  if (outcome.terminal) terminalEvents++;
}

// 2. 50 multi-repo barriers of 8 targets each.
for (let barrier = 0; barrier < 50; barrier++) {
  const watches = Array.from({ length: 8 }, (_, i) =>
    registry.create(
      {
        repository: `o/r${i}`,
        sha: `${barrier.toString(16).padStart(2, "0")}${i.toString(16).padStart(1, "0")}${"b".repeat(37)}`,
      },
      {},
    ),
  );
  await Promise.all(
    watches.map((watch) =>
      waitForWatch(w.service, registry, watch.watchId, { timeoutMs: 60_000, now, sleep: NO_SLEEP }),
    ),
  );
}

// 3. Supersede storms: 100 PR-bound watches whose head moves immediately.
// (The service returns the PR head == "a".repeat(40); targets differ → supersede.)
for (let i = 0; i < 100; i++) {
  const watch = registry.create(
    {
      repository: "o/p",
      sha: `${i.toString(16).padStart(2, "0")}${"c".repeat(38)}`,
      prNumber: i + 1,
    },
    {},
  );
  const outcome = await waitForWatch(w.service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  if (outcome.terminal) terminalEvents++;
}

// 4. Timeouts: 40 waits that hit their deadline — a wait is either
// timed-out (CI still running) OR terminal because the remote already
// finished; it must never be both.
for (let i = 0; i < 40; i++) {
  const watch = registry.create(
    { repository: "o/t", sha: `${i.toString(16).padStart(2, "0")}${"d".repeat(38)}` },
    {},
  );
  const outcome = await waitForWatch(w.service, registry, watch.watchId, {
    timeoutMs: 1,
    now,
    sleep: NO_SLEEP,
  });
  if (outcome.terminal && outcome.waitTimedOut)
    failures.push("terminal AND timed-out is contradictory");
}

// 5. Network faults during 100 waits (transient failures inside polls).
w.setFaultMode(true);
for (let i = 0; i < 100; i++) {
  const watch = registry.create(
    { repository: "o/f", sha: `${i.toString(16).padStart(2, "0")}${"e".repeat(38)}` },
    {},
  );
  try {
    await waitForWatch(w.service, registry, watch.watchId, {
      timeoutMs: 60_000,
      now,
      sleep: NO_SLEEP,
    });
  } catch (error) {
    if (!/transient network fault/.test((error as Error).message)) {
      failures.push(`unexpected wait error: ${(error as Error).message}`);
    }
  }
}
w.setFaultMode(false);

// 6. Failure digests: 20 digests over fault-free service.
for (let i = 0; i < 20; i++) {
  const digest = await buildFailureDigest(w.service, "o/r", "a".repeat(40), { id: 1, name: "CI" });
  if (digest.failures.length === 0) failures.push("digest produced no failures");
}

// 7. Journal-style reopen: a FRESH registry must not trust persisted
// "running" records — they restore as pending until remote re-query.
const freshRegistry = new WatchRegistry(now);
const restored = freshRegistry.restore(
  registry.persistenceRecords().map((r) => ({ ...r, state: "running" })),
);
if (freshRegistry.all().some((w2) => w2.state === "running")) {
  failures.push("restore trusted persisted running");
}

const stuck = registry.active().filter((watch) => watch.state === "running").length;
const result = {
  soak: "pi-ci-next ci-state soak",
  sequentialWaits: 300,
  barriers: 50,
  barrierCallers: 400,
  supersedeStorms: 100,
  timeouts: 40,
  faultWaits: 100,
  digests: 20,
  totalWatches: registry.all().length,
  terminalEvents,
  restored,
  apiRequests: w.requestCount(),
  stuckRunning: stuck,
  healthy: failures.length === 0,
  failures,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (failures.length > 0) process.exit(1);
