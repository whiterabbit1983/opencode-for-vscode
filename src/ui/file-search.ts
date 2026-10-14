import * as vscode from "vscode";

import { MAX_RESULTS, rankFiles } from "./file-rank.js";

/**
 * Directories full of files nobody means to attach.
 *
 * Skipping them is not just speed: `node_modules/@types/...` matches almost any
 * query and would fill every picker with noise.
 */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  "Pods",
]);

/** Past this the walk stops: a monorepo can have millions of files. */
const MAX_FILES = 20_000;

/** How deep the walk goes, so a symlinked tree cannot spin forever. */
const MAX_DEPTH = 16;

/**
 * Files worth offering in the composer, in workspace-relative form.
 *
 * The list is walked once and then reused, because the picker is opened by
 * typing and a directory read per keystroke would be felt. It is dropped again
 * when files appear or disappear, so a file the agent just wrote can be
 * attached without restarting the window.
 */
export class FileIndex implements vscode.Disposable {
  private files?: string[];
  private loading?: Promise<string[]>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
    );
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** The best {@link MAX_RESULTS} matches for `query`, best first. */
  async search(query: string, limit = MAX_RESULTS): Promise<string[]> {
    return rankFiles(await this.load(), query, limit);
  }

  private invalidate(): void {
    this.files = undefined;
    this.loading = undefined;
  }

  /**
   * Rebuilds after the edits settle.
   *
   * A single file write can arrive as several events, and an agent writing a
   * file would otherwise cost one full workspace walk per event.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.invalidate();
    }, 2000);
    this.refreshTimer.unref?.();
  }

  private load(): Promise<string[]> {
    if (this.files) {
      return Promise.resolve(this.files);
    }
    if (!this.loading) {
      this.loading = this.collect().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async collect(): Promise<string[]> {
    const found: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.walk(folder.uri, found, 0);
      if (found.length >= MAX_FILES) {
        break;
      }
    }
    found.sort((a, b) => a.localeCompare(b));
    this.files = found.slice(0, MAX_FILES);
    return this.files;
  }

  private async walk(uri: vscode.Uri, found: string[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) {
      return;
    }

    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      // A directory we cannot read holds nothing we could offer anyway.
      return;
    }

    for (const [name, type] of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        if (SKIPPED.has(name)) {
          continue;
        }
        await this.walk(child, found, depth + 1);
        continue;
      }
      if (type === vscode.FileType.File || type === vscode.FileType.SymbolicLink) {
        found.push(vscode.workspace.asRelativePath(child, false));
      }
    }
  }
}