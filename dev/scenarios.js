// Sample states for dev/preview.html. Loaded as an inline script so the preview
// harness can switch between scenarios with `?scenario=…`.
const options = {
  permissions: "ask",
  showThoughts: false,
  showPlan: true,
  diffView: "inline",
  maxToolOutputLines: 40,
  confirmDestructiveCommands: true,
};

const base = {
  connection: "ready",
  busy: false,
  cwd: "/work/acme-api",
  fonts: { size: 0 },
  options,
  modes: {
    currentModeId: "build",
    availableModes: [
      { id: "build", name: "Build", description: "Edit files and run commands" },
      { id: "plan", name: "Plan", description: "Research and propose, no edits" },
      { id: "ask", name: "Ask", description: "Answer questions about the code" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      current: "anthropic/claude-sonnet-4-5",
      options: [
        { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { value: "openai/gpt-5", label: "GPT-5" },
        { value: "anthropic/claude-opus-4-1", label: "Claude Opus 4.1" },
      ],
    },
    {
      id: "effort",
      name: "Reasoning effort",
      type: "select",
      category: "thought_level",
      current: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
  ],
  commands: [{ name: "compact", description: "Compact the session" }],
  usage: { used: 48_120, size: 200_000, cost: { amount: 0.087, currency: "USD" } },
};

const diff = {
  type: "diff",
  path: "/work/acme-api/src/rate-limit.ts",
  oldText: `export function rateLimit(key: string, limit = 100) {
  const hits = store.get(key) ?? 0
  if (hits >= limit) throw new Error("rate limited")
  store.set(key, hits + 1)
}
`,
  newText: `export function rateLimit(key: string, limit = 100) {
  const hits = store.get(key) ?? 0
  if (hits >= limit) throw new Error(\`rate limited: \${key}\`)
  store.set(key, hits + 1)
}

export function resetLimit(key: string) {
  store.delete(key)
}
`,
};

scenarios = {
  empty: {
    ...base,
    items: [],
  },

  // A window attached over Remote-SSH: the agent, its settings and its models
  // all come from the box on the other end, and the chat has to say so.
  "remote-host": {
    ...base,
    cwd: "/srv/acme-api",
    host: {
      host: "build-box",
      remoteName: "ssh-remote",
      binary: "/home/dev/.opencode/bin/opencode",
      version: "2.0.27",
      configDir: "/home/dev/.config/opencode",
      stateDir: "/home/dev/.local/state/opencode",
      sources: [
        { type: "directory", path: "/home/dev/.config/opencode" },
        { type: "document", path: "/srv/acme-api/opencode.json", keys: ["model", "theme"] },
      ],
      agents: [
        { id: "build", name: "Build", mode: "primary" },
        { id: "review", name: "Review", description: "Read-only reviewer", mode: "subagent" },
      ],
      modelCount: 12,
    },
    items: [],
  },

  welcome: {
    ...base,
    items: [],
  },

  // The same window on an agent whose session reported no model list: the picker
  // is filled from the host's own OpenCode, and says where the list came from.
  "remote-host-model-fallback": {
    ...base,
    cwd: "/srv/acme-api",
    host: {
      host: "build-box",
      remoteName: "ssh-remote",
      binary: "/home/dev/.opencode/bin/opencode",
      version: "2.0.27",
      configDir: "/home/dev/.config/opencode",
      modelCount: 3,
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        options: [
          { value: "opencode/big-pickle", label: "opencode/big-pickle" },
          { value: "opencode/cat-jam-free", label: "opencode/cat-jam-free" },
          { value: "opencode/space-bunny-free", label: "opencode/space-bunny-free" },
        ],
      },
    ],
    modelSource: "host",
    items: [],
  },

  // A remote host whose catalog is mostly a custom provider: every model id is
  // `corphub/…`, several of them nested one level deeper (`corphub/cc/…`).
  omnirouter: {
    ...base,
    cwd: "/srv/acme-api",
    host: {
      host: "build-box",
      remoteName: "ssh-remote",
      binary: "/home/dev/.opencode/bin/opencode",
      version: "2.0.27",
      configDir: "/home/dev/.config/opencode",
      modelCount: 20,
      providers: [
        {
          id: "corphub",
          name: "OmniRouter",
          models: {
            "claude-fable-5-1": "Claude Fable 5.1",
            "claude-fable-5-1-max": "Claude Fable 5.1 Max",
            "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
            "claude-haiku-5-5": "Claude Haiku 5.5",
            "claude-opus-5-5": "Claude Opus 5.5",
            "cc/claude-opus-5-5": "Claude Opus 5.5 (cc)",
            "claude/claude-opus-5-5": "Claude Opus 5.5 (claude)",
            "claude-sonnet-5-5": "Claude Sonnet 5.5",
          },
        },
      ],
    },
    modelRecent: ["corphub/claude-opus-5-5", "corphub/cc/claude-opus-5-5"],
    modelFavorite: ["corphub/claude-sonnet-5-5"],
    // The agent offered a partial list; the rest was read from the host. This
    // is the state a remote box actually lands in, where a custom provider in
    // `opencode.json` is missing from what the agent enumerates.
    modelSource: "merged",
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        current: "corphub/claude-opus-5-5",
        options: [
          { value: "corphub/claude-fable-5-1", label: "corphub/Claude Fable 5.1" },
          { value: "corphub/claude-fable-5-1-max", label: "corphub/Claude Fable 5.1 Max" },
          { value: "corphub/claude-haiku-4-5-20251001", label: "corphub/Claude Haiku 4.5" },
          { value: "corphub/claude-haiku-5-5", label: "corphub/Claude Haiku 5.5" },
          { value: "corphub/claude-opus-5-5", label: "corphub/Claude Opus 5.5" },
          { value: "corphub/cc/claude-opus-5-5", label: "corphub/Claude Opus 5.5 (cc)" },
          { value: "corphub/claude/claude-opus-5-5", label: "corphub/Claude Opus 5.5 (claude)" },
          { value: "corphub/claude-sonnet-5-5", label: "corphub/Claude Sonnet 5.5" },
          { value: "opencode/big-pickle", label: "opencode/Big Pickle" },
          { value: "opencode/cat-jam-free", label: "opencode/Cat Jam Free" },
          { value: "opencode/exo-free", label: "opencode/Exo Free" },
          { value: "opencode/ling-3.0-flash-fin-free", label: "opencode/Ling 3.0 Flash Fin Free" },
          { value: "opencode/ling-3.1-flash-free", label: "opencode/Ling 3.1 Flash Free" },
          { value: "opencode/longcat-2.5-preview-free", label: "opencode/LongCat 2.5 Preview Free" },
          { value: "opencode/mimo-v2.6-flash-free", label: "opencode/MiMo-V2.6-Flash Free" },
          { value: "opencode/muse-spark-1.3-contributor-free", label: "opencode/Muse Spark 1.3 Free" },
          { value: "opencode/nemotron-3-ultra-free", label: "opencode/Nemotron 3 Ultra Free" },
          { value: "opencode/nemotron-3.5-lightning-free", label: "opencode/Nemotron 3.5 Lightning Free" },
          { value: "opencode/space-bunny-free", label: "opencode/Space Bunny Free" },
          { value: "opencode/step-5-preview-free", label: "opencode/Step 5 Preview Free" },
        ],
      },
    ],
    items: [],
  },

  // A turn that has already finished: `busy` is false, but the last message
  // still carries the streaming marker the agent left on it. The dots have to
  // be gone anyway — they mean "writing now", not "once wrote this".
  finished: {
    ...base,
    busy: false,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Rename the helper." }] },
      { kind: "agent", id: "a1", streaming: true, blocks: [{ type: "text", text: "Renamed `clearCounter` to `resetLimit` and updated the two call sites." }] },
    ],
  },

  // The same transcript mid-turn, where the dots belong.
  streaming: {
    ...base,
    busy: true,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Rename the helper." }] },
      { kind: "agent", id: "a1", streaming: true, blocks: [{ type: "text", text: "Renamed `clearCounter` to `resetLimit` and updated the two call sites." }] },
    ],
  },

  // Two messages waiting behind a running turn. Neither has a transcript
  // bubble: they sit above the composer, numbered in the order they will run.
  queue: {
    ...base,
    busy: true,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Add rate limiting to the public routes." }] },
      { kind: "agent", id: "a1", streaming: true, blocks: [{ type: "text", text: "Looking at the router first." }] },
    ],
    queue: [
      {
        id: "queued-1",
        preview: "Also cover the burst case in the test.",
        blocks: [{ type: "text", text: "Also cover the burst case in the test." }],
      },
      {
        id: "queued-2",
        preview: "Then run the suite and tell me if anything else regressed.",
        blocks: [{ type: "text", text: "Then run the suite and tell me if anything else regressed." }],
      },
    ],
  },

  // The same queue after the turn it was waiting on failed, so the messages
  // come back into the transcript marked unsent rather than vanishing.
  "queue-dropped": {
    ...base,
    busy: false,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Add rate limiting to the public routes." }] },
      { kind: "user", id: "u2", status: "dropped", blocks: [{ type: "text", text: "Also cover the burst case in the test." }] },
      { kind: "notice", id: "n1", severity: "warning", title: "Queued messages discarded", description: "This turn failed before the queue could run." },
    ],
  },

  // The agent is still coming up: same greeting, different wording. Anything
  // that survives the switch to `welcome` is a greeting that never went away.
  starting: {
    ...base,
    connection: "starting",
    items: [],
  },

  // Mixed statuses: only the finished calls collapse. The one running and the
  // one that failed stay on screen — that is when the user is watching them.
  mixed: {
    ...base,
    busy: true,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Add the endpoint and its test." }] },
      { kind: "tool", id: "t1", call: { toolCallId: "call_1", title: "Read src/server.ts", name: "read", kind: "read", status: "completed", content: [], locations: [] } },
      { kind: "tool", id: "t2", call: { toolCallId: "call_2", title: "Search for existing routes", name: "grep", kind: "search", status: "completed", content: [], locations: [] } },
      { kind: "tool", id: "t3", call: { toolCallId: "call_3", title: "bun test --run", name: "bash", kind: "execute", status: "in_progress", content: [], locations: [] } },
      { kind: "tool", id: "t4", call: { toolCallId: "call_4", title: "Edit src/routes.ts", name: "edit", kind: "edit", status: "failed", content: [{ type: "text", text: "patch does not apply: context mismatch at line 42" }], locations: [] } },
    ],
  },

  transcript: {
    ...base,
    plan: [
      { content: "Read the rate limiter and its tests", priority: "high", status: "completed" },
      { content: "Add a reset helper with coverage", priority: "high", status: "in_progress" },
      { content: "Run the test suite", priority: "medium", status: "pending" },
    ],
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "The rate limiter never clears old keys, so a client that retries forever stays blocked. Fix it and add a test." }] },
      {
        kind: "tool",
        id: "t1",
        call: {
          toolCallId: "call_1",
          title: "Read src/rate-limit.ts",
          name: "read",
          kind: "read",
          status: "completed",
          content: [{ type: "text", text: "export function rateLimit(key: string, limit = 100) {\n  const hits = store.get(key) ?? 0\n  ..." }],
          locations: [{ path: "/work/acme-api/src/rate-limit.ts", line: 1 }],
        },
      },
      {
        kind: "tool",
        id: "t2",
        call: {
          toolCallId: "call_2",
          title: "Edit src/rate-limit.ts",
          name: "edit",
          kind: "edit",
          status: "completed",
          content: [diff],
          locations: [{ path: "/work/acme-api/src/rate-limit.ts" }],
        },
      },
      {
        kind: "tool",
        id: "t3",
        call: {
          toolCallId: "call_3",
          title: "bun test --run src/rate-limit.test.ts",
          name: "bash",
          kind: "execute",
          status: "completed",
          content: [
            {
              type: "text",
              text: "$ bun test --run src/rate-limit.test.ts\nbun test v1.1.34\n\nsrc/rate-limit.test.ts:\n✓ allows requests under the limit [1.2ms]\n✓ rejects requests over the limit [0.4ms]\n✓ resetLimit clears the counter [0.8ms]\n\n3 pass, 0 fail, 7 expect() calls\nRan 3 tests in 42ms.",
            },
          ],
          locations: [],
        },
      },
      {
        kind: "agent",
        id: "a1",
        blocks: [
          {
            type: "text",
            text: "Added a `resetLimit` helper and covered it.\n\nThe window logic itself is unchanged — this gives callers an explicit way to clear a counter instead of waiting for the store to expire:\n\n```ts\nexport function resetLimit(key: string) {\n  store.delete(key)\n}\n```\n\nTests: **3 passing**. I did not change the default TTL, since that would affect every existing client.",
          },
        ],
      },
    ],
  },

  permission: {
    ...base,
    busy: true,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Run the migration and then the full suite." }] },
      {
        kind: "tool",
        id: "t1",
        call: {
          toolCallId: "call_1",
          title: "Read drizzle.config.ts",
          name: "read",
          kind: "read",
          status: "completed",
          content: [],
          locations: [{ path: "/work/acme-api/drizzle.config.ts" }],
        },
      },
      {
        kind: "permission",
        id: "permission:perm_1",
        request: {
          requestId: "perm_1",
          toolCallId: "call_2",
          title: "Run a shell command",
          kind: "execute",
          name: "bash",
          warning: "This command permanently deletes files. Check the command before approving.",
          content: [{ type: "text", text: "bunx drizzle-kit push --force && rm -rf ./var/cache && bun test" }],
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      },
    ],
  },

  question: {
    ...base,
    busy: true,
    items: [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "Add a migration for the new index." }] },
      {
        kind: "question",
        id: "question:ask_1",
        question: {
          requestId: "ask_1",
          message: "Which migration strategy should this index use?",
          fields: [
            {
              key: "strategy",
              label: "Strategy",
              control: "select",
              multiple: false,
              required: true,
              options: [
                { value: "concurrent", label: "CREATE INDEX CONCURRENTLY" },
                { value: "plain", label: "Plain CREATE INDEX" },
                { value: "external", label: "External tool (concurrently + drop)" },
              ],
            },
            { key: "note", label: "Notes", control: "textarea", required: false },
          ],
        },
      },
    ],
  },

  error: {
    ...base,
    connection: "error",
    connectionMessage: "opencode exited with code 1: provider authentication required",
    items: [],
  },
};