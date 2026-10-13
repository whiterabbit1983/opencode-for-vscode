// Copies static webview assets into media/ so they can be shipped with the
// extension: the codicon font that VS Code uses for its own UI icons.
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mediaDir = join(root, "media");
const codicons = join(root, "node_modules", "@vscode", "codicons", "dist");

await mkdir(mediaDir, { recursive: true });

if (!existsSync(codicons)) {
  console.error(`[opencode] ${codicons} is missing — run \`npm install\` first.`);
  process.exit(1);
}

for (const file of ["codicon.css", "codicon.ttf"]) {
  await copyFile(join(codicons, file), join(mediaDir, file));
}

console.log("[opencode] copied codicon assets");