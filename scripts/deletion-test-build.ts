// Generates two .ics files for the deletion test.
// Run: bun scripts/deletion-test-build.ts <date-to-delete>
// Example: bun scripts/deletion-test-build.ts 2026-04-13

import { readFile, writeFile } from "node:fs/promises";
import { parse } from "../src/parser";
import { generate } from "../src/ics";
import { codes } from "../src/codes";
import { createHash } from "node:crypto";

const PDF_PATH = "example_data/5_Mars2026_26.03_30.04.2026.pdf";
const PERSON_NAME = "Klug, J";
const DEPARTMENT_SLUG = "anesthesia-test";
const BASE_URL = "https://example.com";   // placeholder; not exercised in this test
const TARGET_DATE = process.argv[2];      // YYYY-MM-DD

if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
  console.error("Usage: bun scripts/deletion-test-build.ts YYYY-MM-DD");
  process.exit(1);
}

const sha256 = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

const normalize = (s: string) =>
  s.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");

const pdfBytes = new Uint8Array(await readFile(PDF_PATH));
const pdfHash = sha256(pdfBytes);
const personHash = sha256(`${DEPARTMENT_SLUG}|${normalize(PERSON_NAME)}`).slice(0, 16);

const result = await parse(pdfBytes);
const person = result.people.find(p => p.name === PERSON_NAME);
if (!person) throw new Error(`Person not found: ${PERSON_NAME}`);

const sourceMeta = {
  file_name: PDF_PATH.split("/").pop()!,
  uploaded_at: new Date("2026-05-03T12:00:00Z"),  // fixed for v1
  pdf_sha256: pdfHash,
  base_url: BASE_URL,
};

// v1 — full schedule
const v1 = generate({ person, person_hash: personHash, codes, source: sourceMeta, emit_tentative_for_prefixes: true });
await writeFile("/tmp/klug-v1.ics", v1);

// v2 — same schedule, target date emptied
const personV2 = {
  ...person,
  days: person.days.map(d => d.date === TARGET_DATE ? { ...d, codes: [] } : d),
};
const sourceMetaV2 = { ...sourceMeta, uploaded_at: new Date("2026-05-04T12:00:00Z") };
const v2 = generate({ person: personV2, person_hash: personHash, codes, source: sourceMetaV2, emit_tentative_for_prefixes: true });
await writeFile("/tmp/klug-v2.ics", v2);

const v1Events = (v1.match(/BEGIN:VEVENT/g) || []).length;
const v2Events = (v2.match(/BEGIN:VEVENT/g) || []).length;

console.log(`v1: /tmp/klug-v1.ics  (${v1Events} events)`);
console.log(`v2: /tmp/klug-v2.ics  (${v2Events} events)`);
console.log(`Removed shift on ${TARGET_DATE}`);
console.log(`Difference: ${v1Events - v2Events} event(s)`);
console.log(`Person hash (for sanity): ${personHash}`);
