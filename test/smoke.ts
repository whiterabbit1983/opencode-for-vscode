/**
 * Smoke test: drives the real `opencode acp` process through the extension's own
 * `OpenCodeAgent`, folding the resulting `session/update` stream through the
 * same `Thread` reducer the chat UI uses.
 *
 * Run with: `npm run smoke`
 */
import { OpenCodeAgent } from "../src/agent/opencode-agent.js";
import { Thread } from "../src/session/thread.js";
import type { Block, ChatItem } from "../src/shared/protocol.js";

const PROMPT = process.argv[2] ?? "Reply with a single short sentence confirming you are connected.";

const thread = new Thread();
const permissions: Array<{ title: string; options: string[] }> = [];
const updates: string[] = [];

/**
 * Drives the real `OpenCodeAgent` against the real child process.
 *
 * This deliberately goes through the extension's own agent class rather than
 * re-implementing the transport: a wiring bug here (a mis-encoded stream, a
 * capability typo) is exactly what this test exists to catch, and a parallel
 * implementation would not notice it.
 */
async function main(): Promise<void> {
  const agent = new OpenCodeAgent({
    sessionUpdate: (notification) => {
      updates.push(notification.update.sessionUpdate);
      thread.apply(notification.update);
    },
    requestPermission: async (params) => {
      permissions.push({
        title: params.toolCall.title ?? "tool call",
        options: params.options.map((option) => option.kind),
      });
      const allow =
        params.options.find((option) => option.kind === "allow_always") ??
        params.options.find((option) => option.kind === "allow_once");
      return allow
        ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    },
    createElicitation: async () => ({ action: "cancel" as const }),
    completeElicitation: () => undefined,
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => undefined,
  });

  try {
    await agent.ensureStarted();
    console.log("initialize ->", {
      protocolVersion: agent.protocolVersion,
      agent: agent.agentInfo,
      loadSession: agent.agentCapabilities?.loadSession,
      sessionCapabilities: Object.keys(agent.agentCapabilities?.sessionCapabilities ?? {}),
      promptCapabilities: agent.agentCapabilities?.promptCapabilities,
    });

    const cwd = process.cwd();
    const session = await agent.newSession(cwd);
    console.log("session/new ->", session.sessionId);
    console.log("  modes:", session.modes?.availableModes?.map((mode) => mode.name).join(", ") || "(none)");
    console.log(
      "  config options:",
      (session.configOptions ?? [])
        .map((option) => `${option.id}=${option.type === "select" ? option.currentValue : String(option.currentValue)}`)
        .join(", ") || "(none)",
    );

    // Give the agent a moment to send `available_commands_update`.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const listed = await agent.listSessions(cwd);
    console.log("session/list ->", listed.sessions.length, "session(s)");

    try {
      const response = await agent.prompt(session.sessionId, [{ type: "text", text: PROMPT }]);
      console.log("\nsession/prompt ->", JSON.stringify(response));
      console.log("update kinds  ->", [...new Set(updates)].join(", "));
      console.log("permissions   ->", permissions.length, JSON.stringify(permissions.slice(0, 5)));

      console.log("\n--- rendered transcript ---");
      for (const item of thread.snapshot()) {
        console.log(render(item));
      }
    } catch (error) {
      // Code -32000 is ACP's `auth_required`: the machine running the test has
      // no provider credentials. The transport, handshake and session setup are
      // all verified by this point, so this is a pass with a caveat rather than
      // a failure.
      if (!isAuthRequired(error)) {
        throw error;
      }
      console.log("\nsession/prompt -> auth_required (no provider credentials on this machine)");
      console.log("This exercised the extension's sign-in path. Run `opencode auth login` for a full turn.");
    }
  } catch (error) {
    console.error("smoke test failed:", error);
    process.exitCode = 1;
  } finally {
    agent.dispose();
  }
}

function isAuthRequired(error: unknown): boolean {
  return typeof (error as { code?: number })?.code === "number" && (error as { code: number }).code === -32000;
}

function render(item: ChatItem): string {
  switch (item.kind) {
    case "user":
      return `  user      | ${blocks(item.blocks)}`;
    case "agent":
      return `  agent     | ${blocks(item.blocks)}`;
    case "thought":
      return `  thought   | ${blocks(item.blocks).slice(0, 120)}`;
    case "tool": {
      const diffs = item.call.content.filter((entry) => entry.type === "diff");
      return `  tool      | [${item.call.status}] ${item.call.title} (${diffs.length} diffs)`;
    }
    case "notice":
      return `  notice    | ${item.title}`;
    case "error":
      return `  error     | ${item.message}`;
    case "compaction":
      return `  compact   | ${item.status}`;
    default:
      return `  ${item.kind.padEnd(9)}|`;
  }
}

function blocks(list: Block[]): string {
  const text = list
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

main();