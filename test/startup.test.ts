/**
 * Startup tests for `OpenCodeAgent`.
 *
 * These cover the ways a *remote* host makes the agent fail to start — the VS
 * Code server's non-interactive `PATH`, an executable that dies instead of
 * speaking ACP — and they do it without needing a real agent: the failures all
 * happen before a single line of the protocol is exchanged, so a shell script
 * stands in for `opencode` perfectly well.
 *
 * Bundled with `vscode` aliased to the stub, like the smoke test.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OpenCodeAgent } from "../src/agent/opencode-agent.js";

/** The agent handshake is given 30s; these must not come close. */
const FAST = 5_000;

/** A host that does not get to keep its environment between tests. */
function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/** A host that answers nothing, the way a bad install does. */
function idleAgentHost() {
  return {
    sessionUpdate: () => undefined,
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
    createElicitation: async () => ({ action: "decline" as const }),
    completeElicitation: () => undefined,
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => undefined,
  };
}

/** Runs `ensureStarted` and reports what it said, or what it did instead. */
async function startOutcome(): Promise<{ ok: boolean; message: string }> {
  const agent = new OpenCodeAgent(idleAgentHost());
  const timer = setTimeout(() => {}, FAST);
  try {
    await agent.ensureStarted();
    return { ok: true, message: "started" };
  } catch (error) {
    return { ok: false, message: `${(error as Error).name}: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
    agent.dispose();
  }
}

test("a binary that does not exist fails at once, naming the host", async () => {
  // The bug this guards: `spawn` reports a missing executable asynchronously, and
  // it used to be logged and forgotten. The handshake then waited on a process
  // that would never answer, and the teardown waited for an `exit` a child that
  // never spawned cannot emit — so the panel sat on "starting" forever.
  const restore = withEnv({
    OPENCODE_BIN: join(tmpdir(), "opencode-that-was-never-installed"),
    OPENCODE_FAKE_REMOTE_NAME: "ssh-test-host",
  });
  const started = Date.now();
  const outcome = await startOutcome();
  restore();

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /AgentError/);
  assert.match(outcome.message, /cannot be run|and no login shell there has it either/);
  assert.ok(Date.now() - started < FAST, `took ${Date.now() - started}ms, which is the hang this test exists to catch`);
});

test("an executable that is not runnable is reported as such", async () => {
  // A configured path is the user's decision, so it is used exactly as written
  // and never quietly replaced by some other `opencode` found elsewhere.
  const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"));
  const binary = join(dir, "opencode");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  // No executable bit: the same failure a botched `chmod` on a remote host gives.
  const restore = withEnv({ OPENCODE_BIN: binary });
  const outcome = await startOutcome();
  restore();

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /cannot be run/);
  assert.doesNotMatch(outcome.message, /no login shell there has it either/);
});

test("an agent that dies while introducing itself says why", async () => {
  // Its last words on stderr are the whole difference between a usable error and
  // a bare "did not answer" after the full handshake timeout.
  const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"));
  const binary = join(dir, "opencode");
  writeFileSync(binary, "#!/bin/sh\necho 'unsupported platform' >&2\nexit 3\n", { mode: 0o755 });

  const restore = withEnv({ OPENCODE_BIN: binary });
  const started = Date.now();
  const outcome = await startOutcome();
  restore();

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /exited with code 3/);
  assert.match(outcome.message, /unsupported platform/);
  assert.ok(Date.now() - started < FAST, `took ${Date.now() - started}ms, which is the hang this test exists to catch`);
});

test("a bare name the PATH cannot see is resolved through a login shell", async () => {
  // The Remote-SSH case: the extension host is started by a non-interactive SSH
  // command, so its `PATH` never went through the user's profile — which is
  // where the installer puts `~/.opencode/bin`. A home directory whose rc file
  // adds exactly that reproduces it without needing a second machine.
  if (!existsSync("/bin/bash")) {
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
  const bin = join(home, ".opencode", "bin");
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, "opencode");
  // It answers nothing, which is enough: what is being asserted is *which* file
  // was run, and a dead agent names itself in the error.
  writeFileSync(binary, "#!/bin/sh\necho 'not really an agent' >&2\nexit 1\n", { mode: 0o755 });
  // The standard `~/.bashrc` returns early for a non-interactive shell, so this
  // is also the case the login probe asks with `-i` to get through.
  writeFileSync(join(home, ".bashrc"), `export PATH="$HOME/.opencode/bin:$PATH"\n`);

  const restore = withEnv({
    OPENCODE_BIN: "opencode",
    HOME: home,
    // Nothing this shell can see either, so only the profile can answer.
    PATH: "/usr/bin:/bin",
  });
  const outcome = await startOutcome();
  restore();

  assert.equal(outcome.ok, false);
  assert.match(
    outcome.message,
    new RegExp(escapeForRegExp(binary)),
    "expected the agent to have been resolved to the profile's PATH",
  );
});

test("the config a login shell exports is loaded with the agent", async () => {
  // The same Remote-SSH box as above, failing in a quieter way: `opencode` is
  // on the extension host's `PATH`, so nothing was wrong with finding it, and
  // the chat came up fine — it just had no OmniRouter in the picker. The
  // provider lives in a config file that `OPENCODE_CONFIG` names, the profile
  // exports that variable, and the extension host started by a non-interactive
  // SSH command never read the profile. So the agent has to be started with
  // what the login shell says, even though finding the binary never asked.
  if (!existsSync("/bin/bash")) {
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "opencode-config-"));
  const bin = join(home, ".opencode", "bin");
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, "opencode");
  // It says which config file it was started with, on the way out.
  writeFileSync(binary, '#!/bin/sh\necho "config=$OPENCODE_CONFIG" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(home, ".bashrc"), 'export OPENCODE_CONFIG="/srv/api/omnirouter.json"\n');

  const restore = withEnv({
    OPENCODE_BIN: "opencode",
    SHELL: "/bin/bash",
    HOME: home,
    // `opencode` is reachable without the profile, which is what makes this the
    // case that used to be missed.
    PATH: `/usr/bin:/bin:${bin}`,
    // The extension host itself knows nothing about the config file.
    OPENCODE_CONFIG: undefined,
  });
  const outcome = await startOutcome();
  restore();

  assert.equal(outcome.ok, false);
  assert.match(
    outcome.message,
    /config=\/srv\/api\/omnirouter\.json/,
    "expected the agent to have been started with the config file the profile exports",
  );
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}