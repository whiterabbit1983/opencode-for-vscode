import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The published extension version, read from the manifest next to the bundle.
 * Reported to the agent during `initialize`.
 */
export const EXTENSION_VERSION: string = readVersion();

function readVersion(): string {
  try {
    // dist/extension.js -> <extension root>/package.json
    const manifest = path.join(__dirname, "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}