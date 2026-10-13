import assert from "node:assert/strict";
import { test } from "node:test";

import { Thread, isReadOnlyTool, toBlock } from "../src/session/thread.js";
import { chooseAutomatically, destructiveReason, sliceLines, toFormFields } from "../src/session/policy.js";
import { diffLines } from "../webview/diff.js";
import { escapeHtml, highlight, renderMarkdown, sanitizeUrl } from "../webview/markdown.js";
import { modelLabel, modelName } from "../src/shared/model-name.js";
import type { Block, ChatItem, PermissionRequest } from "../src/shared/protocol.js";

/* ------------------------------------------------------------------ */
/* Transcript reducer                                                   */
/* ------------------------------------------------------------------ */

const text = (value: string) => ({ type: "text" as const, text: value });

test("streams an agent message into a single item", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("Hel"), messageId: "m1" } as never);
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("lo"), messageId: "m1" } as never);

  const items = thread.snapshot();
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kind, "agent");
  assert.equal(textOf(item), "Hello");
  assert.equal(item.streaming, true);
});

test("a new messageId starts a new message", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("one"), messageId: "m1" } as never);
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("two"), messageId: "m2" } as never);

  assert.equal(thread.snapshot().length, 2);
  assert.equal(textOf(thread.snapshot()[0]), "one");
  assert.equal(textOf(thread.snapshot()[1]), "two");
});

test("closeMessage ends the streaming marker", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("hi"), messageId: "m1" } as never);
  thread.closeMessage();
  const item = thread.snapshot()[0];
  assert.equal(item.kind, "agent");
  assert.equal(item.streaming, false);
});

test("thought chunks stay separate from agent messages", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "agent_thought_chunk", content: text("pondering"), messageId: "t1" } as never);
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("answer"), messageId: "m1" } as never);

  const kinds = thread.snapshot().map((item) => item.kind);
  assert.deepEqual(kinds, ["thought", "agent"]);
});

test("tool calls are created then patched in place", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Read a.ts",
    kind: "read",
    status: "in_progress",
  } as never);

  thread.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    title: "Read a.ts (done)",
    content: [{ type: "content", content: text("file body") }],
  } as never);

  const items = thread.snapshot();
  assert.equal(items.length, 1);
  const call = (items[0] as Extract<ChatItem, { kind: "tool" }>).call;
  assert.equal(call.status, "completed");
  assert.equal(call.title, "Read a.ts (done)");
  assert.deepEqual(call.content, [{ type: "text", text: "file body" }]);
});

test("a tool call update for an unseen call is synthesised", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "orphan",
    title: "Write b.ts",
    status: "completed",
  } as never);

  const items = thread.snapshot();
  assert.equal(items.length, 1);
  assert.equal((items[0] as Extract<ChatItem, { kind: "tool" }>).call.title, "Write b.ts");
});

test("diffs on a tool call are extracted", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Edit",
    content: [{ type: "diff", path: "/a.ts", oldText: "a", newText: "b" }],
  } as never);

  const call = (thread.snapshot()[0] as Extract<ChatItem, { kind: "tool" }>).call;
  assert.equal(call.content[0].type, "diff");
});

test("child sessions are surfaced from _meta", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "tool_call",
    toolCallId: "sub:1",
    title: "Explore",
    _meta: { "opencode/child-session": { id: "ses_child", parentID: "ses_main", depth: 1, title: "Explorer" } },
  } as never);

  const call = (thread.snapshot()[0] as Extract<ChatItem, { kind: "tool" }>).call;
  assert.deepEqual(call.childSession, { id: "ses_child", parentID: "ses_main", depth: 1, title: "Explorer" });
});

test("plan updates replace the previous plan", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "plan",
    entries: [{ content: "first", priority: "high", status: "pending" }],
  } as never);
  thread.apply({
    sessionUpdate: "plan",
    entries: [
      { content: "first", priority: "high", status: "completed" },
      { content: "second", priority: "low", status: "in_progress" },
    ],
  } as never);

  assert.equal(thread.plan?.length, 2);
  assert.equal(thread.plan?.[0].status, "completed");
});

test("retry metadata is cleared when the agent reports null", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "session_info_update",
    _meta: { "opencode/retry": { attempt: 1, nextRetryAt: "2026-10-02T12:00:05.000Z", error: { type: "rate", message: "slow down" } } },
  } as never);
  assert.equal(thread.retry?.attempt, 1);

  thread.apply({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } } as never);
  assert.equal(thread.retry, undefined);
});

test("usage updates are recorded", () => {
  const thread = new Thread();
  thread.apply({
    sessionUpdate: "usage_update",
    used: 1540,
    size: 200000,
    cost: { amount: 0.012, currency: "USD" },
  } as never);

  assert.deepEqual(thread.usage, { used: 1540, size: 200000, cost: { amount: 0.012, currency: "USD" } });
});

test("compaction summary chunks accumulate", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: text("first ") } as never);
  thread.apply({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: text("second") } as never);
  thread.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" } as never);

  const compaction = thread.snapshot().find((item) => item.kind === "compaction");
  assert.ok(compaction && compaction.kind === "compaction");
  assert.equal(compaction.status, "completed");
  assert.equal(textOf(compaction), "first second");
});

test("reset clears everything", () => {
  const thread = new Thread();
  thread.apply({ sessionUpdate: "agent_message_chunk", content: text("x"), messageId: "m" } as never);
  thread.apply({ sessionUpdate: "plan", entries: [{ content: "a", priority: "low", status: "pending" }] } as never);
  thread.reset();
  assert.deepEqual(thread.snapshot(), []);
  assert.equal(thread.plan, undefined);
});

test("images and resource links convert to display blocks", () => {
  assert.deepEqual(toBlock({ type: "image", data: "AAA", mimeType: "image/png" }), {
    type: "image",
    mimeType: "image/png",
    data: "AAA",
  });
  assert.deepEqual(toBlock({ type: "resource_link", uri: "file:///a.ts", name: "a.ts" }), {
    type: "resource",
    uri: "file:///a.ts",
    name: "a.ts",
    mimeType: undefined,
  });
  assert.equal(toBlock({ type: "image", mimeType: "image/png" }), undefined);
});

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

const permission = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: "p1",
  title: "Run a command",
  kind: "execute",
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
  content: [],
  ...overrides,
});

const never = () => false;
const always = () => true;

test("ask never auto-approves", () => {
  assert.equal(chooseAutomatically(permission(), "ask", always), undefined);
});

test("all auto-approves with the most persistent option", () => {
  assert.deepEqual(chooseAutomatically(permission(), "all", never), { optionId: "always" });
});

test("autoRead only approves read-only tools", () => {
  assert.deepEqual(chooseAutomatically(permission({ kind: "read" }), "autoRead", always), { optionId: "always" });
  assert.equal(chooseAutomatically(permission({ kind: "edit" }), "autoRead", never), undefined);
});

test("autoRead falls back to allow_once when no persistent option exists", () => {
  const onceOnly: PermissionRequest = {
    ...permission(),
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  };
  assert.deepEqual(chooseAutomatically(onceOnly, "all", never), { optionId: "once" });
});

test("read-only tools are recognised by kind and by name", () => {
  assert.equal(isReadOnlyTool({ kind: "read" }), true);
  assert.equal(isReadOnlyTool({ kind: "search" }), true);
  assert.equal(isReadOnlyTool({ kind: "edit" }), false);
  assert.equal(isReadOnlyTool({ kind: undefined, name: "webfetch" }), true);
  assert.equal(isReadOnlyTool({ kind: undefined, name: "bash" }), false);
});

test("destructive commands are flagged", () => {
  assert.match(destructiveReason({ rawInput: { command: "rm -rf ./build" } }) ?? "", /permanently deletes/);
  assert.match(destructiveReason({ rawInput: { command: "git reset --hard HEAD" } }) ?? "", /uncommitted/);
  assert.equal(destructiveReason({ rawInput: { command: "bun test" } }), undefined);
  assert.equal(destructiveReason({ rawInput: {} }), undefined);
  assert.equal(destructiveReason({ rawInput: "rm -rf /" }), undefined);
});

test("sliceLines honours ACP line and limit", () => {
  const text1 = "a\nb\nc\nd";
  assert.equal(sliceLines(text1), text1);
  assert.equal(sliceLines(text1, 2), "b\nc\nd");
  assert.equal(sliceLines(text1, 2, 2), "b\nc");
});

/* ------------------------------------------------------------------ */
/* Model names                                                          */
/* ------------------------------------------------------------------ */

test("model ids read as words without their provider", () => {
  assert.deepEqual(modelLabel("opencode/cat-jam-free", "opencode/Cat Jam Free"), {
    name: "Cat Jam Free",
    provider: "opencode",
  });
  assert.deepEqual(modelLabel("anthropic/claude-sonnet-4-5"), {
    name: "Claude Sonnet 4 5",
    provider: "anthropic",
  });
  assert.deepEqual(modelLabel("lmstudio/qwen/qwen3-coder-30b", "lmstudio/Qwen3 Coder 30B"), {
    name: "Qwen3 Coder 30B",
    provider: "lmstudio",
  });
});

test("model names the agent already formats are left alone", () => {
  assert.equal(modelName("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5"), "Claude Sonnet 4.5");
  assert.equal(modelName("lmstudio/openai/gpt-oss-20b", "lmstudio/GPT OSS 20B"), "GPT OSS 20B");
});

test("an id with no provider or label still produces a name", () => {
  assert.deepEqual(modelLabel("gpt-5"), { name: "Gpt 5", provider: undefined });
  assert.deepEqual(modelLabel("opencode/cat-jam-free", "   "), { name: "Cat Jam Free", provider: "opencode" });
  assert.deepEqual(modelLabel("opencode/gpt-oss-20b", "gpt-oss-20b"), {
    name: "Gpt Oss 20b",
    provider: "opencode",
  });
});

/* ------------------------------------------------------------------ */
/* Elicitation forms                                                    */
/* ------------------------------------------------------------------ */

test("a single-choice string becomes a select", () => {
  const fields = toFormFields({
    type: "object",
    properties: { pm: { type: "string", oneOf: [{ const: "bun", title: "Bun" }, { const: "npm", title: "npm" }] } },
    required: ["pm"],
  });

  assert.deepEqual(fields, [
    { key: "pm", label: "pm", control: "select", multiple: false, required: true, options: [
      { value: "bun", label: "Bun" },
      { value: "npm", label: "npm" },
    ] },
  ]);
});

test("an array property becomes a multi-select", () => {
  const [field] = toFormFields({
    properties: { tools: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
  });
  assert.equal(field.control, "select");
  assert.equal(field.multiple, true);
  assert.deepEqual(field.options, [
    { value: "a", label: "a" },
    { value: "b", label: "b" },
  ]);
});

test("a boolean property becomes a checkbox", () => {
  const [field] = toFormFields({ properties: { verbose: { type: "boolean", title: "Verbose" } } });
  assert.equal(field.control, "boolean");
  assert.equal(field.label, "Verbose");
});

test("a free string becomes a text input", () => {
  const [field] = toFormFields({
    properties: { note: { type: "string", description: "Anything else?" } },
  });
  assert.equal(field.control, "text");
  assert.equal(field.placeholder, "Anything else?");
});

test("a _custom companion attaches to its select", () => {
  const fields = toFormFields({
    properties: {
      pm: { type: "string", oneOf: [{ const: "bun", title: "Bun" }] },
      pm_custom: { type: "string" },
    },
  });
  assert.equal(fields[0].control, "select");
  assert.equal(fields[0].customKey, "pm_custom");
  assert.equal(fields.length, 1);
});

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

test("identical files produce no changes", () => {
  const result = diffLines("a\nb\nc", "a\nb\nc");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
});

test("a changed line becomes one delete and one add", () => {
  const result = diffLines("a\nb\nc", "a\nB\nc");
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 1);
  const edits = result.rows.filter((row) => row.type === "add" || row.type === "del");
  assert.deepEqual(
    edits.map((row) => [row.type, "text" in row ? row.text : ""]),
    [
      ["del", "b"],
      ["add", "B"],
    ],
  );
});

test("a pure insertion only adds lines", () => {
  const result = diffLines("a\nc", "a\nb\nc");
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
});

test("unrelated changes collapse into hunk markers", () => {
  const oldText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
  const newText = oldText.replace("line 2", "LINE 2").replace("line 50", "LINE 50");
  const result = diffLines(oldText, newText, 2);

  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 2);
  assert.ok(result.rows.some((row) => row.type === "hunk"), "expected a hunk marker");
  assert.ok(result.rows.length < oldText.split("\n").length, "context should be collapsed");
});

test("an empty original reads as a new file", () => {
  const result = diffLines("", "a\nb");
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 0);
});

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

test("raw HTML in model output is escaped", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)>");
  assert.ok(!html.includes("<img src=x"), `unexpected raw HTML: ${html}`);
  assert.ok(html.includes("&lt;img"));
});

test("javascript links are dropped", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!html.includes("javascript:alert"), html);
  assert.equal(sanitizeUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeUrl("https://example.com"), "https://example.com");
  assert.equal(sanitizeUrl("#anchor"), "#anchor");
});

test("safe links are preserved", () => {
  const html = renderMarkdown("[docs](https://opencode.ai/docs)");
  assert.ok(html.includes('href="https://opencode.ai/docs"'));
  assert.ok(html.includes("data-external"));
});

test("code fences render as copyable blocks", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```");
  assert.ok(html.includes("code-block"));
  assert.ok(html.includes("code-copy"));
  assert.ok(html.includes(">ts<"));
});

test("fenced code content is escaped", () => {
  const html = renderMarkdown("```\n<script>bad()</script>\n```");
  assert.ok(!html.includes("<script>bad"), html);
});

test("the highlighter never emits unescaped input", () => {
  const html = highlight("<img src=x> & 'quotes'", "ts");
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"));
});

test("escapeHtml covers the dangerous characters", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

/* ------------------------------------------------------------------ */

function textOf(item: ChatItem): string {
  const blocks: Block[] =
    item.kind === "compaction"
      ? item.summary
      : "blocks" in item
        ? item.blocks
        : [];
  return blocks
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}