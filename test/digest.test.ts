// Failure digest tests ([I9] explicit truncation, deterministic marker
// selection — Windows Prettier failure + Linux test assertion fixtures).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFailureDigest, renderFailureDigest } from "../src/core/digest.ts";
import type { GithubService } from "../src/core/github.ts";

const prettierLog = [
  "> repo@ lint",
  "> prettier --check .",
  "",
  "Checking formatting...",
  "[warn] src/deep/module.ts",
  "[warn] Code style issues found in 2 files.",
  "error Command failed with exit code 1.",
  "$ The lint invocation failed.",
].join("\n");

const assertionLog = [
  "> npm test",
  "",
  "not ok 12 - processPendingSubtests preserves order",
  "  ---",
  "  operator: deepEqual",
  "  expected: |-\n    1",
  "  actual: |-\n    2",
  "  ...",
  "Error: expected 1 but got 2",
  "npm ERR! Test failed. See above for more details.",
].join("\n");

function digestService(logByJob: Record<number, string>): GithubService {
  return {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts: { path: string; method?: string }) => {
      const path = opts.path;
      if (path.includes("/jobs?per_page")) {
        return {
          status: 200,
          data: {
            jobs: [
              { id: 1, name: "lint (windows-latest)", conclusion: "failure", url: "u1" },
              { id: 2, name: "test (ubuntu-latest)", conclusion: "failure", url: "u2" },
              { id: 3, name: "build", conclusion: "success" },
            ],
          },
          etag: null,
          headers: {},
        };
      }
      if (path.includes("/jobs/1/logs"))
        return { status: 200, data: logByJob[1]!, etag: null, headers: {} };
      if (path.includes("/jobs/2/logs"))
        return { status: 200, data: logByJob[2]!, etag: null, headers: {} };
      return { status: 200, data: {}, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => null,
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  } as unknown as GithubService;
}

test("[I9] one failure_digest identifies workflow/job/step/evidence for BOTH fixture failures", async () => {
  const service = digestService({ 1: prettierLog, 2: assertionLog });
  const digest = await buildFailureDigest(service, "o/r", "aaaa1111", {
    id: 9001,
    name: "CI",
    html_url: "run-url",
  });
  const rendered = renderFailureDigest(digest);

  assert.match(rendered, /CI FAILURE — o\/r @ aaaa1111/);
  assert.match(rendered, /workflow: CI/);
  assert.match(rendered, /job: lint \(windows-latest\)/);
  assert.match(rendered, /error Command failed with exit code 1/);
  assert.match(rendered, /job: test \(ubuntu-latest\)/);
  assert.match(rendered, /Error: expected 1 but got 2/);
  // successful jobs are excluded
  assert.ok(!rendered.includes("build"), "successful job not in digest");
});

test("[I9] no-marker logs fall back to bounded head+tail, explicitly", async () => {
  const quietLog = Array.from({ length: 200 }, (_, i) => `step line ${i + 1}`).join("\n");
  const service = digestService({ 1: quietLog, 2: quietLog });
  const digest = await buildFailureDigest(service, "o/r", "aaaa1111", { id: 9001, name: "CI" });
  assert.equal(digest.strategy, "marker-excerpts");
  const job = digest.failures[0]!;
  const step = job.failedSteps[0]!;
  assert.equal(step.truncated, true, "explicitly marked truncated");
  assert.equal(step.originalLines, 200, "original line count reported");
  // head+tail: first and last lines retained
  assert.ok(step.excerpts.some((l) => l.startsWith("step line 1")));
  assert.ok(step.excerpts.some((l) => l.startsWith("step line 200")));
});

test("[I9] digest is bounded: failed-job count capped at 5", async () => {
  let logIndex = 0;
  const service: GithubService = {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts: { path: string; method?: string }) => {
      if (opts.path.includes("/jobs?per_page")) {
        return {
          status: 200,
          data: {
            jobs: Array.from({ length: 10 }, (_, i) => ({
              id: i + 1,
              name: `job${i}`,
              conclusion: "failure",
            })),
          },
          etag: null,
          headers: {},
        };
      }
      logIndex++;
      return { status: 200, data: `error in job ${logIndex}`, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => null,
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  } as unknown as GithubService;
  const digest = await buildFailureDigest(service, "o/r", "aaaa1111", { id: 1 });
  assert.ok(digest.failures.length <= 5, `capped at 5 (got ${digest.failures.length})`);
  void renderFailureDigest;
});
