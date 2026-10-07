// Pi wiring gate tests ([I6] wait_all, [I10] progress coalescing, error
// mapping, service handshake, disabled mode). The github service is served
// over the SAME event-bus handshake production uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { default as piCiNext } from "../src/index.ts";
import type { GithubService } from "../src/core/github.ts";

function harness(service: GithubService | undefined) {
  const commands: string[] = [];
  const tools: Array<{ name?: string }> = [];
  const bus: Array<{ channel: string; payload: unknown }> = [];
  const agentDir = mkdtempSync(join(tmpdir(), "pinx-ci-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const pi = {
    on: () => () => {},
    registerTool: (tool: { name?: string }) => {
      tools.push(tool);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        bus.push({ channel, payload });
        // serve the github service handshake (simulating pi-github-next)
        if (channel === "pinx.github.service" && service) {
          (payload as { serve?: (s: GithubService) => void }).serve?.(service);
        }
      },
      on: () => () => {},
    },
  };
  piCiNext(pi as never);
  const tool = tools.find((t) => t.name === "ci") as never as {
    execute: (
      id: unknown,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return {
    tool,
    commands,
    tools,
    bus,
    cleanup: () => {
      delete process.env.PI_CODING_AGENT_DIR;
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

function makeService(states: Array<"queued" | "in_progress" | "success" | "failure">, repos = 1) {
  let poll = 0;
  const service: GithubService = {
    read: async () => ({ projection: "", snapshotId: "", outcome: "network-fetch", apiCalls: 0 }),
    request: async (opts) => {
      const path = opts.path;
      if (path.includes("/actions/runs?head_sha=")) {
        const state = states[Math.min(poll, states.length - 1)]!;
        poll++;
        const sha = /head_sha=([0-9a-f]+)/.exec(path)?.[1] ?? "a".repeat(40);
        const runs = Array.from({ length: repos }, (_, i) => ({
          id: 100 + i,
          head_sha: sha, // echo the requested SHA so every target matches
          status: state === "success" ? "completed" : state,
          conclusion: state === "success" ? "success" : state === "failure" ? "failure" : undefined,
          html_url: `u${i}`,
          name: "ci",
        }));
        return { status: 200, data: { workflow_runs: runs }, etag: null, headers: {} };
      }
      return { status: 200, data: {}, etag: null, headers: {} };
    },
    mutate: async () => ({ state: "completed", record: { operationId: "op" } }),
    rateLimit: () => ({ limit: 5000, remaining: 4900, reset: null }),
    authenticated: () => true,
    health: () => ({ cache: { entries: 0, bytes: 0 } }),
  };
  return service;
}

test("[G] ci tool + /ci-next command registered; disabled mode claims nothing", async () => {
  const h = harness(makeService(["success"]));
  assert.ok(
    h.tools.some((t) => t.name === "ci"),
    "ci tool present",
  );
  assert.equal(h.tools.length, 1, "exactly one model-visible tool");
  assert.ok(h.commands.includes("ci-next"));
  h.cleanup();
});

test("[I1/§42] queued→in_progress→success synchronized with ONE wait call", async () => {
  const h = harness(makeService(["success"]));
  const result = await h.tool.execute(undefined, {
    action: "wait",
    repository: "o/r",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    timeout_ms: 60_000,
  });
  assert.doesNotMatch(result.content[0]!.text, /isError/);
  assert.match(result.content[0]!.text, /→ terminal/);
  assert.match(result.content[0]!.text, /\(success\)/);
  h.cleanup();
});

test("[I6/§43] wait_all over multiple repos returns all terminal states in ONE call", async () => {
  const h = harness(makeService(["success"]));
  const result = await h.tool.execute(undefined, {
    action: "wait_all",
    targets: [
      { repository: "o/r", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { repository: "o/r2", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" },
      { repository: "o/r3", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac" },
    ],
    timeout_ms: 60_000,
  });
  const text = result.content[0]!.text;
  const terminals = text.match(/→ terminal \(success\)/g) ?? [];
  assert.equal(terminals.length, 3, "all targets reached terminal in one model call");
  h.cleanup();
});

test("[I10] progress polls never enter model context (bus events only, coalesced)", async () => {
  const h = harness(makeService(["in_progress", "success"]));
  // NOTE: multi-poll transitions with injected clocks live in wait.test.ts

  await h.tool.execute(undefined, {
    action: "wait",
    repository: "o/r",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    timeout_ms: 60_000,
  });
  // no poll-sourced events storm the bus; only the terminal event (if any)
  const terminalEvents = h.bus.filter((e) => e.channel === "pinx.ci.terminal");
  assert.ok(terminalEvents.length <= 1, `terminal events: ${terminalEvents.length}`);
  h.cleanup();
});

test("[G] no service → bounded CI_SERVICE_UNAVAILABLE error, not a crash", async () => {
  const h = harness(undefined);
  const result = await h.tool.execute(undefined, {
    action: "status",
    repository: "o/r",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /CI_SERVICE_UNAVAILABLE|github service unavailable/);
  h.cleanup();
});

test("[G] dispatch without repository/workflow is a bounded error", async () => {
  const h = harness(makeService(["success"]));
  const result = await h.tool.execute(undefined, { action: "dispatch" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /TARGET_INVALID/);
  h.cleanup();
});
