/**
 * Reading the settings of an OpenCode installation from its own CLI.
 *
 * The extension runs where the agent runs, so under Remote-SSH every command
 * answered here comes back from the *remote* box: its `opencode.json`, its
 * credentials, its model catalog. That is the only source of truth for what a
 * machine is configured to do — a VS Code setting cannot answer it, because the
 * machine the user is looking at is not the machine the process runs on.
 *
 * `opencode debug config`, `opencode debug agents` and `opencode debug paths`
 * are the commands that report it. Everything here is pure text handling so it
 * can be tested without spawning anything; `src/agent/host-info.ts` does the
 * spawning and treats every one of these as optional — an install that does not
 * have a given subcommand must not take the chat down with it.
 */

/** One configuration source OpenCode loaded, in the order it loads them. */
export interface ConfigSourceView {
  /** `directory`, `file`, `document`, … whatever the CLI reported. */
  type: string;
  path: string;
  /** The keys the source actually sets, summarised for display. */
  keys?: string[];
}

/** An agent the host has configured. */
export interface AgentView {
  id: string;
  name: string;
  description?: string;
  mode?: string;
}

/**
 * A provider the host has configured, as its config names it.
 *
 * `opencode debug config` reports the whole provider block, secrets included —
 * so only the two parts worth showing are kept: the name a person calls the
 * provider by, and the name each of its models goes by. Nothing else out of
 * `settings` is ever copied out, which is also why the API key never reaches
 * the UI.
 */
export interface ProviderView {
  /** The id every model id is prefixed with, such as `acme`. */
  id: string;
  /** The display name, when the config gives one — `Acme Router` for `acme`. */
  name?: string;
  /** Model id → display name, for the models this provider names. */
  models?: Record<string, string>;
}

/**
 * The `key  value` table `opencode debug paths` prints.
 *
 * Only the keys the CLI is known to print are kept, so a stray line of noise —
 * a warning, a progress spinner — cannot end up being read as a path.
 */
const PATH_KEYS = ["home", "config", "state", "data", "cache"] as const;

export type PathKey = (typeof PATH_KEYS)[number];

export type PathsView = Partial<Record<PathKey, string>>;

/** Reads the `opencode debug paths` table. */
export function parsePaths(stdout: string): PathsView {
  const found: Record<string, string> = {};
  for (const raw of stdout.split(/\r?\n/)) {
    const match = /^([a-z]+)\s+(\S.*?)\s*$/.exec(raw.trim());
    if (match) {
      found[match[1]] = match[2];
    }
  }
  const result: PathsView = {};
  for (const key of PATH_KEYS) {
    if (found[key]) {
      result[key] = found[key];
    }
  }
  return result;
}

/**
 * Reads `opencode models`.
 *
 * One `provider/model` id per line, newest CLIs first, though some versions
 * print extra columns after the id — so only the first token of a line is read,
 * and anything that is not a single-token `provider/model` is dropped rather
 * than shown as a broken choice.
 */
export function parseModels(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const token = raw.trim().split(/\s+/)[0];
    if (!token || token === "/" || token.includes("//")) {
      continue;
    }
    if (!token.includes("/") || !isModelId(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    models.push(token);
  }
  return models;
}

/** A model id: `provider/model`, both parts free of anything exotic. */
function isModelId(value: string): boolean {
  const [provider, ...rest] = value.split("/");
  const model = rest.join("/");
  return Boolean(provider && model) && /^[A-Za-z0-9._:@-]+$/.test(provider) && /^[\w./:@-]+$/.test(model);
}

/**
 * Parses the JSON array a `debug` subcommand prints.
 *
 * The output is JSON, but it is printed by a program that may also print a
 * notice or a progress line first, so a bare `JSON.parse` of the whole thing is
 * too strict to be the only attempt.
 */
function jsonArray(stdout: string): unknown[] {
  const text = stdout.trim();
  for (const candidate of [text, text.slice(text.indexOf("[")), text.slice(0, text.lastIndexOf("]") + 1)]) {
    if (!candidate || !candidate.startsWith("[")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next reading of the same output.
    }
  }
  return [];
}

/**
 * The provider declarations one config file carries, before any other file has
 * a say.
 *
 * `parseProviders` merges the sources because the picker wants the answer that
 * OpenCode itself would give. The gap between what a machine can list and what
 * its agent enumerates needs the opposite: the file a provider is defined *in*,
 * which is the only thing worth naming when that provider goes missing.
 */
export interface ProviderSource {
  /** The file this came from, as `debug config` spells it. */
  path: string;
  /** Only the providers this file declares. */
  providers: ProviderView[];
}

/** Reads `opencode debug config`: where OpenCode loaded its settings from. */
export function parseConfigSources(stdout: string): ConfigSourceView[] {
  const sources: ConfigSourceView[] = [];
  for (const entry of jsonArray(stdout)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { type?: unknown; path?: unknown; info?: unknown };
    if (typeof record.path !== "string" || !record.path) {
      continue;
    }
    const info = record.info;
    sources.push({
      type: typeof record.type === "string" ? record.type : "config",
      path: record.path,
      keys: info && typeof info === "object" ? Object.keys(info as Record<string, unknown>).sort() : undefined,
    });
  }
  return sources;
}

/** The provider blocks one source's `info` carries. */
function providersIn(info: unknown): ProviderView[] {
  if (!info || typeof info !== "object") {
    return [];
  }
  const declared = (info as { providers?: unknown }).providers;
  if (!declared || typeof declared !== "object") {
    return [];
  }
  const providers: ProviderView[] = [];
  for (const [id, value] of Object.entries(declared as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as { name?: unknown; models?: unknown };
    const models = modelNames(record.models);
    providers.push({
      id,
      name: typeof record.name === "string" && record.name ? record.name : id,
      models: Object.keys(models).length ? models : undefined,
    });
  }
  return providers;
}

/** Which config file declares which providers, in load order. */
export function parseProviderSources(stdout: string): ProviderSource[] {
  const sources: ProviderSource[] = [];
  for (const entry of jsonArray(stdout)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { path, info } = entry as { path?: unknown; info?: unknown };
    if (typeof path !== "string" || !path) {
      continue;
    }
    const providers = providersIn(info);
    if (providers.length) {
      sources.push({ path, providers });
    }
  }
  return sources;
}

/**
 * Reads the providers out of `opencode debug config`.
 *
 * This is what lets the picker head each group with a name a person would use —
 * `Acme Router` rather than `acme` — and what gives a model the label its
 * author gave it (`Claude Opus 5.5`) instead of one rebuilt from its slug.
 *
 * Providers are merged across every source, in load order, so a project
 * `opencode.json` overriding a global one wins the same way it does in OpenCode
 * itself. A later source replaces an earlier one's models outright rather than
 * merging them key by key, because that is what a redefinition means.
 */
export function parseProviders(stdout: string): ProviderView[] {
  const byId = new Map<string, ProviderView>();
  for (const source of parseProviderSources(stdout)) {
    for (const provider of source.providers) {
      const previous = byId.get(provider.id);
      byId.set(provider.id, {
        id: provider.id,
        name: provider.name !== provider.id ? provider.name : previous?.name,
        models: provider.models ?? previous?.models,
      });
    }
  }
  return [...byId.values()];
}

/** The `modelId → display name` pairs of a provider block, when it names any. */
function modelNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const named: Record<string, string> = {};
  for (const [modelId, entry] of Object.entries(value as Record<string, unknown>)) {
    // A model may be configured as a bare id rather than an object.
    if (typeof entry === "string") {
      named[modelId] = entry;
      continue;
    }
    const name = (entry as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name) {
      named[modelId] = name;
    }
  }
  return named;
}

/** Reads `opencode debug agents`: the agents configured on this machine. */
export function parseAgents(stdout: string): AgentView[] {
  const agents: AgentView[] = [];
  for (const entry of jsonArray(stdout)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { id?: unknown; name?: unknown; description?: unknown; mode?: unknown };
    const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
    if (!id) {
      continue;
    }
    agents.push({
      id,
      name: typeof record.name === "string" ? record.name : id,
      description: typeof record.description === "string" ? record.description : undefined,
      mode: typeof record.mode === "string" ? record.mode : undefined,
    });
  }
  return agents;
}

/** Reads `opencode --version`, which answers `opencode v2.0.27`. */
export function parseVersion(stdout: string): string | undefined {
  const match = /v?\d+\.\d+\.\d+[^\s]*/.exec(stdout.trim());
  return match ? match[0].replace(/^v/, "") : undefined;
}

/**
 * The model choices the OpenCode TUI itself has remembered.
 *
 * `~/.local/state/opencode/model.json` is the TUI's private state, and it is
 * the only place a *preference* about models survives: a ranked list of the ones
 * recently picked, and the ones starred. It deliberately holds no catalog —
 * every entry is a `{providerID, modelID}` pointer at a model that lives in the
 * provider config — so this cannot stand in for `opencode models`, only reorder
 * what that returns.
 *
 * Both lists are `providerID/modelID` strings, which is exactly what the picker's
 * choices are, so they join up directly.
 */
export interface TuiModelMemory {
  /** Most recently used first. */
  recent: string[];
  /** Starred in the TUI. */
  favorite: string[];
}

/** Nothing remembered, for a TUI that has never been run or wrote nothing. */
export const NO_TUI_MODELS: TuiModelMemory = { recent: [], favorite: [] };

/**
 * Reads the TUI's `model.json`.
 *
 * Returns nothing remembered for anything it cannot read: a missing file, a
 * half-written one — the TUI rewrites it in place while running — or a shape
 * that has changed under it. None of those are worth an error, so the file is
 * simply treated as having nothing to say.
 */
export function parseTuiModels(contents: string): TuiModelMemory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return NO_TUI_MODELS;
  }
  if (!parsed || typeof parsed !== "object") {
    return NO_TUI_MODELS;
  }
  const record = parsed as { recent?: unknown; favorite?: unknown };
  const recent = modelRefs(record.recent);
  const favorite = modelRefs(record.favorite);
  return {
    // A model can be both recent and starred; the favourites section would then
    // list it twice, so it is dropped from the recent list.
    recent: recent.filter((id) => !favorite.includes(id)),
    favorite,
  };
}

/**
 * The `{providerID, modelID}` entries of one list, as `provider/model` strings.
 *
 * A pair missing either half names no model that can be selected, so it is
 * dropped rather than turned into a choice that could never be picked.
 */
function modelRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { providerID, modelID } = entry as { providerID?: unknown; modelID?: unknown };
    if (typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) {
      continue;
    }
    const id = `${providerID}/${modelID}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
