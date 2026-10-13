/**
 * Minimal line diff used for the inline change previews in the chat.
 *
 * A full LCS is fine for the file sizes an agent typically touches; anything
 * larger falls back to a block replace so the UI never stalls.
 */

export type DiffRow =
  | { type: "add"; oldLine: null; newLine: number; text: string }
  | { type: "del"; oldLine: number; newLine: null; text: string }
  | { type: "same"; oldLine: number; newLine: number; text: string }
  | { type: "hunk"; oldStart: number; oldCount: number; newStart: number; newCount: number };

export interface DiffResult {
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

type Op = { type: "add" | "del" | "same"; text: string };

/** Above this product of line counts we skip the LCS table. */
const LCS_BUDGET = 1_500_000;

export function diffLines(oldText: string, newText: string, context = 3): DiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const ops = computeOps(oldLines, newLines);
  const additions = ops.filter((op) => op.type === "add").length;
  const deletions = ops.filter((op) => op.type === "del").length;

  return { rows: collapse(ops, context), additions, deletions };
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

function computeOps(oldLines: string[], newLines: string[]): Op[] {
  if (oldLines.length * newLines.length > LCS_BUDGET) {
    return blockOps(oldLines, newLines);
  }

  const rows = oldLines.length;
  const cols = newLines.length;
  const table: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] =
        oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "same", text: oldLines[i++] });
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "del", text: oldLines[i++] });
    } else {
      ops.push({ type: "add", text: newLines[j++] });
    }
  }
  while (i < rows) {
    ops.push({ type: "del", text: oldLines[i++] });
  }
  while (j < cols) {
    ops.push({ type: "add", text: newLines[j++] });
  }
  return ops;
}

/** Fallback for very large inputs: trim the common edges, replace the middle. */
function blockOps(oldLines: string[], newLines: string[]): Op[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: "same", text: oldLines[i] });
  }
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    ops.push({ type: "del", text: oldLines[i] });
  }
  for (let j = prefix; j < newLines.length - suffix; j++) {
    ops.push({ type: "add", text: newLines[j] });
  }
  for (let k = oldLines.length - suffix; k < oldLines.length; k++) {
    ops.push({ type: "same", text: oldLines[k] });
  }
  return ops;
}

/** Keeps `context` unchanged lines around each change and labels the gaps. */
function collapse(ops: Op[], context: number): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].type === "same") {
      continue;
    }
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let target = from; target <= to; target++) {
      keep[target] = true;
    }
  }

  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let pendingGap: { oldStart: number; oldCount: number; newStart: number; newCount: number } | null = null;

  const closeGap = () => {
    if (pendingGap) {
      rows.push({ type: "hunk", ...pendingGap });
      pendingGap = null;
    }
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!keep[index]) {
      if (op.type === "del") {
        oldLine++;
      } else if (op.type === "add") {
        newLine++;
      }
      pendingGap = pendingGap ?? { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0 };
      if (op.type === "del") {
        pendingGap.oldCount++;
      } else if (op.type === "add") {
        pendingGap.newCount++;
      }
      continue;
    }

    closeGap();

    if (op.type === "same") {
      rows.push({ type: "same", oldLine, newLine, text: op.text });
      oldLine++;
      newLine++;
    } else if (op.type === "del") {
      rows.push({ type: "del", oldLine, newLine: null, text: op.text });
      oldLine++;
    } else {
      rows.push({ type: "add", oldLine: null, newLine, text: op.text });
      newLine++;
    }
  }

  closeGap();
  return rows;
}