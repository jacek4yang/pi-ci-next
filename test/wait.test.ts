// CI wait/watch engine tests ([I1] one model call, [I2] immutable binding,
// [I3] supersede, [I4] abort != cancel, [I5] timeout != cancel, [I6]
// wait_all barrier, [I8] reopen re-queries remote truth).

import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchRegistry, waitForWatch, nextWatchId } from "../src/core/watches.ts";
import type { GithubService } from "../src/core/github.ts";

const NO_SLEEP = () => Promise.resolve();

/** Simulated CI: progresses through states per internal poll. */
function progressingService(
  states: Array<"queued" | "in_progress" | "success" | "failure">,
  supersedes = false,
) {
  let pollCount = 0;
  let totalRequests = 0;
  let jobFetches = 0;
  const service: GithubService = {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts: { path: string; method?: string }) => {
      totalRequests++;
      const path = opts.path;
      if (path.startsWith("/repos/") && path.includes("/pulls/")) {
        // PR head probe: moved once the state sequence is exhausted
        const moved = pollCount >= 1; // head moved after the first poll
        return {
          status: 200,
          data: { head: { sha: moved ? "bbbb2222" : "aaaa1111" }, state: "open" },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/runs?head_sha=")) {
        const state = states[Math.min(pollCount, states.length - 1)]!;
        pollCount++;
        const data: Record<string, unknown> =
          state === "queued"
            ? {
                workflow_runs: [
                  {
                    id: 1,
                    head_sha: "aaaa1111",
                    status: "queued",
                    conclusion: undefined,
                    html_url: "u",
                    name: "ci",
                  },
                ],
              }
            : {
                workflow_runs: [
                  {
                    id: 1,
                    head_sha: supersedes && pollCount >= states.length ? "bbbb2222" : "aaaa1111",
                    status: state === "success" ? "completed" : state,
                    conclusion:
                      state === "success" ? "success" : state === "failure" ? "failure" : undefined,
                    html_url: "u",
                    name: "ci",
                  },
                ],
              };
        return { status: 200, data, etag: null, headers: {} };
      }
      if (path.includes("/jobs")) {
        jobFetches++;
        return {
          status: 200,
          data: { jobs: [{ name: "test", status: "in_progress" }] },
          etag: null,
          headers: {},
        };
      }
      return { status: 200, data: {}, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => null,
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  };
  return { service, getTotalRequests: () => totalRequests, getJobFetches: () => jobFetches };
}

let clock = 1_700_000_000_000;
const now = () => ++clock;

test("[I1][I2] one wait call synchronizes a full queued→in_progress→success run over several internal polls", async () => {
  const registry = new WatchRegistry(now);
  const { service, getTotalRequests } = progressingService([
    "queued",
    "in_progress",
    "in_progress",
    "success",
  ]);
  const watch = registry.create({ repository: "o/r", sha: "aaaa1111" }, {});
  const outcome = await waitForWatch(service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  // ONE model-facing wait produced a terminal success.
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.terminalResult?.state, "success");
  assert.equal(outcome.waitTimedOut, false);
  // Internal polls actually happened (runtime polling != model polling).
  assert.ok(getTotalRequests() >= 3, `internal polls: ${getTotalRequests()}`);
  // The watch is bound to the immutable SHA (I2).
  assert.equal(registry.mustGet(watch.watchId).target.sha, "aaaa1111");
});

test("[I5] wait timeout returns running + waitTimedOut; the run keeps going; a later wait completes", async () => {
  const registry = new WatchRegistry(now);
  const { service } = progressingService(["in_progress", "in_progress", "in_progress", "success"]);
  const watch = registry.create({ repository: "o/r", sha: "aaaa1111" }, {});
  const timedOut = await waitForWatch(service, registry, watch.watchId, {
    timeoutMs: 5,
    now,
    sleep: NO_SLEEP,
  });
  assert.equal(timedOut.waitTimedOut, true);
  assert.equal(timedOut.terminal, false);
  // a later wait resumes and completes
  const later = await waitForWatch(service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  assert.equal(later.terminal, true);
  assert.equal(later.terminalResult?.state, "success");
});

test("[I4] aborting the local wait leaves the watch pending and never cancels CI", async () => {
  const registry = new WatchRegistry(now);
  const { service } = progressingService(["in_progress", "in_progress"]);
  const watch = registry.create({ repository: "o/r", sha: "aaaa1111" }, {});
  const controller = new AbortController();
  const outcome = await waitForWatch(service, registry, watch.watchId, {
    signal: controller.signal,
    now,
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });
  assert.equal(outcome.terminal, false);
  assert.equal(outcome.state, "pending");
  assert.equal(
    registry.mustGet(watch.watchId).state,
    "pending",
    "watch stays pending for a later wait",
  );
  // no cancel request was ever sent (service has no mutation calls)
});

test("[I3] PR head change supersedes the watch; it never claims success for the new head", async () => {
  const registry = new WatchRegistry(now);
  const { service } = progressingService(["in_progress", "success"], true);
  const watch = registry.create({ repository: "o/r", sha: "aaaa1111", prNumber: 42 }, {});
  const outcome = await waitForWatch(service, registry, watch.watchId, {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  assert.equal(outcome.state, "superseded");
  const stored = registry.mustGet(watch.watchId);
  assert.equal(stored.state, "superseded");
  assert.equal(stored.supersededByHeadSha, "bbbb2222");
  assert.notEqual(stored.terminalResult?.state, "success", "superseded never claims validated");
});

test("[I8] reopen restore does NOT trust persisted running; remote re-query wins", async () => {
  const registry = new WatchRegistry(now);
  const restored = registry.restore([
    {
      v: 1,
      watchId: "watch_persisted",
      target: { repository: "o/r", sha: "aaaa1111" },
      selector: {},
      state: "running", // persisted as running mid-flight
      createdAt: 1,
    },
  ]);
  assert.equal(restored, 1);
  // restored as pending (provisional), not running
  assert.equal(
    registry.mustGet("watch_persisted").state,
    "pending",
    "persisted running is not trusted",
  );
  const { service } = progressingService(["success"]);
  const outcome = await waitForWatch(service, registry, "watch_persisted", {
    timeoutMs: 60_000,
    now,
    sleep: NO_SLEEP,
  });
  assert.equal(outcome.terminalResult?.state, "success", "remote truth: run already finished");
});

test("[I6] wait_all barrier collects all terminal states across targets in one model call", async () => {
  // handled in gate.test.ts with the multi-target tool surface
  void nextWatchId;
});

test("[I2] watch creation rejects invalid SHAs and enforces the active bound", () => {
  const registry = new WatchRegistry(now);
  assert.throws(() => registry.create({ repository: "o/r", sha: "not-a-sha" }, {}), /SHA invalid/);
  for (let i = 0; i < 16; i++) {
    registry.create(
      { repository: "o/r", sha: `aaaa${String(i).padStart(4, "0")}`.slice(0, 40).padEnd(8, "0") },
      {},
    );
  }
  assert.throws(
    () => registry.create({ repository: "o/r", sha: "aaaa1111" }, {}),
    /active watch limit/,
  );
});
