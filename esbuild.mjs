// Two bundles are produced:
//
//   dist/extension.js  – the extension host entry point (CommonJS, runs in Node)
//   dist/webview/main.js – the webview UI (IIFE, runs in the browser sandbox)
//
// The ACP SDK is ESM-only, so it is bundled into the CommonJS output together
// with its `zod` peer dependency instead of being left as a runtime `require`.
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  target: "es2022",
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
};

/** @type {import("esbuild").BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview/main.js",
    platform: "browser",
    format: "iife",
  },
];

// Test bundles are only built when asked for, so a production package does not
// ship them.
if (!process.argv.includes("--production")) {
  builds.push(
    {
      ...common,
      entryPoints: ["test/smoke.ts"],
      outfile: "dist/test/smoke.js",
      platform: "node",
      format: "cjs",
      // The agent layer reaches `vscode` through config/logger, so the smoke
      // bundle swaps in a stub instead of the real editor API.
      alias: { vscode: "./test/vscode-stub.ts" },
    },
    {
      ...common,
      entryPoints: ["test/unit.test.ts"],
      outfile: "dist/test/unit.test.js",
      platform: "node",
      format: "cjs",
      external: ["vscode"],
    },
    {
      ...common,
      entryPoints: ["test/startup.test.ts"],
      outfile: "dist/test/startup.test.js",
      platform: "node",
      format: "cjs",
      // Drives the real `OpenCodeAgent`, so it needs the same stub the smoke
      // test uses rather than a missing `vscode` at require time.
      alias: { vscode: "./test/vscode-stub.ts" },
    },
    {
      ...common,
      entryPoints: ["test/host-info.test.ts"],
      outfile: "dist/test/host-info.test.js",
      platform: "node",
      format: "cjs",
      // Drives `ChatSession` and the settings reader, so it needs the stub too.
      alias: { vscode: "./test/vscode-stub.ts" },
    },
  );
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("[opencode] watching…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}