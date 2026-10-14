import type { SessionUpdate } from "@agentclientprotocol/sdk";

import type { Block, ChatItem, PlanEntry, ToolCall, ToolCallContent, ToolStatus, UserItem } from "../shared/protocol.js";

type Update = SessionUpdate;

export interface ChildSessionMeta {
  id: string;
  parentID?: string;
  depth: number;
  title?: string;
}

const READ_ONLY_KINDS = new Set(["read", "search", "fetch", "think"]);

/** ACP `ToolKind` values that only inspect state. */
export function isReadOnlyTool(call: Pick<ToolCall, "kind" | "name">): boolean {
  if (call.kind && READ_ONLY_KINDS.has(call.kind)) {
    return true;
  }
  // opencode's own bash tool reports `execute`, so fall back to the name.
  return !call.name ? false : /^(read|glob|grep|list|search|webfetch|fetch)/i.test(call.name);
}

export interface CompactionMeta {
  status: string;
  messageId?: string;
  reason?: string;
  error?: { type: string; message: string };
}

export interface RetryMeta {
  attempt: number;
  nextRetryAt: string;
  error: { type: string; message: string };
}

/**
 * The chat transcript.
 *
 * Owns the ordered list of items shown in the webview and folds ACP
 * `session/update` notifications into it. Streaming is modelled by appending to
 * the trailing text block of the message that is currently being written.
 */
export class Thread {
  items: ChatItem[] = [];
  plan?: PlanEntry[];
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  /**
   * The reading this session actually streamed, as opposed to whatever is
   * currently on display.
   *
   * A reopened chat is seeded with the last remembered figures, so `usage`
   * alone cannot answer whether the agent has spoken this session — and that
   * is what decides if the end-of-turn session total is a fallback or a
   * regression of good data.
   */
  liveUsage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  retry?: RetryMeta;
  compaction?: CompactionMeta;

  private nextId = 1;
  private openMessageId?: string;
  private toolIndex = new Map<string, number>();

  reset(): void {
    this.items = [];
    this.plan = undefined;
    this.usage = undefined;
    this.liveUsage = undefined;
    this.retry = undefined;
    this.compaction = undefined;
    this.nextId = 1;
    this.openMessageId = undefined;
    this.toolIndex.clear();
  }

  private id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  snapshot(): ChatItem[] {
    return this.items;
  }

  get lastAssistantText(): string | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === "agent") {
        return textOf(item.blocks);
      }
    }
    return undefined;
  }

  addUser(blocks: Block[]): UserItem {
    this.closeMessage();
    const item: UserItem = { kind: "user", id: this.id("user"), blocks };
    this.items.push(item);
    return item;
  }

  /** Appends a fully-formed item (permission prompt, question, notice). */
  add(item: ChatItem): ChatItem {
    this.items.push(item);
    return item;
  }

  addNotice(severity: string, title: string, description?: string): ChatItem {
    const item: ChatItem = { kind: "notice", id: this.id("notice"), severity, title, description };
    this.items.push(item);
    return item;
  }

  addError(message: string, detail?: string): ChatItem {
    const item: ChatItem = { kind: "error", id: this.id("error"), message, detail };
    this.items.push(item);
    return item;
  }

  /** Marks the current streaming message as finished. */
  closeMessage(): void {
    if (this.openMessageId) {
      const item = this.items.find((entry) => entry.id === this.openMessageId);
      if (item && (item.kind === "agent" || item.kind === "thought")) {
        item.streaming = false;
      }
    }
    this.openMessageId = undefined;
  }

  apply(update: Update): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        // Echoed by the agent on replay; the extension already renders its own
        // user messages, so replayed ones are ignored.
        this.closeMessage();
        return;

      case "agent_message_chunk":
        this.stream(update.content, update.messageId, "agent");
        return;

      case "agent_thought_chunk":
        this.stream(update.content, update.messageId, "thought");
        return;

      case "tool_call":
        this.upsertToolCall({
          toolCallId: update.toolCallId,
          title: update.title,
          name: update.name ?? undefined,
          kind: update.kind ?? undefined,
          status: update.status ?? "pending",
          content: toContent(update.content),
          locations: toLocations(update.locations),
          childSession: childOf(update._meta),
        });
        return;

      case "tool_call_update":
        this.patchToolCall(update.toolCallId, update);
        return;

      case "plan":
        this.plan = update.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        }));
        return;

      case "plan_removed":
      case "plan_update":
        // Partial plan updates are not produced by opencode today; a later
        // `plan` update replaces the list anyway.
        return;

      case "usage_update":
        this.liveUsage = {
          used: update.used,
          size: update.size,
          cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : undefined,
        };
        this.usage = this.liveUsage;
        return;

      case "notice":
        this.addNotice(update.severity, update.title, update.description ?? undefined);
        return;

      case "compaction_update": {
        const id = `compaction:${update.compactionId}`;
        const existing = this.items.find(
          (item): item is Extract<ChatItem, { kind: "compaction" }> => item.kind === "compaction" && item.id === id,
        );
        // A `compaction_update` normally only reports status; the text arrives
        // as `compaction_summary_chunk`s. Only replace the summary when one is
        // actually present, otherwise a status-only update would erase it.
        const summary = toBlocks(update.summary);

        if (existing) {
          existing.status = update.status;
          if (summary.length) {
            existing.summary = summary;
          }
        } else {
          this.items.push({ kind: "compaction", id, status: update.status, summary });
        }
        return;
      }

      case "compaction_summary_chunk": {
        const block = toBlock(update.content);
        if (!block) {
          return;
        }
        const id = `compaction:${update.compactionId}`;
        const existing = this.items.find(
          (item): item is Extract<ChatItem, { kind: "compaction" }> => item.kind === "compaction" && item.id === id,
        );
        if (existing) {
          appendBlock(existing.summary, block);
        } else {
          this.items.push({ kind: "compaction", id, status: "completed", summary: [block] });
        }
        return;
      }

      case "session_info_update":
        this.applySessionInfo(update._meta);
        return;

      case "session_message":
      case "session_message_chunk":
      case "subagent_update":
        // Inter-session messaging and subagent bookkeeping are unstable ACP
        // extensions that opencode does not emit today. Child sessions already
        // surface through `_meta["opencode/child-session"]` on tool calls.
        return;

      default:
        // `available_commands_update`, `current_mode_update` and
        // `config_option_update` describe session metadata rather than
        // transcript content; the session layer handles those separately.
        return;
    }
  }

  private applySessionInfo(meta: Record<string, unknown> | null | undefined): void {
    const compaction = meta?.["opencode/compaction"] as
      | { status: string; messageId?: string; reason?: string; error?: { type: string; message: string } }
      | undefined;
    if (compaction) {
      this.compaction = compaction;
      return;
    }

    const retry = meta?.["opencode/retry"] as RetryMeta | null | undefined;
    if (retry === null) {
      this.retry = undefined;
    } else if (retry) {
      this.retry = retry;
    }
  }

  private stream(block: unknown, messageId: string | null | undefined, kind: "agent" | "thought"): void {
    const converted = toBlock(block);
    if (!converted) {
      return;
    }

    // A new messageId means the agent started a new message. Without one, keep
    // appending to the message that is currently streaming.
    if (messageId && this.openMessageId && messageId !== this.openMessageId) {
      this.closeMessage();
    }
    if (messageId && !this.openMessageId) {
      const item: ChatItem =
        kind === "agent"
          ? { kind: "agent", id: messageId, blocks: [], streaming: true }
          : { kind: "thought", id: messageId, blocks: [], streaming: true };
      this.items.push(item);
      this.openMessageId = messageId;
    } else if (!this.openMessageId) {
      const item: ChatItem =
        kind === "agent"
          ? { kind: "agent", id: this.id("msg"), blocks: [], streaming: true }
          : { kind: "thought", id: this.id("msg"), blocks: [], streaming: true };
      this.items.push(item);
      this.openMessageId = item.id;
    }

    const target = this.items.find((item) => item.id === this.openMessageId);
    if (target && (target.kind === "agent" || target.kind === "thought")) {
      appendBlock(target.blocks, converted);
    }
  }

  private upsertToolCall(call: ToolCall): void {
    const index = this.toolIndex.get(call.toolCallId);
    if (index !== undefined && this.items[index]?.kind === "tool") {
      this.items[index].call = call;
      return;
    }
    const item: ChatItem = { kind: "tool", id: `tool:${call.toolCallId}`, call };
    this.toolIndex.set(call.toolCallId, this.items.length);
    this.items.push(item);
  }

  private patchToolCall(
    toolCallId: string,
    update: Extract<Update, { sessionUpdate: "tool_call_update" }>,
  ): void {
    const index = this.toolIndex.get(toolCallId);
    const item = index !== undefined ? this.items[index] : undefined;
    if (!item || item.kind !== "tool") {
      // An update for a call we never saw: synthesise one so the user still
      // sees what happened (this happens when a session is partially replayed).
      this.upsertToolCall({
        toolCallId,
        title: update.title ?? "Tool call",
        name: update.name ?? undefined,
        kind: update.kind ?? undefined,
        status: update.status ?? "in_progress",
        content: toContent(update.content),
        locations: toLocations(update.locations),
        childSession: childOf(update._meta),
      });
      return;
    }

    const call = item.call;
    if (update.title != null) {
      call.title = update.title;
    }
    if (update.name != null) {
      call.name = update.name;
    }
    if (update.kind != null) {
      call.kind = update.kind;
    }
    if (update.status != null) {
      call.status = update.status;
    }
    if (update.content != null) {
      call.content = toContent(update.content);
    }
    if (update.locations != null) {
      call.locations = toLocations(update.locations);
    }
    const child = childOf(update._meta);
    if (child) {
      call.childSession = child;
    }
  }

  /** Replaces the plan with the agent's latest one. */
  setPlan(entries: PlanEntry[]): void {
    this.plan = entries;
  }
}

/* ------------------------------------------------------------------ */
/* Conversion helpers                                                  */
/* ------------------------------------------------------------------ */

export function textOf(blocks: Block[]): string {
  return blocks
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function appendBlock(blocks: Block[], block: Block): void {
  const last = blocks[blocks.length - 1];
  if (block.type === "text" && last?.type === "text") {
    last.text += block.text;
    return;
  }
  blocks.push(block);
}

export function toBlock(content: unknown): Block | undefined {
  if (!content || typeof content !== "object") {
    return undefined;
  }
  const block = content as { type?: string; [key: string]: unknown };

  switch (block.type) {
    case "text":
      return { type: "text", text: typeof block.text === "string" ? block.text : "" };

    case "image": {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        return undefined;
      }
      return { type: "image", mimeType: block.mimeType, data: block.data };
    }

    case "resource_link": {
      if (typeof block.uri !== "string") {
        return undefined;
      }
      return {
        type: "resource",
        uri: block.uri,
        name: typeof block.name === "string" ? block.name : block.uri,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      };
    }

    case "resource": {
      const resource = block.resource as { uri?: string; text?: string; blob?: string; mimeType?: string } | undefined;
      if (!resource || typeof resource.uri !== "string") {
        return undefined;
      }
      return {
        type: "resource",
        uri: resource.uri,
        name: resource.uri,
        mimeType: resource.mimeType,
        text: typeof resource.text === "string" ? resource.text : undefined,
      };
    }

    default:
      return undefined;
  }
}

function toContent(content: unknown): ToolCallContent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: ToolCallContent[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as { type?: string; [key: string]: unknown };
    switch (item.type) {
      case "content": {
        const block = toBlock(item.content);
        if (block?.type === "text") {
          result.push({ type: "text", text: block.text });
        }
        break;
      }
      case "diff": {
        if (typeof item.path === "string" && typeof item.newText === "string") {
          result.push({
            type: "diff",
            path: item.path,
            oldText: typeof item.oldText === "string" ? item.oldText : undefined,
            newText: item.newText,
          });
        }
        break;
      }
      case "terminal": {
        if (typeof item.terminalId === "string") {
          result.push({ type: "terminal", terminalId: item.terminalId });
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function toBlocks(blocks: unknown): Block[] {
  if (!Array.isArray(blocks)) {
    return [];
  }
  const result: Block[] = [];
  for (const block of blocks) {
    const converted = toBlock(block);
    if (converted) {
      result.push(converted);
    }
  }
  return result;
}

function toLocations(locations: unknown): Array<{ path: string; line?: number }> {
  if (!Array.isArray(locations)) {
    return [];
  }
  const result: Array<{ path: string; line?: number }> = [];
  for (const entry of locations) {
    if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
      const location = entry as { path: string; line?: number | null };
      result.push({ path: location.path, line: location.line ?? undefined });
    }
  }
  return result;
}

function childOf(meta: Record<string, unknown> | null | undefined): ChildSessionMeta | undefined {
  const value = meta?.["opencode/child-session"] as
    | { id: string; parentID?: string; depth: number; title?: string }
    | undefined;
  return value?.id
    ? { id: value.id, parentID: value.parentID, depth: value.depth ?? 1, title: value.title }
    : undefined;
}

export function normalizeStatus(status: ToolStatus | undefined): ToolStatus {
  return status ?? "pending";
}