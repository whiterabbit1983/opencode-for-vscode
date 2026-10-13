/**
 * Readable names for model identifiers.
 *
 * Agents identify models by an id such as `opencode/cat-jam-free`, and the
 * label that comes with it is usually just the same slug title-cased
 * (`opencode/Cat Jam Free`). Neither reads well in the composer chip, so the
 * provider prefix is dropped and whatever is left is turned into words.
 *
 * Shared by the extension host and the webview, so it must stay free of any
 * `vscode` or Node imports.
 */

export interface ModelLabel {
  /** Readable name, for example `Cat Jam Free`. */
  name: string;
  /** Provider the model is served by, for example `opencode`. */
  provider?: string;
}

/** Splits `anthropic/claude-sonnet-4-5` into its provider and model parts. */
function splitId(id: string): { provider?: string; slug: string } {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { slug: trimmed };
  }
  return { provider: trimmed.slice(0, slash), slug: trimmed.slice(slash + 1) };
}

/**
 * Turns a slug into words: `cat-jam-free` becomes `Cat Jam Free`.
 *
 * Only the first letter of each word is touched, so names the agent already
 * formats properly (`GPT OSS 20B`, `Claude Sonnet 4.5`) survive untouched.
 */
function humanize(slug: string): string {
  const words = slug
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ");
}

/**
 * Builds the label shown for a model.
 *
 * @param id     The model id, optionally prefixed with its provider.
 * @param label  The name the agent ships with the option, when it has one.
 */
export function modelLabel(id: string, label?: string): ModelLabel {
  const { provider, slug } = splitId(id);
  const candidate = label?.trim();

  if (candidate) {
    // Agents prefix their labels with the provider exactly as they prefix the
    // id (`opencode/Cat Jam Free`), and nested providers add another segment
    // (`lmstudio/openai/gpt-oss-20b`). Dropping them keeps the name short
    // enough for a chip; the provider is shown separately instead.
    const trimmed = candidate.includes("/") ? candidate.slice(candidate.lastIndexOf("/") + 1) : candidate;
    // A label that is already spelled out ("Claude Sonnet 4.5") is taken as-is;
    // one that is just the slug again is turned into words.
    const name = (/\s/.test(trimmed) ? trimmed : humanize(trimmed)).trim() || humanize(slug);
    return { name, provider };
  }

  return { name: humanize(slug) || id, provider };
}

/** Convenience wrapper for callers that only need the readable name. */
export function modelName(id: string, label?: string): string {
  return modelLabel(id, label).name;
}
