// Generates resources/icon.png (the marketplace icon) from the same shapes as
// resources/activity-bar.svg, so the two never drift apart.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const size = 256;

const BACKGROUND = "#101014";
const INK = "#f2f2f5";

/** Rounded-rectangle coverage test in normalised coordinates. */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// The mark: a single rounded rectangle, matching the SVG.
const BLOCKS = [{ l: 0.142, t: 0.208, r: 0.858, b: 0.792, radius: 0.092 }];

function coverage(x, y) {
  let hits = 0;
  for (const rect of BLOCKS) {
    if (inRoundedRect(x, y, rect.l, rect.t, rect.r, rect.b, rect.radius)) {
      hits++;
    }
  }
  return Math.min(hits, 1);
}

const png = new PNG({ width: size, height: size });
const [br, bg, bb] = hexToRgb(BACKGROUND);
const [ir, ig, ib] = hexToRgb(INK);
const radius = 0.22;

for (let py = 0; py < size; py++) {
  for (let px = 0; px < size; px++) {
    const index = (size * py + px) << 2;
    const x = px / size;
    const y = py / size;

    const alpha = inRoundedRect(x, y, 0, 0, 1, 1, radius) ? 255 : 0;
    const ink = coverage(x, y) > 0 ? 1 : 0;

    png.data[index] = Math.round(br * (1 - ink) + ir * ink);
    png.data[index + 1] = Math.round(bg * (1 - ink) + ig * ink);
    png.data[index + 2] = Math.round(bb * (1 - ink) + ib * ink);
    png.data[index + 3] = alpha;
  }
}

await mkdir(join(root, "resources"), { recursive: true });
const out = join(root, "resources", "icon.png");
await writeFile(out, PNG.sync.write(png));

console.log(`[opencode] wrote ${out}`);

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}