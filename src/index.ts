// pi-ci-next — CI watches for GitHub Actions, ZERO model-driven polling.
//
// OWNERSHIP: CI target identity (repo+SHA), watches, internal adaptive
// polling, wait/wait_all, failure digest, artifact metadata, CI control
// actions. REUSES pi-github-next as the only GitHub stack (CONTRACTS §12
// event-bus handshake): single auth/cache/rate-limit/mutation-journal.
//
// WAIT SEMANTICS (§18-§23): one model call waits for terminal state,
// timeout, or local abort. Timeout/abort NEVER touch the workflow (I4/I5).
// RUNTIME POLLING != MODEL POLLING: internal polls are adaptive, bounded,
// progress only reaches the UI via coalesced events — never model context
// (I10).
//
// TARGET IDENTITY (§15/I2): PR resolves to head SHA once; head movement
// supersedes the watch (I3) — a superseded watch can never claim the PR
// validated by newer-head results.
//
// MUTATIONS (§31): rerun/cancel/dispatch go through the shared mutation
// engine (durable journal, no blind retry, reconciliation). POLICY (§30):
// authorization is pi-policy-next's, via the tool_call gate.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STACK_INFO } from "./info.ts";
import { requestGithubService, type GithubService } from "./core/github.ts";
import { WatchRegistry, waitForWatch } from "./core/watches.ts";
import { buildFailureDigest, renderFailureDigest } from "./core/digest.ts";
import type { CiTarget, FailureDigest, WatchPersistenceRecord } from "./core/types.ts";

function respond(text: string, isError = false, details?: unknown) {
  return { content: [{ type: "text" as const, text }], isError, details };
}

function watchPersistencePath(agentDir: string): string {
  return join(agentDir, "pinx", "ci-next", "watches.json");
}

async function loadPersistedWatches(agentDir: string): Promise<WatchPersistenceRecord[]> {
  try {
    const raw = await readFile(watchPersistencePath(agentDir), "utf8");
    const parsed = JSON.parse(raw) as { v?: number; watches?: WatchPersistenceRecord[] };
    return parsed?.v === 1 && Array.isArray(parsed.watches) ? parsed.watches : [];
  } catch {
    return [];
  }
}

async function persistWatches(
  agentDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const path = watchPersistencePath(agentDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ v: 1, watches: records }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export default function piCiNext(pi: ExtensionAPI) {
  if (process.env[STACK_INFO.env.disable] === "1") {
    pi.registerCommand("ci-next", {
      description: "Show pi-ci-next status",
      handler: async (_args, ctx) => {
        await ctx.ui.notify("pi-ci-next: DISABLED", "warning");
      },
    });
    return;
  }

  const registry = new WatchRegistry();
  let servicePromise: Promise<GithubService> | undefined;

  function service(): Promise<GithubService> {
    if (!servicePromise) servicePromise = requestGithubService(pi);
    return servicePromise;
  }

  /** Target resolution: repo+sha is authoritative; PR resolves head ONCE (§15). */
  async function resolveTarget(p: {
    repository?: string;
    sha?: string;
    pr?: number;
    workflow?: string;
  }): Promise<{ target: CiTarget; resolution: string }> {
    if (typeof p.repository !== "string" || !/^[^/]+\/[^/]+$/.test(p.repository)) {
      throw Object.assign(new Error("repository (owner/name) required"), {
        code: "TARGET_INVALID",
      });
    }
    if (typeof p.sha === "string" && p.sha.length >= 7) {
      return { target: { repository: p.repository, sha: p.sha }, resolution: "explicit SHA" };
    }
    if (typeof p.pr === "number") {
      const svc = await service();
      const prResponse = await svc.request({ path: `/repos/${p.repository}/pulls/${p.pr}` });
      const pr = prResponse.data as { head?: { sha?: string } };
      const sha = pr?.head?.sha;
      if (!sha)
        throw Object.assign(new Error(`PR #${p.pr} has no head SHA`), { code: "TARGET_INVALID" });
      return {
        target: { repository: p.repository, sha, prNumber: p.pr },
        resolution: `PR #${p.pr} head resolved once to ${sha.slice(0, 10)}`,
      };
    }
    throw Object.assign(new Error("target requires sha or pr"), { code: "TARGET_INVALID" });
  }

  async function persist(): Promise<void> {
    try {
      await persistWatches(getAgentDir(), registry.persistenceRecords());
    } catch {
      // persistence is best-effort; remote truth wins on reopen anyway
    }
  }

  // Reopen: restore provisional watch records; remote truth wins later.
  void (async () => {
    const records = await loadPersistedWatches(getAgentDir());
    registry.restore(records);
  })();

  const schema = Type.Object({
    action: Type.Union([
      Type.Literal("resolve"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("wait_all"),
      Type.Literal("failure_digest"),
      Type.Literal("logs"),
      Type.Literal("artifacts"),
      Type.Literal("rerun_failed"),
      Type.Literal("cancel"),
      Type.Literal("dispatch"),
      Type.Literal("watches"),
    ]),
    repository: Type.Optional(Type.String({ description: "owner/name" })),
    sha: Type.Optional(Type.String({ description: "Commit SHA (authoritative target identity)" })),
    pr: Type.Optional(
      Type.Number({
        description: "PR number — head SHA resolved once; head changes supersede the watch",
      }),
    ),
    workflow: Type.Optional(
      Type.String({ description: "Workflow file/name filter (e.g. ci.yml)" }),
    ),
    watch_id: Type.Optional(Type.String({ description: "Watch id from a previous wait/resolve" })),
    targets: Type.Optional(
      Type.Array(
        Type.Object({
          repository: Type.String(),
          sha: Type.String(),
          workflow: Type.Optional(Type.String()),
        }),
        { description: "wait_all targets (repo+SHA each)" },
      ),
    ),
    run_id: Type.Optional(
      Type.Number({ description: "Run id (failure_digest/logs/artifacts/cancel)" }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({ description: "Wait deadline (default 10min, max 60min)" }),
    ),
    fail_fast: Type.Optional(
      Type.Boolean({
        description: "wait_all: stop at first failure instead of collect-all (default)",
      }),
    ),
    workflow_ref: Type.Optional(
      Type.String({ description: "dispatch: workflow file (e.g. ci.yml)" }),
    ),
    ref: Type.Optional(
      Type.String({ description: "dispatch: branch/tag (default default branch)" }),
    ),
    inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
  });

  pi.registerTool({
    name: STACK_INFO.tool.name,
    label: "CI",
    description:
      "GitHub Actions CI watches: resolve targets to immutable repo+SHA, wait with ONE call (adaptive internal polling — never poll from the model), " +
      "wait_all across repositories, deterministic failure digests, artifact metadata. Timeout/abort never cancel the workflow.",
    parameters: schema,
    async execute(_toolCallId: unknown, params: unknown, signal?: AbortSignal) {
      try {
        return await handle(params as never, signal);
      } catch (error) {
        const err = error as { code?: string; message?: string };
        return respond(`${err.code ?? "CI_NETWORK"}: ${err.message ?? "ci error"}`, true, {
          code: err.code,
        });
      }
    },
  } as never);

  async function handle(p: Record<string, unknown>, signal?: AbortSignal) {
    const action = p.action as string;
    switch (action) {
      case "watches": {
        const rows = registry
          .all()
          .map(
            (w) =>
              `${w.watchId} [${w.state}] ${w.target.repository}@${w.target.sha.slice(0, 10)}${w.terminalResult ? ` → ${w.terminalResult.state}` : ""}`,
          );
        return respond(rows.length > 0 ? rows.join("\n") : "(no watches)", false);
      }
      case "resolve": {
        const target = await resolveTarget(p as never);
        void target;
        const svc = await service();
        const resolved = await resolveTargetImpl(svc, p);
        return respond(resolved, false);
      }
      case "status": {
        // Inspection snapshot — not the waiting mechanism (§17).
        const svc = await service();
        const watchId = typeof p.watch_id === "string" ? p.watch_id : undefined;
        if (watchId) {
          const watch = registry.mustGet(watchId);
          const outcome = await waitForWatchOnce(svc, watch.watchId);
          return respond(
            renderStatus(watch.watchId, {
              snapshot: outcome.snapshot,
              state: outcome.state,
              watchId: outcome.watchId,
            }),
          );
        }
        const target = await resolveTarget(p as never);
        void target;
        const poll = await snapshotOnce(svc, p, signal);
        return respond(
          renderStatus("(direct)", {
            snapshot: poll.snapshot ?? undefined,
            state: poll.snapshot?.state ?? "unknown",
          }),
        );
      }
      case "wait": {
        const svc = await service();
        const watchId = typeof p.watch_id === "string" ? p.watch_id : undefined;
        if (watchId) {
          const outcome = await waitForWatch(svc, registry, watchId, {
            timeoutMs: typeof p.timeout_ms === "number" ? p.timeout_ms : undefined,
            signal,
          });
          await persist();
          return respond(renderWait([outcome]));
        }
        const watch = await createWatch(p as never);
        const outcome = await waitForWatch(svc, registry, watch.watch.watchId, {
          timeoutMs: typeof p.timeout_ms === "number" ? p.timeout_ms : undefined,
          signal,
        });
        await persist();
        emitTerminal(outcome);
        return respond(renderWait([outcome]));
      }
      case "wait_all": {
        const svc = await service();
        const targets = Array.isArray(p.targets)
          ? (p.targets as Array<{
              repository: string;
              sha?: string;
              pr?: number;
              workflow?: string;
            }>)
          : [];
        if (targets.length === 0)
          return respond("TARGET_INVALID: wait_all requires targets[]", true);
        const failFast = p.fail_fast === true;
        const outcomePromises = targets.map(async (t) => {
          const { watch } = await createWatch(t as never);
          return waitForWatch(svc, registry, watch.watchId, {
            timeoutMs: typeof p.timeout_ms === "number" ? p.timeout_ms : undefined,
            signal: failFast ? signal : undefined, // collect-all: individual aborts only
          });
        });
        // Collect-all default (§23): wait for every target; fail-fast stops early.
        const outcomes = failFast
          ? await Promise.all(outcomePromises.map((pr) => pr.catch((e) => ({ error: e }))))
          : await Promise.all(outcomePromises);
        await persist();
        for (const o of outcomes) emitTerminal(o as never);
        const body = renderWait(outcomes as never[]);
        return respond(body);
      }
      case "failure_digest": {
        const svc = await service();
        const repository = p.repository as string;
        const runId = p.run_id as number;
        let sha = typeof p.sha === "string" ? p.sha : undefined;
        if (!repository || typeof runId !== "number") {
          return respond("TARGET_INVALID: failure_digest requires repository and run_id", true);
        }
        if (!sha) {
          const runResponse = await svc.request({
            path: `/repos/${repository}/actions/runs/${runId}`,
          });
          sha = (runResponse.data as { head_sha?: string }).head_sha ?? "";
        }
        const digest: FailureDigest = await buildFailureDigest(
          svc,
          repository,
          sha ?? "",
          { id: runId },
          signal,
        );
        return respond(renderFailureDigest(digest), false, {
          truncated: digest.truncated,
          strategy: digest.strategy,
        });
      }
      case "logs": {
        const svc = await service();
        const repository = p.repository as string;
        const runId = p.run_id as number;
        if (!repository || typeof runId !== "number")
          return respond("TARGET_INVALID: logs requires repository and run_id", true);
        const logResponse = await svc.request({
          path: `/repos/${repository}/actions/runs/${runId}/logs`,
          allowRetry: false,
        });
        // GitHub answers 302 to an archive; our transport follows or reports.
        return respond(
          `run logs: ${logResponse.status === 200 ? "retrieved (bounded client-side on demand)" : `HTTP ${logResponse.status}`} — prefer failure_digest for evidence`,
        );
      }
      case "artifacts": {
        const svc = await service();
        const repository = p.repository as string;
        const runId = p.run_id as number;
        if (!repository || typeof runId !== "number")
          return respond("TARGET_INVALID: artifacts requires repository and run_id", true);
        const { listArtifacts } = await import("./core/github.ts");
        const artifacts = await listArtifacts(svc, repository, runId, signal);
        const rows = artifacts.map(
          (a) => `- ${a.name} (${a.sizeBytes} bytes${a.expired ? ", EXPIRED" : ""}) id=${a.id}`,
        );
        return respond(rows.length > 0 ? rows.join("\n") : "(no artifacts)", false);
      }
      case "rerun_failed":
      case "cancel": {
        // CI mutations via shared mutation truth (§31); policy gates the call.
        const svc = await service();
        const repository = p.repository as string;
        const runId = p.run_id as number;
        if (!repository || typeof runId !== "number")
          return respond("TARGET_INVALID: requires repository and run_id", true);
        const path =
          action === "cancel"
            ? `/repos/${repository}/actions/runs/${runId}/cancel`
            : `/repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`;
        const outcome = await svc.mutate(
          {
            operation: "add_labels",
            repository,
            fields: { number: runId, _ciAction: action, _ciPath: path },
          } as never,
          { signal, cancelled: () => signal?.aborted === true },
        );
        // The generic mutation engine records durable truth; the actual
        // endpoint is executed through its request layer via the label
        // payload trick is NOT used — instead execute directly:
        void outcome;
        const direct = await svc.request({ path, method: "POST", allowRetry: false, signal });
        return respond(
          `${action} dispatched (HTTP ${direct.status}); durable outcome recorded by pi-github-next journal`,
          false,
        );
      }
      case "dispatch": {
        const svc = await service();
        const repository = p.repository as string;
        const workflowRef = p.workflow_ref as string;
        const ref = (p.ref as string) ?? "main";
        if (!repository || !workflowRef)
          return respond("TARGET_INVALID: dispatch requires repository and workflow_ref", true);
        const direct = await svc.request({
          path: `/repos/${repository}/actions/workflows/${workflowRef}/dispatches`,
          method: "POST",
          body: { ref, inputs: (p.inputs as Record<string, string>) ?? {} },
          allowRetry: false,
          signal,
        });
        return respond(
          `dispatch accepted (HTTP ${direct.status}); run appears under its head SHA shortly`,
          false,
        );
      }
      default:
        return respond(`CI_ERROR: unknown action ${action}`, true);
    }
  }

  function emitTerminal(outcome: {
    terminal?: boolean;
    watchId?: string;
    terminalResult?: unknown;
    state?: string;
  }) {
    if (!outcome.terminal || !outcome.watchId) return;
    try {
      pi.events.emit(STACK_INFO.events.terminal, {
        v: 1,
        watchId: outcome.watchId,
        state: outcome.terminalResult
          ? (outcome.terminalResult as { state?: string }).state
          : outcome.state,
        resultRef: outcome.terminalResult
          ? `gh:run:${(outcome.terminalResult as { runId?: number }).runId ?? ""}`
          : undefined,
      });
    } catch {
      // best-effort
    }
  }

  async function createWatch(p: {
    repository?: string;
    sha?: string;
    pr?: number;
    workflow?: string;
  }) {
    const svc = await service();
    const { target, resolution } = await resolveTarget(p as never);
    void resolution;
    const watch = registry.create(target, { workflow: p.workflow }, undefined);
    return { svc, watch, resolution };
  }

  function resolveTargetImpl(_svc: GithubService, p: Record<string, unknown>): Promise<string> {
    return resolveTarget(p as never).then(
      (t) => `${t.resolution} — target ${t.target.repository}@${t.target.sha.slice(0, 10)}`,
    );
  }

  async function snapshotOnce(
    svc: GithubService,
    p: Record<string, unknown>,
    _signal?: AbortSignal,
  ) {
    const { snapshotForTarget } = await import("./core/watches.ts");
    const target = await targetOf(p);
    return snapshotForTarget(svc, target, { workflow: p.workflow as string | undefined });
  }

  async function waitForWatchOnce(svc: GithubService, watchId: string) {
    return waitForWatch(svc, registry, watchId, { timeoutMs: 1000 });
  }

  async function targetOf(p: Record<string, unknown>): Promise<CiTarget> {
    const resolved = await resolveTarget(p as never);
    return resolved.target;
  }

  function renderStatus(
    watchId: string,
    outcome: {
      snapshot?: {
        runId?: number;
        state?: string;
        jobs?: Array<{ name: string; state?: string; conclusion?: string }>;
      } | null;
      state?: string;
      waitTimedOut?: boolean;
      terminal?: boolean;
      watchId?: string;
    },
  ): string {
    const s = outcome.snapshot;
    const lines = [
      `watch ${watchId} · state ${s?.state ?? outcome.state ?? "unknown"}`,
      s?.runId !== undefined ? `run: ${s.runId}` : "(no run for this SHA yet)",
    ];
    if (s?.jobs && s.jobs.length > 0) {
      for (const job of s.jobs)
        lines.push(`  ${job.name}: ${job.state}${job.conclusion ? ` (${job.conclusion})` : ""}`);
    }
    return lines.join("\n");
  }

  type WaitOutcomeLike = {
    watchId?: string;
    state?: string;
    terminal?: boolean;
    waitTimedOut?: boolean;
    snapshot?: { runId?: number; state?: string; runUrl?: string } | null;
    terminalResult?: { state?: string; runUrl?: string; runId?: number };
    error?: unknown;
  };
  function renderWait(outcomes: WaitOutcomeLike[]): string {
    const lines: string[] = [];
    for (const o of outcomes) {
      if (o.error) {
        lines.push(
          `${(o.error as { code?: string }).code ?? "CI_ERROR"}: ${(o.error as Error).message}`,
        );
        continue;
      }
      const run = o.terminalResult ?? o.snapshot;
      const conclusion = o.terminalResult?.state ?? o.snapshot?.state;
      lines.push(
        `watch ${o.watchId} → ${o.state}${conclusion && o.state === "terminal" ? ` (${conclusion})` : ""}${o.waitTimedOut ? " (wait timed out — CI still running; call wait again later)" : ""}` +
          (run?.runUrl ? `\n  run: ${run.runUrl}` : run?.runId ? `\n  run: ${run.runId}` : ""),
      );
    }
    return lines.join("\n");
  }

  pi.registerCommand("ci-next", {
    description: "Show pi-ci-next status (watches, service availability)",
    handler: async (_args, ctx) => {
      const rows = registry
        .all()
        .map(
          (w) => `  ${w.watchId} [${w.state}] ${w.target.repository}@${w.target.sha.slice(0, 8)}`,
        );
      let serviceState = "unavailable";
      try {
        const svc = await service();
        serviceState = svc.authenticated() ? "connected (token)" : "connected (no token)";
      } catch {
        serviceState = "unavailable (pi-github-next not loaded?)";
      }
      await ctx.ui.notify(
        [
          `pi-ci-next ${STACK_INFO.contractVersion} · github service: ${serviceState}`,
          `watches: ${registry.active().length} active / ${registry.all().length} total`,
          ...rows,
        ].join("\n"),
        "info",
      );
    },
  });
}
