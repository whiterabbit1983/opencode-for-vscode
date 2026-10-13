import * as vscode from "vscode";

import { log } from "../logger.js";

const ORIGINAL_SCHEME = "opencode-original";
const MODIFIED_SCHEME = "opencode-modified";

/**
 * Backs the native diff editor with in-memory documents so the agent's preview
 * can be shown without touching anything on disk.
 */
export class DiffPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  static originalUri(path: string, id: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path, query: id });
  }

  static modifiedUri(path: string, id: string): vscode.Uri {
    return vscode.Uri.from({ scheme: MODIFIED_SCHEME, path, query: id });
  }

  private key(uri: vscode.Uri): string {
    return `${uri.scheme}:${uri.path}?${uri.query}`;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(this.key(uri)) ?? "";
  }

  /**
   * Opens the native diff editor for a change, reusing the tab that is already
   * showing the same pair.
   */
  open(oldText: string | null, newText: string, path: string, id: string): void {
    const original = DiffPreviewProvider.originalUri(path, id);
    const modified = DiffPreviewProvider.modifiedUri(path, id);
    this.contents.set(this.key(original), oldText ?? "");
    this.contents.set(this.key(modified), newText);
    this.emitter.fire(original);
    this.emitter.fire(modified);

    try {
      vscode.commands.executeCommand(
        "vscode.diff",
        original,
        modified,
        `${vscode.workspace.asRelativePath(original)} (agent change)`,
        { preview: true, preserveFocus: true },
      );
    } catch (error) {
      log.warn("could not open diff editor: %s", String(error));
    }
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/** Registers the two schemes the diff preview writes to. */
export function registerDiffProviders(context: vscode.ExtensionContext): DiffPreviewProvider {
  const provider = new DiffPreviewProvider();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(MODIFIED_SCHEME, provider),
  );
  return provider;
}