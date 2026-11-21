// One-off: write rows/<sha>/<person_hash>.json for uploads made before day
// snapshots existed, by re-parsing the stored source PDFs. Existing snapshots
// are left alone. Safe to re-run.
//
// Run on eddy as the service user so file ownership matches:
//   sudo -u pdf2calendar PDF2CAL_DATA_DIR=/var/lib/pdf2calendar \
//     PDF2CAL_DEPARTMENT_SLUG=sia-chuv bun scripts/backfill-day-snapshots.ts

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { daySnapshotPath, serializeDaySnapshot } from "../src/day-snapshot.ts";
import { parse } from "../src/parser.ts";
import { personHash } from "../src/server.ts";
import type { Plan } from "../src/types.ts";

const dataDir = process.env.PDF2CAL_DATA_DIR;
const department = process.env.PDF2CAL_DEPARTMENT_SLUG;
if (!dataDir || !department) {
  console.error("PDF2CAL_DATA_DIR and PDF2CAL_DEPARTMENT_SLUG are required");
  process.exit(1);
}

const plansDir = join(dataDir, "plans");
const sourcesDir = join(dataDir, "sources");
const rowsDir = join(dataDir, "rows");

let written = 0;
for (const file of await readdir(plansDir)) {
  if (!file.endsWith(".json")) continue;

  const plan = JSON.parse(await readFile(join(plansDir, file), "utf-8")) as Plan;
  const sourcePath = join(sourcesDir, `${plan.pdf_sha256}.pdf`);
  if (!(await exists(sourcePath))) {
    console.warn(`skip ${plan.pdf_sha256}: source PDF missing`);
    continue;
  }

  // Re-parse with today's parser. Only persons the plan recorded are
  // written, so a parser change can't invent snapshots for new names.
  const parsed = await parse(new Uint8Array(await readFile(sourcePath)));
  const wanted = new Set(plan.person_hashes);
  for (const person of parsed.people) {
    const hash = await personHash(department, person.name);
    if (!wanted.has(hash)) continue;

    const target = daySnapshotPath(rowsDir, plan.pdf_sha256, hash);
    if (await exists(target)) continue;

    await writeFile(`${target}.tmp`, serializeDaySnapshot(person.days, parsed.day_columns));
    await rename(`${target}.tmp`, target);
    written++;
  }
  console.log(`${plan.pdf_sha256.slice(0, 12)} ${plan.original_filename}: done`);
}
console.log(`wrote ${written} snapshot(s)`);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
