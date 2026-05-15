// Generate a real .ics file from one of the example PDFs, for manual import
// into Apple/Google Calendar.
//
// Run: bun scripts/dump-ics.ts
//   or: bun scripts/dump-ics.ts <pdf-path> <person-name>
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parse } from "../src/parser.ts";
import { generate } from "../src/ics.ts";
import { codes } from "../src/codes.ts";

const PDF = process.argv[2] ?? "example_data/5_Mars2026_26.03_30.04.2026.pdf";
const PERSON = process.argv[3] ?? "Klug, J";
const OUT = "out/klug.ics";

const bytes = new Uint8Array(await readFile(resolve(PDF)));
const r = await parse(bytes, { file_name: PDF });
const person = r.people.find((p) => p.name === PERSON);
if (!person) {
  console.error(`No person named ${JSON.stringify(PERSON)} in ${PDF}.`);
  console.error(`Available: ${r.people.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

const pdfSha = createHash("sha256").update(bytes).digest("hex");
const personHash = createHash("sha256")
  .update("neuro" + "|" + person.name)
  .digest("hex")
  .slice(0, 16);

const ics = generate({
  person,
  person_hash: personHash,
  codes,
  source: {
    file_name: PDF,
    uploaded_at: new Date(),
    pdf_sha256: pdfSha,
    base_url: "https://pdf2calendar.example.com",
  },
});

await mkdir(dirname(resolve(OUT)), { recursive: true });
await writeFile(resolve(OUT), ics, "utf8");
console.log(`Wrote ${OUT} (${ics.length} bytes, ${person.days.length} days, person=${person.name})`);
