import type { FormField, PermissionRequest } from "../shared/protocol.js";

/**
 * Turns an ACP elicitation JSON Schema into the flat field list the webview
 * renders.
 *
 * OpenCode sends plain object schemas with string, boolean and array
 * properties. When a field accepts a typed answer alongside its options, the
 * schema adds an optional `<key>_custom` string property, which becomes a
 * free-form input next to the choices.
 */
export function toFormFields(schemaLike: unknown): QuestionSchemaView {
  const shape = (schemaLike ?? {}) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const properties: Record<string, Record<string, unknown>> = shape.properties ?? {};
  const required = new Set<string>(shape.required ?? []);
  const fields: FormField[] = [];

  for (const [key, raw] of Object.entries(properties)) {
    if (key.endsWith("_custom")) {
      const base = fields.find((field) => field.key === key.slice(0, -"_custom".length));
      if (base && base.control === "select") {
        base.customKey = key;
      }
      continue;
    }

    const description = typeof raw.description === "string" ? raw.description : undefined;
    const title = typeof raw.title === "string" ? raw.title : key;
    const isRequired = required.has(key);

    if (raw.type === "boolean") {
      fields.push({ key, label: title, control: "boolean", required: isRequired });
      continue;
    }

    if (raw.type === "array") {
      const items = raw.items as { oneOf?: Array<{ const: string; title?: string }>; enum?: string[] } | undefined;
      const choices =
        items?.oneOf?.map((option) => ({ value: option.const, label: option.title ?? option.const })) ??
        items?.enum?.map((value) => ({ value, label: value })) ??
        [];
      fields.push({ key, label: title, control: "select", multiple: true, required: isRequired, options: choices });
      continue;
    }

    if (raw.type === "string") {
      const choices = choicesOf(raw);
      if (choices.length) {
        fields.push({ key, label: title, control: "select", multiple: false, required: isRequired, options: choices });
        continue;
      }
      const multiline = typeof raw.pattern === "string" && raw.pattern.includes("\n");
      fields.push({
        key,
        label: title,
        control: multiline ? "textarea" : "text",
        required: isRequired,
        placeholder: description,
      });
      continue;
    }

    fields.push({ key, label: title, control: "text", required: isRequired, placeholder: description });
  }

  return fields;
}

export type QuestionSchemaView = FormField[];

function choicesOf(raw: Record<string, unknown>): Array<{ value: string; label: string }> {
  const oneOf = raw.oneOf as Array<{ const: string; title?: string }> | undefined;
  if (oneOf) {
    return oneOf.map((option) => ({ value: option.const, label: option.title ?? option.const }));
  }
  const enumValues = raw.enum as string[] | undefined;
  if (enumValues) {
    return enumValues.map((value) => ({ value, label: value }));
  }
  return [];
}

/**
 * Decides whether a permission request can be answered without asking the user.
 *
 * Returns the option to pick, or `undefined` to show the prompt in the chat.
 */
export function chooseAutomatically(
  request: PermissionRequest,
  policy: "ask" | "autoRead" | "all",
  isReadOnly: (request: PermissionRequest) => boolean,
): { optionId: string } | undefined {
  if (policy === "all") {
    return pickOption(request, ["allow_always", "allow_once"]);
  }
  if (policy === "autoRead" && isReadOnly(request)) {
    return pickOption(request, ["allow_always", "allow_once"]);
  }
  return undefined;
}

function pickOption(request: PermissionRequest, kinds: string[]): { optionId: string } | undefined {
  for (const kind of kinds) {
    const option = request.options.find((entry) => entry.kind === kind);
    if (option) {
      return { optionId: option.optionId };
    }
  }
  return undefined;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: "permanently deletes files" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: "discards uncommitted work" },
  { pattern: /\b(drop|truncate)\s+(table|database)\b/i, why: "destroys data" },
  { pattern: /\bmkfs\b|\bdd\s+if=/i, why: "rewrites a device or disk" },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, why: "changes permissions system-wide" },
  { pattern: />\s*\/dev\/sd[a-z]/i, why: "writes directly to a disk" },
];

/**
 * Returns a human-readable reason when the tool call's shell command looks
 * destructive, so the permission prompt can warn before anything runs.
 */
export function destructiveReason(toolCall: { kind?: string | null; rawInput?: unknown }): string | undefined {
  const command = commandOf(toolCall.rawInput);
  if (!command) {
    return undefined;
  }
  for (const { pattern, why } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return `This command ${why}. Check the command before approving.`;
    }
  }
  return undefined;
}

function commandOf(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) {
    return undefined;
  }
  const record = rawInput as { command?: unknown; cmd?: unknown };
  const value = record.command ?? record.cmd;
  return typeof value === "string" ? value : undefined;
}

/** Extracts the parts of a session slice that the webview renders. */
export function sliceLines(text: string, line?: number | null, limit?: number | null): string {
  if (!line && !limit) {
    return text;
  }
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}