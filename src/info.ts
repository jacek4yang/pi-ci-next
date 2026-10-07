// pi-ci-next — stack identity, quotas, contracts.

export const STACK_INFO = {
  name: "pi-ci-next",
  contractVersion: 1,
  tool: {
    name: "ci",
  },
  /** Versioned contracts owned by this plugin. */
  events: {
    watch: "pinx.ci.watch",
    progress: "pinx.ci.progress",
    terminal: "pinx.ci.terminal",
  },
  /** Contracts consumed (owned elsewhere). */
  consumed: {
    /** pi-github-next shared GitHub stack (CONTRACTS §12). */
    githubService: "pinx.github.service",
  },
  env: {
    disable: "PINX_CI_DISABLE", // =1 disables the plugin entirely
  },
  quotas: {
    /** Bounded watch registry. */
    maxActiveWatches: 16,
    maxTerminalRetained: 64,
    /** Wait defaults. */
    defaultWaitTimeoutMs: 10 * 60 * 1000,
    maxWaitTimeoutMs: 60 * 60 * 1000,
    /** Adaptive internal polling (§19). */
    poll: {
      initialDelayMs: 2_000,
      activeIntervalMs: 15_000,
      unchangedIntervalMs: 45_000,
      maxIntervalMs: 90_000,
    },
    /** Failure digest bounds (§35). */
    digest: {
      maxFailedJobs: 5,
      maxStepsPerJob: 3,
      maxExcerptLines: 12,
      maxExcerptChars: 800,
      maxLogBytes: 512 * 1024,
    },
  },
} as const;
