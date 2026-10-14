/**
 * Ranking for the composer's `@` file picker.
 *
 * Kept free of `vscode` so it can be exercised without an editor — the picker
 * feels wrong when the wrong file is on top, and that ordering is pure logic.
 */

/** Rows the picker shows at a time. */
export const MAX_RESULTS = 40;

/**
 * Picks the files a query most likely means.
 *
 * Ordering is by how directly the query matched, not by where the file sits:
 * typing `rate` should surface `rate-limit.ts` before `src/server/rate.ts`,
 * because that is the one being looked for. Only `limit` files are ranked, so a
 * query that matches everything cannot turn into a full sort of the workspace.
 */
export function rankFiles(files: readonly string[], query: string, limit = MAX_RESULTS): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return files.slice(0, limit);
  }

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const slash = lower.lastIndexOf("/");
    const base = slash === -1 ? lower : lower.slice(slash + 1);

    let score = -1;
    if (base === needle) {
      score = 0;
    } else if (base.startsWith(needle)) {
      score = 1;
    } else if (lower.startsWith(needle)) {
      score = 2;
    } else if (base.includes(needle)) {
      score = 3;
    } else if (lower.includes(needle)) {
      score = 4;
    }

    if (score >= 0) {
      scored.push({ path, score });
    }
  }

  // Ties break towards the shallower path: when ten files match equally well,
  // the one nearest the root is the one being asked for.
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      depth(a.path) - depth(b.path) ||
      a.path.localeCompare(b.path),
  );
  return scored.slice(0, limit).map((entry) => entry.path);
}

function depth(path: string): number {
  let count = 0;
  for (const part of path.split("/")) {
    if (part) {
      count++;
    }
  }
  return count;
}