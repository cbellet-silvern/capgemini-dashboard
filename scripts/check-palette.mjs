/**
 * Palette regression gate — `npm run check:palette`.
 *
 * The chart palette is not a matter of taste, and it is not something to eyeball.
 * Four properties are computable from the hex values alone, so this recomputes
 * them from the values actually defined in app/globals.css:
 *
 *   lightness band   — every slot inside the mode's OKLCH L band
 *   chroma floor     — no slot so desaturated it reads as gray
 *   CVD separation   — ΔE between adjacent slots under protanopia, deuteranopia
 *                      and tritanopia (the fixed slot ORDER is what buys this,
 *                      which is why the order must never be shuffled)
 *   contrast         — each mark against the surface it is drawn on
 *
 * A FAIL means the palette is wrong and must change. A WARN is not dismissable —
 * it obligates a mitigation:
 *
 *   contrast WARN → visible direct labels or the table view (both are shipped
 *                   under every chart, so this is satisfied by construction)
 *   CVD WARN      → secondary encoding: the 2px surface gaps between touching
 *                   marks, the legend, and the table view
 *
 * The values below are parsed out of app/globals.css rather than duplicated, so
 * editing a series colour there is what this check tests.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const css = readFileSync(path.join(root, "app", "globals.css"), "utf8");

/**
 * Reads --series-1..8 from a specific block of globals.css. `:root {` holds the
 * light values; the `[data-theme="dark"]` block holds the dark steps. The dark
 * steps are chosen for the dark surface, not derived from the light ones, so both
 * have to be checked independently.
 */
function seriesFrom(blockSelector) {
  const start = css.indexOf(blockSelector);
  if (start === -1) throw new Error(`Could not find "${blockSelector}" in app/globals.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open, close);
  const out = [];
  for (let i = 1; i <= 8; i++) {
    const m = block.match(new RegExp(`--series-${i}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`--series-${i} not found in ${blockSelector}`);
    out.push(m[1]);
  }
  return out;
}

function surfaceFrom(blockSelector) {
  const start = css.indexOf(blockSelector);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const m = css.slice(open, close).match(/--surface-1:\s*(#[0-9a-fA-F]{6})/);
  if (!m) throw new Error(`--surface-1 not found in ${blockSelector}`);
  return m[1];
}

const modes = [
  { name: "light", series: seriesFrom(":root {"), surface: surfaceFrom(":root {") },
  {
    name: "dark",
    series: seriesFrom(':root[data-theme="dark"]'),
    surface: surfaceFrom(':root[data-theme="dark"]'),
  },
];

let failed = false;

for (const mode of modes) {
  console.log(`\n──────── ${mode.name} (surface ${mode.surface}) ────────`);
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [
        path.join(here, "validate_palette.js"),
        mode.series.join(","),
        "--mode",
        mode.name,
        "--surface",
        mode.surface,
      ],
      { encoding: "utf8" },
    );
  } catch (err) {
    console.error(err.stdout ?? String(err));
    failed = true;
    continue;
  }
  console.log(output.trim());
  if (/\[FAIL\]/.test(output)) failed = true;
}

console.log("");
if (failed) {
  console.error("Palette check FAILED — fix app/globals.css before shipping.");
  process.exit(1);
}
console.log(
  "Palette check passed. WARNs are mitigated by the table view shipped under every\n" +
    "chart, selective direct labels, and the 2px surface gap between touching marks.",
);
