// Debug helper: dump every column's (date, x_center) and every raw text item
// in Klug's row, so we can see which column each code lands in.
//
// Run: bun scripts/debug-klug.ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parsePages } from "../src/parser.ts";

const PDF = "example_data/5_Mars2026_26.03_30.04.2026.pdf";
const bytes = new Uint8Array(await readFile(resolve(PDF)));

// Load raw page items the same way the parser does, then run parse() for dates.
const doc = await getDocument({
  data: bytes,
  disableFontFace: true,
  useSystemFonts: false,
  verbosity: 0,
}).promise;

const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const { items } = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  pages.push({
    page: p,
    width: vp.width,
    height: vp.height,
    items: items
      .filter((it: any) => typeof it?.str === "string")
      .map((it: any) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: it.height,
      })),
  });
}

const r = await parsePages(pages);
const klug = r.people.find((p) => p.name === "Klug, J")!;

// Find Klug's row band on each page; show every text item in that band
// with its x and the parser's assigned date.
console.log("Klug parsed days (date → codes):");
for (const d of klug.days) {
  if (d.codes.length) console.log(`  ${d.date}  ${d.codes.join(",")}`);
}

console.log("\nKlug row_band:", klug.row_band);

// Build day_x_centers list from the parsed result by re-running findDayRow
// indirectly: re-derive via the items in the day-row band of page 1.
const page = pages[0]!;
console.log(`\nPage 1 items inside Klug's row band (y_top=${klug.row_band.y_top}, y_bottom=${klug.row_band.y_bottom}):`);
const inRow = page.items
  .filter((it) => it.y >= klug.row_band.y_bottom - 4 && it.y <= klug.row_band.y_top + 4)
  .sort((a, b) => a.x - b.x);
for (const it of inRow) {
  const xc = it.x + it.width / 2;
  console.log(`  x=${it.x.toFixed(1).padStart(7)} xc=${xc.toFixed(1).padStart(7)} w=${it.width.toFixed(1).padStart(6)} y=${it.y.toFixed(1)}  ${JSON.stringify(it.str)}`);
}

// Day-row tokens for page 1 (and page 2 if multi-page).
for (const p of pages) {
  const buckets = new Map<number, typeof p.items>();
  for (const it of p.items) {
    const t = it.str.trim();
    if (!/^\d{1,2}$/.test(t)) continue;
    const n = +t;
    if (n < 1 || n > 31) continue;
    // Bucket by y rounded to nearest 2
    const key = Math.round(it.y / 2) * 2;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(it);
  }
  // Find row with most day-likes.
  const top = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!top) continue;
  const [yKey, dayItems] = top;
  const sorted = dayItems.slice().sort((a, b) => a.x - b.x);
  console.log(`\nPage ${p.page} day-row (y≈${yKey}, ${sorted.length} tokens):`);
  for (const it of sorted) {
    const xc = it.x + it.width / 2;
    console.log(`  day=${it.str.padStart(2)}  x=${it.x.toFixed(1).padStart(7)} xc=${xc.toFixed(1).padStart(7)} w=${it.width.toFixed(1)}`);
  }
}

await doc.cleanup();
