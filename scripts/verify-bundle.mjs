// Loads the built extension bundle with a stub `vscode` module to prove that
// `activate()` runs end to end without a real editor present.
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "extension.js");
const require = createRequire(import.meta.url);

/**
 * Commands VS Code registers itself. A contributed command may not take one of
 * these IDs — activation would fail with "command already exists".
 */
const BUILTIN_COMMANDS = new Set([
  "opencode.chat.focus", // <viewId>.focus for the opencode.chat view
  "workbench.action.quickOpen",
  "vscode.open",
]);

const SETTINGS = {
  binaryPath: "opencode",
  extraArgs: [],
  env: {},
  permissions: "ask",
  diffView: "inline",
  showThoughts: false,
  showPlan: true,
  fontSize: 0,
  maxToolOutputLines: 40,
  confirmDestructiveCommands: true,
  reuseLastSession: true,
};

function makeVscodeStub() {
  class Disposable {
  constructor(fn) {
    this.dispose = fn ?? (() => {});
  }
}

const noop = () => new Disposable();

  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
      };
    }
    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {}
  }

  const commands = new Map();

  return {
    registered: commands,
    Disposable,
    EventEmitter,
    ViewColumn: { Active: -1, Beside: -2 },
    version: "1.95.0",
    // The file picker's index reads the workspace through this surface, so the
    // stub has to offer it for `activate()` to run.
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
      file: (path) => ({ fsPath: path, path, scheme: "file", query: "", toString: () => `file://${path}` }),
      parse: (value) => ({ toString: () => value, scheme: (value.match(/^(\w+):/) ?? [])[1] ?? "file" }),
      joinPath: (base, ...parts) => ({
        fsPath: join(base.fsPath, ...parts),
        path: join(base.path ?? base.fsPath, ...parts),
        scheme: "file",
        toString: () => "uri",
      }),
      from: (parts) => ({ fsPath: parts.path, path: parts.path, scheme: parts.scheme, query: parts.query }),
    },
    env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
    commands: {
      registerCommand(id, handler) {
        if (commands.has(id)) {
          throw new Error(`command '${id}' is registered twice`);
        }
        if (BUILTIN_COMMANDS.has(id)) {
          throw new Error(`command '${id}' collides with a built-in VS Code command`);
        }
        commands.set(id, handler);
        return noop();
      },
      executeCommand: async (id, ...args) => {
        const handler = commands.get(id);
        if (!handler) {
          throw new Error(`command not registered: ${id}`);
        }
        return handler(...args);
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
      createWebviewPanel: () => ({
        webview: {
          onDidReceiveMessage() {},
          postMessage: async () => {},
          asWebviewUri: (uri) => uri,
          cspSource: "vscode-webview:",
        },
        onDidDispose() {},
        reveal() {},
        dispose() {},
      }),
      registerWebviewViewProvider: () => noop(),
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showQuickPick: async () => undefined,
      activeTextEditor: undefined,
      onDidChangeActiveColorTheme: () => noop(),
    },
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      fs: {
        readDirectory: async () => [],
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
      },
      asRelativePath: (uri) => uri.fsPath,
      onDidChangeConfiguration: () => noop(),
      onDidChangeWorkspaceFolders: () => noop(),
      onDidCreateFiles: () => noop(),
      onDidDeleteFiles: () => noop(),
      onDidRenameFiles: () => noop(),
      registerTextDocumentContentProvider: () => noop(),
      openTextDocument: async () => ({}),
      getConfiguration: () => ({ get: (key) => SETTINGS[key], has: () => false, inspect: () => undefined }),
    },
  };
}

function makeExtensionContext() {
  const globalStore = new Map();
  return {
    subscriptions: [],
    extensionUri: { fsPath: root, path: root, scheme: "file", toString: () => "file://ext" },
    globalState: {
      get: (key) => globalStore.get(key),
      update: async (key, value) => void globalStore.set(key, value),
    },
    workspaceState: { get: () => undefined, update: async () => {} },
  };
}

const stub = makeVscodeStub();
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  return request === "vscode" ? stub : originalLoad.call(this, request, parent, isMain);
};

const extension = require(entry);
const context = makeExtensionContext();

extension.activate(context);
console.log(`activate() registered ${context.subscriptions.length} disposables`);

const expected = [
  "opencode.chat.open",
  "opencode.chat.openInEditor",
  "opencode.chat.newSession",
  "opencode.chat.stop",
  "opencode.chat.pickSession",
  "opencode.chat.explainSelection",
  "opencode.chat.askAboutSelection",
  "opencode.chat.askAboutFile",
  "opencode.chat.signIn",
  "opencode.chat.restart",
  "opencode.chat.clearHistory",
  "opencode.chat.copyLastResponse",
];

const missing = expected.filter((id) => !stub.registered.has(id));
if (missing.length) {
  console.error("Missing commands:", missing.join(", "));
  process.exit(1);
}
console.log(`activate() registered ${stub.registered.size} commands, all ${expected.length} present`);

// The manifest and the code must agree, or a palette entry silently does nothing.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const contributed = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command));
const registered = new Set(stub.registered.keys());

const undeclared = [...registered].filter((id) => !contributed.has(id));
const orphaned = [...contributed].filter((id) => !registered.has(id));
if (undeclared.length || orphaned.length) {
  if (undeclared.length) {
    console.error("Registered but not in package.json:", undeclared.join(", "));
  }
  if (orphaned.length) {
    console.error("In package.json but never registered:", orphaned.join(", "));
  }
  process.exit(1);
}
console.log(`manifest and code agree on all ${contributed.size} contributed commands`);

extension.deactivate();
for (const disposable of context.subscriptions) {
  disposable.dispose?.();
}

console.log("OK: the extension bundle activates and deactivates against a stubbed vscode API");