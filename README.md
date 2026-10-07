# pi-ci-next

CI watches for GitHub Actions in the [Pi](https://github.com/earendil-works/pi)
coding agent — the fourth Agent Body v2 productization plugin, and the end
of model-driven CI polling.

pi-ci-next owns CI target identity, watch lifecycle, internal adaptive
polling, wait/wait_all synchronization, deterministic failure digests, log
selection, artifact metadata, and CI control actions. It does NOT own
GitHub auth/cache/mutation-journal (reuses **pi-github-next**), task state
(pi-task-next), approval policy (pi-policy-next), runtime jobs, or UI.

## The architectural rule

**RUNTIME POLLING ≠ MODEL POLLING.**

Waiting on a CI run is ONE model call:

```
ci { action: "wait", repository: "o/r", sha: <head sha> }
```

Internally the plugin polls GitHub adaptively — immediate initial check,
shorter interval while progressing, backoff when unchanged, bounded
deadline, AbortSignal-aware — using pi-github-next's shared transport
(single auth, ETag caching, singleflight, rate-limit state). The model
sees only the final/material result. Progress ("CI 5/8 complete") is
UI-only, coalesced event state — never model context (I10).

## Target identity (I2/I3)

The authoritative target is **repository + commit SHA** — never a branch,
never a PR number alone. A PR resolves to its head SHA exactly once; the
watch binds to that SHA. If the PR head moves, the watch becomes
**superseded** — it can never claim the PR was validated using results
from the new head.

## Wait semantics (I4/I5)

- **Timeout** — returns `state=running, waitTimedOut=true` plus the last
  snapshot. The workflow continues; a later wait resumes.
- **Local abort** — stops the local wait only. Cancelling CI requires an
  explicit `ci { action: "cancel" }`, which passes pi-policy-next.
- **wait_all** — one call waits all Agent-Body-style targets concurrently
  (repo+SHA each). Default **collect-all** (every terminal state in one
  result — release validation sees all failures at once); `fail_fast`
  optional.

## Failure digest (I9, §32-35)

`ci { action: "failure_digest", repository, run_id }` collects workflow,
failed jobs, failed steps, marker-selected log excerpts, and artifact
references into one bounded result. Selection is deterministic (error /
failure / panic / assertion / stack-frame / exit-code markers, bounded
head+tail fallback) — **no LLM summarizes logs**; the main model
interprets selected evidence. Every truncation states shown/original
counts and the full-log ref.

## Reuse, not duplication

The GitHub stack (auth, retry, rate limits, ETag cache, singleflight,
mutation journal) is **pi-github-next's**, obtained over the versioned
`pinx.github.service` event-bus handshake (CONTRACTS §12) — no second
Octokit instance, no sibling imports. CI control mutations (rerun/cancel/
dispatch) flow through the shared mutation engine: durable journal truth,
no blind retries, reconciliation on unknown outcomes (G1/G2 hold here too).

## Task integration (§28-29)

Tasks wait with `waiting.kind=ci, watchId` (pi-task-next). Terminal CI
states emit `pinx.ci.terminal`; the task layer resolves the wait — CI
success makes the task actionable (never done), failure blocks it with
the failure reference. Watch state is bounded: 16 active, 64 terminal
history, refs only — never logs.

## Persistence and reopen (I8/§26)

Minimal watch records persist in the agent dir. On reopen, persisted
`running` is **never trusted** — watches restore as provisional and the
remote is re-queried; remote truth wins.

## Development

```bash
npm ci
npm run bench   # orchestration benchmark (model-call reductions)
npm run soak    # 890 watches, faults, supersede storms, barriers
npm run ci      # check:pi + typecheck + lint + format + test
```

Windows/Linux first-class; no `gh` CLI on any production path. Pi pinned
exactly. Invariants **I1–I10** are test-tagged and conformance-mapped in
the meta repository.
