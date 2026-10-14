import type { ConfigOptionView } from "../shared/protocol.js";

/**
 * Remembers the model the user last picked.
 *
 * `opencode acp` hands every fresh session the server's own default model
 * (`opencode/cat-jam-free` unless `opencode.json` pins one), and the TUI's
 * `~/.local/state/opencode/model.json` is only ever read by the TUI itself —
 * so the extension has to keep this memory to start where the user left off.
 */
export interface ModelMemory {
  read(): string | undefined;
  write(modelId: string): void;
}

const NO_MODEL_MEMORY: ModelMemory = {
  read: () => undefined,
  write: () => undefined,
};

/** A memory that remembers nothing, for callers that do not care to persist. */
export function noModelMemory(): ModelMemory {
  return NO_MODEL_MEMORY;
}

/**
 * The model a fresh session should be moved onto, or `undefined` to leave it
 * alone.
 *
 * The remembered id is checked against the options the session actually
 * offers, so a model that has since been uninstalled, disabled or renamed is
 * skipped instead of being set and rejected. Nothing is returned when the
 * session already sits on the remembered model, which keeps a restart from
 * bouncing an extra round trip off the agent for no reason.
 */
export function modelToRestore(
  configOptions: ConfigOptionView[],
  remembered: string | undefined,
): { configId: string; value: string } | undefined {
  const option = configOptions.find((entry) => entry.id === "model" || entry.category === "model");
  if (!remembered || !option || option.current === remembered) {
    return undefined;
  }
  if (!option.options?.some((entry) => entry.value === remembered)) {
    return undefined;
  }
  return { configId: option.id, value: remembered };
}