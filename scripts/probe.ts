// Parser-feasibility probe (per docs/parser-spec.md §"Implementation plan" step 1).
// Loads both example PDFs, dumps page-1 text items with (x, y) so a human can
// eyeball whether day numbers, names, and codes land at sensible positions.
//
// Run: bun scripts/probe.ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PDFS = [
  "example_data/1_mai_21.04.2026.pdf",
  "example_data/5_Mars2026_26.03_30.04.2026.pdf",
];

type Item = { x: number; y: number; w: number; h: number; str: string };

for (const rel of PDFS) {
  const bytes = await readFile(resolve(rel));
  const t0 = performance.now();
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const { items } = await page.getTextContent();
  const dt = (performance.now() - t0).toFixed(0);

  const rows: Item[] = items
    .filter((it: any) => typeof it?.str === "string")
    .map((it: any) => ({ x: it.transform[4], y: it.transform[5], w: it.width, h: it.height, str: it.str }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  // Quick sanity counters mirroring spec Steps 1 + 4.
  const dayLike = rows.filter((r) => /^\d{1,2}$/.test(r.str.trim()) && +r.str >= 1 && +r.str <= 31).length;
  const nameLike = rows.filter((r) => /^[A-ZÉÈÀÂÊÎÔÛÄËÏÖÜÇ][\p{L}\-' ]+,\s?[A-Z]\.?$/u.test(r.str.trim())).length;

  console.log(`\n=== ${rel}  pages=${doc.numPages}  page1.items=${rows.length}  load=${dt}ms ===`);
  console.log(`    day-like tokens (1..31, integer): ${dayLike}    name-like tokens ("Lastname, F"): ${nameLike}`);
  console.log(`    --- top→bottom, left→right ---`);
  for (const r of rows) {
    const s = JSON.stringify(r.str);
    console.log(`    y=${r.y.toFixed(1).padStart(7)}  x=${r.x.toFixed(1).padStart(7)}  w=${r.w.toFixed(1).padStart(5)}  ${s}`);
  }
  await doc.cleanup();
}
