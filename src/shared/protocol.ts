/**
 * Wire protocol between the extension host and the chat webview.
 *
 * This module is imported by both sides, so it must stay free of any `vscode`
 * or Node imports.
 */

import type { Usage } from "./usage.js";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; uri: string; name: string; mimeType?: string; text?: string };

export type ToolCallContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCall {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
  status: ToolStatus;
  content: ToolCallContent[];
  locations: Array<{ path: string; line?: number }>;
  /** Set for tool calls produced by a child session. */
  childSession?: { id: string; parentId?: string; depth: number; title?: string };
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /**
   * ACP option kind: `allow_once`, `allow_always`, `reject_once`,
   * `reject_always`, or a custom string. Callers must treat anything that is
   * not a known `reject*` kind as an approval.
   */
  kind: string;
}

export interface PermissionRequest {
  requestId: string;
  toolCallId?: string;
  title: string;
  kind?: string;
  name?: string;
  options: PermissionOption[];
  /** Rendered content of the tool call, shown above the buttons. */
  content: ToolCallContent[];
  /** Extra warning shown for destructive commands when the user asked for it. */
  warning?: string;
}

export type FormField =
  | { key: string; label: string; control: "text"; required: boolean; placeholder?: string }
  | { key: string; label: string; control: "textarea"; required: boolean }
  | { key: string; label: string; control: "boolean"; required: boolean }
  | {
      key: string;
      label: string;
      control: "select";
      required: boolean;
      multiple: boolean;
      options: Array<{ value: string; label: string }>;
      /** Present when the agent also accepts a free-form answer. */
      customKey?: string;
    };

export interface Question {
  requestId: string;
  message: string;
  fields: FormField[];
  toolCallId?: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface ConfigOptionView {
  id: string;
  name: string;
  type: "select" | "boolean";
  category?: string;
  description?: string;
  current?: string;
  options?: Array<{ value: string; label: string; description?: string }>;
}

export type ConnectionState = "starting" | "ready" | "error" | "stopped";

/**
 * Which machine the agent and every setting below come from.
 *
 * `extensionKind` pins this extension to the workspace host, so under
 * Remote-SSH this describes the remote box. It is shown in the UI because
 * "whose model list is this?" is otherwise unanswerable — the answer is never
 * the local machine's when a remote is attached.
 */
export interface HostInfoView {
  /** Short name of the machine the agent runs on. */
  host: string;
  /** `ssh-remote`, `wsl`, … — absent in a local window. */
  remoteName?: string;
  /** The executable that was actually run. */
  binary: string;
  version?: string;
  /** Where that install keeps its settings. */
  configDir?: string;
  stateDir?: string;
  /** Config sources in load order, including a project `opencode.json`. */
  sources?: Array<{ type: string; path: string; keys?: string[] }>;
  /** Agents configured on that machine. */
  agents?: Array<{ id: string; name: string; description?: string; mode?: string }>;
  /**
   * The providers that machine has configured, under the names their config
   * gives them — `OmniRouter` for `corphub`.
   *
   * This is what lets the model picker head each group with a name a person
   * would use, instead of a provider id that only its config knows.
   */
  providers?: Array<{ id: string; name?: string; models?: Record<string, string> }>;
  /** How many models that machine can reach. */
  modelCount?: number;
  /** Set when the settings could not be read at all. */
  error?: string;
}

export interface ChatState {
  connection: ConnectionState;
  connectionMessage?: string;
  busy: boolean;
  session?: SessionSummary;
  cwd?: string;
  items: ChatItem[];
  plan?: PlanEntry[];
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> };
  configOptions?: ConfigOptionView[];
  commands?: Array<{ name: string; description: string }>;
  model?: { id: string; name: string };
  /**
   * Where the model list came from.
   *
   * `host` means the session reported no model option of its own and the list
   * was read from that machine's OpenCode instead. It is still that machine's
   * list, but the session did not vouch for it, so the UI says so rather than
   * presenting it as if the session had offered it.
   *
   * `merged` means the session offered a list and the machine's own catalog
   * was added to it — the session's models first, then whatever it did not
   * mention. A session's list is routinely a subset of what its machine can
   * reach (a provider configured in `opencode.json` that the agent does not
   * enumerate), so dropping the host catalog here would hide models that work.
   */
  modelSource?: "session" | "host" | "merged";
  /**
   * Models the OpenCode TUI has recently used and starred, most recent first.
   *
   * Read from that TUI's own `model.json`, so the picker can lead with the
   * models this person actually works with instead of making them hunt through
   * every provider on the machine. Both lists are intersected with what is on
   * offer — a TUI can remember a model that has since been removed.
   */
  modelRecent?: string[];
  modelFavorite?: string[];
  /** The machine the agent and the settings above come from. */
  host?: HostInfoView;
  usage?: Usage;
  retry?: { attempt: number; nextRetryAt: string; error: { type: string; message: string } };
  /** Prompts waiting behind a running turn, shown above the composer. */
  queue?: QueuedMessage[];
  fonts: { size: number };
  options: {
    showThoughts: boolean;
    showPlan: boolean;
    diffView: "inline" | "editor" | "off";
    permissions: "ask" | "autoRead" | "all";
    maxToolOutputLines: number;
    confirmDestructiveCommands: boolean;
  };
  /** Set while an `opencode auth login` terminal is being run. */
  authInProgress?: boolean;
}

/**
 * A message waiting behind a running turn.
 *
 * It is deliberately not a `ChatItem`: a queued message has not been sent, so
 * putting it in the transcript would claim the agent had already seen it. It
 * joins the transcript at the moment it starts running.
 */
export interface QueuedMessage {
  id: string;
  /** Single-line stand-in — the queue strip is a list, not a transcript. */
  preview: string;
  blocks: Block[];
}

export interface UserItem {
  kind: "user";
  id: string;
  blocks: Block[];
  /**
   * `dropped` once the queue is discarded before the message ever reached the
   * agent. It stays in the transcript so nothing the user typed is silently
   * lost. Absent means the agent is working on it, or already has.
   */
  status?: "dropped";
}

export type ChatItem =
  | UserItem
  | { kind: "agent"; id: string; blocks: Block[]; streaming?: boolean }
  | { kind: "thought"; id: string; blocks: Block[]; streaming?: boolean }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "notice"; id: string; severity: string; title: string; description?: string }
  | { kind: "compaction"; id: string; status: string; summary: Block[] }
  | { kind: "error"; id: string; message: string; detail?: string }
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      resolved?: { outcome: "selected"; optionId: string; label: string } | { outcome: "cancelled" };
    }
  | {
      kind: "question";
      id: string;
      question: Question;
      resolved?: { action: "accept" | "decline" | "cancel"; summary?: string };
    };

/** True while the item still needs the user to act on it. */
export function isBlockingItem(item: ChatItem): boolean {
  if (item.kind === "permission") {
    return !item.resolved;
  }
  if (item.kind === "question") {
    return !item.resolved;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Extension host -> webview                                          */
/* ------------------------------------------------------------------ */

export type HostMessage =
  | { type: "state"; state: ChatState }
  | {
      type: "patch";
      items: ChatItem[];
      plan?: PlanEntry[];
      usage?: ChatState["usage"];
      retry?: ChatState["retry"];
    }
  | { type: "scrollToEnd" }
  | { type: "insertDraft"; text: string }
  | { type: "fileResults"; requestId: number; files: string[] }
  | { type: "submitDraft"; text: string }
  | { type: "openLink"; href: string }
  | { type: "focusInput" }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string };

/* ------------------------------------------------------------------ */
/* Webview -> extension host                                          */
/* ------------------------------------------------------------------ */

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; blocks?: Block[] }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "retryAgent" }
  | { type: "openSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "respondPermission"; requestId: string; optionId?: string; outcome: "selected" | "cancelled" }
  | {
      type: "respondQuestion";
      requestId: string;
      action: "accept" | "decline" | "cancel";
      values?: Record<string, unknown>;
    }
  | { type: "setMode"; modeId: string }
  | { type: "setConfigOption"; configId: string; value: string }
  | { type: "searchFiles"; query: string; requestId: number }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string; oldText: string; newText: string }
  | { type: "openLink"; href: string }
  | { type: "signIn" }
  | { type: "showLog" }
  | { type: "runCommand"; command: string }
  | { type: "copyText"; text: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };