/**
 * Context-window accounting for the status bar.
 *
 * ACP reports two numbers that look interchangeable and are not:
 *
 * - `UsageUpdate.used` / `UsageUpdate.size` — how many tokens are in context
 *   *right now*, against the model's context window. This is what the OpenCode
 *   TUI shows, and what a meter should be filled against.
 * - `Usage.totalTokens` — every token billed across the whole session. It only
 *   grows, and it is not a share of anything.
 *
 * Dividing one by the other is what used to happen here: the meter filled up
 * within a few turns and then sat pinned at 100%.
 */

export interface Usage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

/**
 * Remembers the last context reading so an idle chat is not left blank.
 *
 * `session/new` and `session/load` both answer without a usage field, so
 * without this the counter sits empty for the whole of a reopened
 * conversation and only reappears once a turn is streaming. The figures are
 * carried over rather than recomputed, which means they are the reading from
 * the end of the last turn until the next `usage_update` replaces them.
 */
export interface UsageMemory {
  read(): Usage | undefined;
  write(usage: Usage): void;
}

const NO_USAGE_MEMORY: UsageMemory = {
  read: () => undefined,
  write: () => undefined,
};

/** A memory that remembers nothing, for callers that do not care to persist. */
export function noUsageMemory(): UsageMemory {
  return NO_USAGE_MEMORY;
}

/**
 * Whether a reading is worth carrying into the next session.
 *
 * Only a reading with a known window qualifies: a `size` of zero means the
 * figure was a bare session total, which is not a share of anything and would
 * replace a real meter with a weaker one.
 */
export function isPersistable(usage: Usage | undefined): usage is Usage {
  return !!usage && usage.size > 0;
}

/**
 * Checks a value read back from disk before it is trusted as a reading.
 *
 * `globalState` is JSON, so what comes back is `unknown`: a hand-edited or
 * truncated entry must not reach the meter as `NaN`.
 */
export function isUsage(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { used?: unknown; size?: unknown; cost?: unknown };
  if (typeof candidate.used !== "number" || typeof candidate.size !== "number") {
    return false;
  }
  if (candidate.cost === undefined) {
    return true;
  }
  const cost = candidate.cost as { amount?: unknown; currency?: unknown };
  return typeof cost.amount === "number" && typeof cost.currency === "string";
}

/** The usage ACP returns at the end of a prompt. */
export interface PromptUsage {
  /**
   * Note what this type deliberately leaves out: `cost`. ACP's end-of-turn
   * `Usage` carries only token counts — cost arrives exclusively on
   * `UsageUpdate`, which is the other half of this module.
   */
  totalTokens: number;
}

/**
 * Folds the usage reported at the end of a turn into what the status bar shows.
 *
 * The context figures from the last `usage_update` are authoritative — the
 * end-of-turn report only carries a cumulative total, which is not a share of
 * anything — so they are carried over untouched, along with the cost.
 *
 * When no `usage_update` has arrived the window size is genuinely unknown. In
 * that case the session total is reported with a size of `0`, which renders as
 * a plain number rather than a misleading meter.
 */
export function mergeUsage(current: Usage | undefined, response: PromptUsage): Usage {
  if (!current) {
    return { used: response.totalTokens, size: 0 };
  }
  return current;
}

/**
 * The share of the context window in use, or `undefined` when the window size
 * is unknown.
 *
 * Clamped to 1 because a session can briefly report more than the window when
 * a turn overflows, and a meter should not claim to be more than full.
 */
export function contextRatio(usage: Usage): number | undefined {
  if (usage.size <= 0) {
    return undefined;
  }
  return Math.min(1, Math.max(0, usage.used / usage.size));
}

/** Turns a fraction into `42%`. */
export function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  // One decimal below 10% so a small but growing context is still readable.
  return `${percent < 10 && percent > 0 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/**
 * How loudly to colour the meter.
 *
 * `high` at 80% and `critical` at 95%, which is roughly where compaction
 * starts to matter.
 */
export function meterLevel(ratio: number): "" | "high" | "critical" {
  if (ratio >= 0.95) {
    return "critical";
  }
  return ratio > 0.8 ? "high" : "";
}

/** `1540` → `1.5k`, `200000` → `200k`. */
export function compactNumber(value: number): string {
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}