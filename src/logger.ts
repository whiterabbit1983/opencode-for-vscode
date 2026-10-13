import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("OpenCode");

/**
 * Diagnostics go to an output channel that is never opened on its own. The
 * chat UI surfaces anything the user actually needs to see; everything here is
 * for debugging, which is what the channel is for.
 */
export const log = {
  debug(message: string, ...args: unknown[]) {
    channel.appendLine(`[${new Date().toISOString()}] [debug] ${format(message, args)}`);
  },
  info(message: string, ...args: unknown[]) {
    channel.appendLine(`[${new Date().toISOString()}] [info]  ${format(message, args)}`);
  },
  warn(message: string, ...args: unknown[]) {
    channel.appendLine(`[${new Date().toISOString()}] [warn]  ${format(message, args)}`);
  },
  error(message: string, ...args: unknown[]) {
    channel.appendLine(`[${new Date().toISOString()}] [error] ${format(message, args)}`);
  },
  /** Appends raw lines emitted by the `opencode acp` child process. */
  raw(text: string) {
    channel.appendLine(text.replace(/\s+$/, ""));
  },
  show() {
    channel.show(true);
  },
};

function format(message: string, args: unknown[]): string {
  if (!args.length) {
    return message;
  }
  const head = message.includes("%") ? message : `${message} `;
  return utilFormat(head, args);
}

/** A tiny `%s`/`%d`/`%o` formatter so we don't pull in Node's `util` types. */
function utilFormat(message: string, args: unknown[]): string {
  let index = 0;
  const formatted = message.replace(/%([sdifjo%])/g, (match, kind: string) => {
    if (kind === "%") {
      return "%";
    }
    if (index >= args.length) {
      return match;
    }
    const value = args[index++];
    switch (kind) {
      case "s":
        return typeof value === "string" ? value : JSON.stringify(value);
      case "d":
      case "i":
        return String(Number(value));
      case "f":
        return String(Number(value));
      default:
        return safeInspect(value);
    }
  });
  const rest = args.slice(index).map(safeInspect);
  return rest.length ? `${formatted} ${rest.join(" ")}` : formatted;
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}