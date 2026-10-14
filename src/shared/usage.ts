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
 * Remembers what each session last reported so an idle chat is not left blank.
 *
 * `session/new` and `session/load` both answer without a usage field, so
 * without this the counter sits empty for the whole of a reopened
 * conversation and only reappears once a turn is streaming. The figures are
 * carried over rather than recomputed, which means they are the reading from
 * the end of the last turn until the next `usage_update` replaces them.
 *
 * Keyed by session id because a reading belongs to the conversation that
 * produced it: one stored figure shared by every chat is how a resumed chat
 * ends up advertising another one's context.
 */
export interface UsageMemory {
  read(sessionId: string): Usage | undefined;
  write(sessionId: string, usage: Usage): void;
}

const NO_USAGE_MEMORY: UsageMemory = {
  read: () => undefined,
  write: () => undefined,
};

/** A memory that remembers nothing, for callers that do not care to persist. */
export function noUsageMemory(): UsageMemory {
  return NO_USAGE_MEMORY;
}

/** The persisted shape: one reading per session. */
export type UsageStore = Record<string, Usage>;

/**
 * How many sessions' readings are kept.
 *
 * Only the sessions the user actually reopens need one, and the store is
 * user-wide state that is never pruned otherwise, so it is capped rather than
 * grown forever.
 */
const STORE_LIMIT = 10;

/**
 * Reads the store back out of JSON, dropping anything that is not a reading.
 *
 * Both keys and values come from disk, so a hand-edited, truncated or
 * out-of-date entry must not reach the meter as `NaN` or as another session's
 * figures.
 */
export function usageStore(value: unknown): UsageStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const store: UsageStore = {};
  for (const [sessionId, reading] of Object.entries(value as Record<string, unknown>)) {
    if (isUsage(reading)) {
      store[sessionId] = reading;
    }
  }
  return store;
}

/**
 * Stores a reading for one session, forgetting the least recently written.
 *
 * The session being written goes first so the key order doubles as a recency
 * order, which is what the cap below trims on.
 */
export function rememberUsage(store: UsageStore, sessionId: string, usage: Usage): UsageStore {
  const next: UsageStore = { [sessionId]: usage };
  let kept = 1;
  for (const [id, reading] of Object.entries(store)) {
    if (id === sessionId) {
      continue;
    }
    if (kept >= STORE_LIMIT) {
      break;
    }
    next[id] = reading;
    kept += 1;
  }
  return next;
}

/**
 * A memory over a store the host keeps as JSON, parsed once per window.
 *
 * A turn streams a `usage_update` per chunk, so re-reading and re-validating
 * the whole store on every write would be wasted work; nothing else writes the
 * key, so the parse is kept.
 */
export function usageMemory(load: () => unknown, save: (store: UsageStore) => void): UsageMemory {
  let parsed: UsageStore | undefined;
  const store = (): UsageStore => (parsed ??= usageStore(load()));
  return {
    read: (sessionId) => store()[sessionId],
    write: (sessionId, usage) => {
      parsed = rememberUsage(store(), sessionId, usage);
      save(parsed);
    },
  };
}

/**
 * Whether a reading is worth remembering for the next time this session opens.
 *
 * Only a reading with a known window qualifies: a `size` of zero means the
 * figure was a bare session total, which is not a share of anything and would
 * replace a real meter with a weaker one.
 */
export function isPersistable(usage: Usage | undefined): usage is Usage {
  return !!usage && usage.size > 0;
}

/**
 * The reading to put on the meter when a session opens.
 *
 * `remembered` is already this session's own last reading — see
 * {@link UsageMemory} — so the only question left is whether this session had
 * a context at all. A resumed one still holds whatever it ended on, and those
 * figures are honest until the next `usage_update`. A brand-new session holds
 * none: its context window is empty, and putting a count on it makes a fresh
 * conversation advertise usage it never had.
 *
 * Returning `undefined` leaves the meter blank, which is the accurate reading
 * — the first `usage_update` of the new turn fills it in.
 */
export function usageToSeed(remembered: Usage | undefined, resumed: boolean): Usage | undefined {
  return resumed && isPersistable(remembered) ? remembered : undefined;
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