/**
 * The remote host's own OpenCode settings.
 *
 * Under Remote-SSH the only machine that can answer "which models are
 * available?" is the one the agent runs on, and the extension has to ask *that*
 * machine — with the binary and the environment the agent itself was started
 * with, not a fresh resolution that could land on a different install.
 *
 * These tests cover it without an SSH server: a stand-in `opencode` answers both
 * the settings commands and ACP, and it is reached through a home directory
 * whose rc file puts it on `PATH`, which is exactly the shape of the problem on
 * a remote host.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readHostInfo } from "../src/agent/host-info.js";
import { ChatSession } from "../src/session/chat-session.js";
import {
  hostModelCurrent,
  modelOptionsFromHost,
  parseAgents,
  parseConfigSources,
  parseModels,
  parsePaths,
  parseProviders,
  parseTuiModels,
  parseVersion,
} from "../src/shared/opencode-cli.js";

/* ------------------------------------------------------------------ */
/* Parsing the CLI's output                                            */
/* ------------------------------------------------------------------ */

test("paths are read as the key/value table the CLI prints", () => {
  const paths = parsePaths(
    ["home /home/dev", "data /home/dev/.local/share/opencode", "config /home/dev/.config/opencode", ""].join("\n"),
  );
  assert.equal(paths.home, "/home/dev");
  assert.equal(paths.config, "/home/dev/.config/opencode");
});

test("noise on the paths table is not read as a setting", () => {
  const paths = parsePaths(["starting opencode...", "config /home/dev/.config/opencode"].join("\n"));
  assert.deepEqual(Object.keys(paths), ["config"]);
});

test("models are read as provider/model ids", () => {
  const models = parseModels(["opencode/cat-jam-free", "anthropic/claude-sonnet-4-5", ""].join("\n"));
  assert.deepEqual(models, ["opencode/cat-jam-free", "anthropic/claude-sonnet-4-5"]);
});

test("a repeated model is listed once", () => {
  assert.deepEqual(parseModels(["opencode/big-pickle\nopencode/big-pickle"].join("\n")), ["opencode/big-pickle"]);
});

test("a model line with extra columns still yields the id", () => {
  // Older CLIs print cost columns after the id; the id is the first token.
  assert.deepEqual(parseModels("opencode/cat-jam-free   free"), ["opencode/cat-jam-free"]);
});

test("text that is not a model id is dropped", () => {
  assert.deepEqual(parseModels(["Provider  Model", "", "/", "opencode"].join("\n")), []);
});

test("config sources keep their order and the keys each one sets", () => {
  const stdout = JSON.stringify([
    { type: "directory", path: "/home/dev/.config/opencode" },
    {
      type: "document",
      path: "/srv/app/opencode.json",
      info: { theme: "tokyonight", model: { providerID: "opencode" } },
    },
  ]);
  const sources = parseConfigSources(stdout);
  assert.deepEqual(sources, [
    { type: "directory", path: "/home/dev/.config/opencode", keys: undefined },
    { type: "document", path: "/srv/app/opencode.json", keys: ["model", "theme"] },
  ]);
});

test("a notice printed before the JSON does not lose the config sources", () => {
  const stdout = `starting opencode...\n${JSON.stringify([{ type: "directory", path: "/home/dev/.config" }])}`;
  assert.equal(parseConfigSources(stdout)[0]?.path, "/home/dev/.config");
});

test("config output that is not JSON at all reads as no sources", () => {
  assert.deepEqual(parseConfigSources("command not found: opencode debug config"), []);
});

test("agents are read with the fields worth showing", () => {
  const stdout = JSON.stringify([
    { id: "build", name: "Build", description: "The default agent.", mode: "primary", hidden: false },
    { id: "plan", name: "Plan", mode: "primary" },
  ]);
  const agents = parseAgents(stdout);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].id, "build");
  assert.equal(agents[0].description, "The default agent.");
  assert.equal(agents[1].name, "Plan");
});

test("the version is read without its leading v", () => {
  assert.equal(parseVersion("opencode v2.0.27"), "2.0.27");
  assert.equal(parseVersion("2.1.0"), "2.1.0");
});

test("only a model the host offers can be marked as current", () => {
  // The session never said which model it is on; claiming one it does not have
  // would put a checkmark on a row the agent cannot use.
  assert.equal(hostModelCurrent(["opencode/big-pickle"], "anthropic/claude-sonnet-4-5"), undefined);
  assert.equal(hostModelCurrent(["opencode/big-pickle"], undefined), undefined);
  assert.equal(hostModelCurrent(["opencode/big-pickle"], "opencode/big-pickle"), "opencode/big-pickle");
});

test("host model choices keep their id as the label", () => {
  assert.deepEqual(modelOptionsFromHost(["opencode/big-pickle"]), [{ value: "opencode/big-pickle", label: "opencode/big-pickle" }]);
});

/* ------------------------------------------------------------------ */
/* Asking the machine the agent runs on                                */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for an OpenCode install that speaks just enough of both worlds:
 * the settings commands, and ACP whose `session/new` reports a model list in
 * whichever shape is being exercised — none at all (an older agent, or one whose
 * options did not come back), an empty one, or a real one.
 */
function standInOpenCode(
  dir: string,
  options: { configOptions?: "none" | "empty-model" | "model" | "partial-model"; omnirouter?: boolean } = {},
): string {
  const binary = join(dir, "opencode");
  const modelOption = (value: string, choices: Array<{ value: string; name: string }>) =>
    `{ id: "model", name: "Model", category: "model", type: "select", currentValue: ${JSON.stringify(
      value,
    )}, options: ${JSON.stringify(choices)} }`;
  const sessionConfigOptions =
    options.configOptions === "model"
      ? `[${modelOption("opencode/session-model", [{ value: "opencode/session-model", name: "Session model" }])}]`
      : options.configOptions === "partial-model"
        ? // The shape that actually loses models on a remote box: the agent
          // enumerates the catalog it has credentials for, and a custom
          // provider from `opencode.json` is simply not in it.
          `[${modelOption("opencode/big-pickle", [{ value: "opencode/big-pickle", name: "Big Pickle" }])}]`
        : options.configOptions === "empty-model"
          ? `[${modelOption("", [])}]`
          : undefined;
  const catalog = options.omnirouter
    ? "opencode/big-pickle\\nopencode/cat-jam-free\\ncorphub/claude-opus-5-5\\ncorphub/cc/claude-opus-5-5\\n"
    : "opencode/big-pickle\\nopencode/cat-jam-free\\n";
  const omniProvider = options.omnirouter
    ? `, { type: "document", path: "${dir}/opencode.json", info: { providers: { corphub: { name: "OmniRouter", models: { "claude-opus-5-5": { name: "Claude Opus 5.5" }, "cc/claude-opus-5-5": {} } } } } }`
    : "";
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
const out = (text) => process.stdout.write(text);

if (args[0] === "--version") { out("opencode v2.0.0-test\\n"); process.exit(0); }
if (args[0] === "debug" && args[1] === "paths") {
  out("home       ${dir}\\nconfig     ${dir}/.config/opencode\\nstate      ${dir}/.local/state/opencode\\n");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "config") {
  out(JSON.stringify([
    { type: "directory", path: "${dir}/.config/opencode" },
    { type: "document", path: "${dir}/opencode.json", info: { model: "opencode/big-pickle" } }${omniProvider}
  ]) + "\\n");
  process.exit(0);
}
if (args[0] === "models") { out("${catalog}"); process.exit(0); }
if (args[0] === "debug" && args[1] === "agents") {
  out(JSON.stringify([{ id: "build", name: "Build", mode: "primary" }]) + "\\n");
  process.exit(0);
}

// Anything else is ACP.
let buffer = "";
const send = (id, result) => out(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
        agentInfo: { name: "OpenCode", version: "2.0.0-test" },
      });
    } else if (message.method === "session/new") {
      send(message.id, { sessionId: "ses_test"${sessionConfigOptions ? `, configOptions: ${sessionConfigOptions}` : ""} });
    } else {
      send(message.id, {});
    }
  }
});
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return binary;
}

/** A home whose profile is the only place `opencode` can be found. */
function remoteShapedHome(binary: string): string {
  const home = mkdtempSync(join(tmpdir(), "opencode-remote-"));
  mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
  // `startup.test.ts` writes its own stand-in; this one is the install the
  // agent is meant to find.
  writeFileSync(join(home, ".opencode", "bin", "opencode"), `#!/bin/sh\nexec ${binary} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, ".bashrc"), 'export PATH="$HOME/.opencode/bin:$PATH"\n');
  return home;
}

/** Swaps environment for the duration of a callback. */
async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("the settings of the machine the agent runs on are read from that machine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
  const binary = standInOpenCode(dir);
  const home = remoteShapedHome(binary);

  // A `PATH` that never saw the profile, which is what the extension host gets
  // over SSH, and the bare name that only the profile can resolve.
  const info = await withEnv({ OPENCODE_BIN: binary, HOME: home, PATH: "/usr/bin:/bin" }, () =>
    readHostInfo({ binary, env: process.env, cwd: dir }),
  );

  assert.equal(info.version, "2.0.0-test");
  assert.equal(info.paths?.config, `${dir}/.config/opencode`);
  assert.deepEqual(info.models, ["opencode/big-pickle", "opencode/cat-jam-free"]);
  assert.deepEqual(info.agents?.map((agent) => agent.id), ["build"]);
  // The project config is part of the answer, so `cwd` has to be handed through.
  assert.deepEqual(info.sources?.map((source) => source.path), [
    `${dir}/.config/opencode`,
    `${dir}/opencode.json`,
  ]);
  assert.equal(info.error, undefined);
});

test("an install that answers nothing is reported rather than thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-silent-"));
  const binary = join(dir, "opencode");
  writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const info = await readHostInfo({ binary, env: process.env, cwd: dir });
  assert.match(info.error ?? "", /did not report any OpenCode settings/);
  assert.deepEqual(info.models, []);
});

test("a binary that does not exist leaves the chat with an empty answer, not a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-gone-"));
  const info = await readHostInfo({
    binary: join(dir, "never-installed"),
    env: process.env,
    cwd: dir,
    timeoutMs: 2_000,
  });
  assert.equal(info.binary, join(dir, "never-installed"));
  assert.deepEqual(info.sources, []);
});

/* ------------------------------------------------------------------ */
/* Providers named by the config                                       */
/* ------------------------------------------------------------------ */

test("providers are read under the names their config gives them", () => {
  const providers = parseProviders(
    JSON.stringify([
      {
        type: "document",
        path: "/srv/app/opencode.json",
        info: {
          providers: {
            corphub: {
              name: "OmniRouter",
              settings: { apiKey: "sk-live-secret" },
              models: { "claude-opus-5-5": { name: "Claude Opus 5.5" }, "cc/claude-opus-5-5": {} },
            },
          },
        },
      },
    ]),
  );

  assert.deepEqual(providers, [
    {
      id: "corphub",
      name: "OmniRouter",
      // A model with no name of its own is left out rather than guessed at; the
      // picker falls back to humanising the slug.
      models: { "claude-opus-5-5": "Claude Opus 5.5" },
    },
  ]);
  // Nothing but the name and the model names is ever copied out of the config,
  // so a key cannot reach the UI by this route.
  assert.equal(JSON.stringify(providers).includes("sk-live-secret"), false);
});

test("a provider redefined in a later source wins", () => {
  const providers = parseProviders(
    JSON.stringify([
      { type: "directory", path: "/home/dev/.config/opencode", info: { providers: { corphub: { name: "OmniRouter", models: { a: { name: "A" } } } } } },
      { type: "document", path: "/srv/app/opencode.json", info: { providers: { corphub: { name: "OmniRouter (staging)", models: { b: { name: "B" } } } } } },
    ]),
  );

  assert.deepEqual(providers, [{ id: "corphub", name: "OmniRouter (staging)", models: { b: "B" } }]);
});

test("a source that names no provider is not a provider", () => {
  assert.deepEqual(parseProviders(JSON.stringify([{ type: "directory", path: "/home/dev/.config/opencode" }])), []);
  assert.deepEqual(parseProviders(""), []);
});

/* ------------------------------------------------------------------ */
/* What the TUI remembers                                              */
/* ------------------------------------------------------------------ */

test("the TUI's recent and starred models are read as ids", () => {
  const remembered = parseTuiModels(
    JSON.stringify({
      recent: [{ providerID: "corphub", modelID: "claude-opus-5-5" }, { providerID: "opencode", modelID: "big-pickle" }],
      favorite: [{ providerID: "corphub", modelID: "claude-sonnet-5-5" }],
      variant: {},
    }),
  );

  assert.deepEqual(remembered.recent, ["corphub/claude-opus-5-5", "opencode/big-pickle"]);
  assert.deepEqual(remembered.favorite, ["corphub/claude-sonnet-5-5"]);
});

test("a model the TUI both starred and used recently is listed once", () => {
  const remembered = parseTuiModels(
    JSON.stringify({
      recent: [{ providerID: "corphub", modelID: "claude-opus-5-5" }],
      favorite: [{ providerID: "corphub", modelID: "claude-opus-5-5" }],
    }),
  );

  // Keeping it in both would draw the same row twice in one picker.
  assert.deepEqual(remembered.recent, []);
  assert.deepEqual(remembered.favorite, ["corphub/claude-opus-5-5"]);
});

test("a half-written or unfamiliar model.json remembers nothing", () => {
  // The TUI rewrites this file in place while it runs, so a torn read is normal
  // and must not throw.
  for (const contents of ["", "{", "null", "[]", JSON.stringify({ recent: "nope" }), JSON.stringify({ recent: [{ modelID: "orphan" }, { providerID: "corphub" }, "corphub/x"] })]) {
    const remembered = parseTuiModels(contents);
    assert.deepEqual(remembered.recent, [], contents);
    assert.deepEqual(remembered.favorite, [], contents);
  }
});

/* ------------------------------------------------------------------ */
/* The session falling back to the host's model list                    */
/* ------------------------------------------------------------------ */
test("a session that offers no model list falls back to the host's models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
  const binary = standInOpenCode(dir);
  const home = remoteShapedHome(binary);

  const chat = new ChatSession(() => dir);
  try {
    // Read inside `withEnv`: `remoteName` is read when the snapshot is built,
    // and that has to happen while the remote is still pretending to be there.
    const state = await withEnv(
      { OPENCODE_BIN: binary, HOME: home, PATH: "/usr/bin:/bin", OPENCODE_FAKE_REMOTE_NAME: "ssh-test-host" },
      async () => {
        await chat.start(undefined);
        // The settings read happens in the background so it never delays the
        // first prompt; the model list lands when it does.
        await waitFor(() => Boolean(chat.snapshot().host));
        return chat.snapshot();
      },
    );

    const model = state.configOptions?.find((option) => option.id === "model");
    assert.deepEqual(model?.options?.map((option) => option.value), ["opencode/big-pickle", "opencode/cat-jam-free"]);
    assert.equal(state.modelSource, "host");
    assert.equal(state.host?.remoteName, "ssh-test-host");
    assert.equal(state.host?.version, "2.0.0-test");
    assert.equal(state.host?.modelCount, 2);
    assert.deepEqual(state.host?.sources?.map((source) => source.path), [
      `${dir}/.config/opencode`,
      `${dir}/opencode.json`,
    ]);
  } finally {
    chat.dispose();
  }
});

test("a session's own models lead the list and keep the one it is on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
  const binary = standInOpenCode(dir, { configOptions: "model" });
  const home = remoteShapedHome(binary);

  const chat = new ChatSession(() => dir);
  try {
    await withEnv({ OPENCODE_BIN: binary, HOME: home, PATH: "/usr/bin:/bin" }, async () => {
      await chat.start(undefined);
      await waitFor(() => Boolean(chat.snapshot().host));
    });

    const state = chat.snapshot();
    assert.deepEqual(
      state.configOptions?.find((option) => option.id === "model")?.options?.map((option) => option.value),
      // The session's model first, then what the machine can reach that the
      // session did not mention.
      ["opencode/session-model", "opencode/big-pickle", "opencode/cat-jam-free"],
    );
    // The session said which model it is on, so the tick goes there rather than
    // on a remembered one.
    assert.equal(state.model?.id, "opencode/session-model");
    assert.equal(state.modelSource, "merged");
    // The host still reports what the machine has.
    assert.equal(state.host?.modelCount, 2);
  } finally {
    chat.dispose();
  }
});

test("a provider the session does not enumerate is still offered", async () => {
  // The reported bug: on a remote box the session offered a non-empty list,
  // which switched the host catalog off, so the OmniRouter section never
  // appeared even though the machine was configured with it.
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
  const binary = standInOpenCode(dir, { configOptions: "partial-model", omnirouter: true });
  const home = remoteShapedHome(binary);

  const chat = new ChatSession(() => dir);
  try {
    await withEnv({ OPENCODE_BIN: binary, HOME: home, PATH: "/usr/bin:/bin" }, async () => {
      await chat.start(undefined);
      await waitFor(() => Boolean(chat.snapshot().host));
    });

    const state = chat.snapshot();
    const values = state.configOptions?.find((option) => option.id === "model")?.options?.map((option) => option.value);
    // The session's one model leads; the custom provider it did not enumerate
    // follows, with nothing repeated.
    assert.deepEqual(values, [
      "opencode/big-pickle",
      "opencode/cat-jam-free",
      "corphub/claude-opus-5-5",
      "corphub/cc/claude-opus-5-5",
    ]);
    assert.equal(state.modelSource, "merged");
    assert.equal(state.model?.id, "opencode/big-pickle");
    // The provider heading the picker groups under is the name its config gives.
    assert.deepEqual(state.host?.providers, [
      { id: "corphub", name: "OmniRouter", models: { "claude-opus-5-5": "Claude Opus 5.5" } },
    ]);
  } finally {
    chat.dispose();
  }
});

test("a session whose model option is empty still falls back to the host's models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
  const binary = standInOpenCode(dir, { configOptions: "empty-model" });
  const home = remoteShapedHome(binary);

  const chat = new ChatSession(() => dir);
  try {
    await withEnv({ OPENCODE_BIN: binary, HOME: home, PATH: "/usr/bin:/bin" }, async () => {
      await chat.start(undefined);
      await waitFor(() => Boolean(chat.snapshot().host));
    });

    // An empty select is not a model list. Counting it as one would switch the
    // host fallback off and leave the picker reading *Agent did not offer any
    // models* on a machine that can list every model it can reach.
    const state = chat.snapshot();
    assert.deepEqual(
      state.configOptions?.find((option) => option.id === "model")?.options?.map((option) => option.value),
      ["opencode/big-pickle", "opencode/cat-jam-free"],
    );
    assert.equal(state.modelSource, "host");
  } finally {
    chat.dispose();
  }
});

/** Waits for a condition rather than a fixed delay. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the host settings to arrive");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}