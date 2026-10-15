#!/usr/bin/env node
// Renders dev/preview.html in headless Firefox and writes a screenshot for
// each scenario. Used to review the chat UI without launching VS Code.
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dev", "shots");
const profileDir = join("/tmp", "opencode-preview-profile");

const scenarios = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "transcript",
      "transcript&expand=1",
      "mixed",
      "streaming&dots=1",
      "finished&dots=0",
      "permission",
      "question",
      "welcome&then=transcript",
      "starting&then=welcome",
      "error",
      "remote-host&menu=more",
      "remote-host-no-models&menu=model",
      "omnirouter&menu=model",
      "omnirouter-missing&menu=more",
    ];

const browsers = ["firefox", "google-chrome", "chromium", "chromium-browser"];
let browser = browsers.find((name) => {
  try {
    execFile("which", [name]);
    return true;
  } catch {
    return false;
  }
});

if (!browser) {
  console.error("[opencode] no headless browser found (looked for firefox, chromium, chrome)");
  process.exit(1);
}

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await mkdir(outDir, { recursive: true });

for (const scenario of scenarios) {
  const [name, extra = ""] = scenario.split("&");
  const file = join(outDir, `${name}${extra ? `-${extra}` : ""}.png`);
  const url = `file://${join(root, "dev", "preview.html")}?scenario=${name}${extra ? `&${extra}` : ""}`;
  const args =
    browser === "firefox"
      ? ["--headless", "--profile", profileDir, "--window-size=480,920", "--screenshot", file, url]
      : ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=480,920", `--screenshot=${file}`, url];

  await run(browser, args).catch((error) => {
    console.error(`[opencode] ${name} failed:`, error.message);
  });
  console.log(`[opencode] ${file}`);
}