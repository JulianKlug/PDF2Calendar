// Per-person, per-upload shift snapshot (see DaySnapshot in types.ts).
// Shared by the upload handler and scripts/backfill-day-snapshots.ts so both
// write byte-identical files.

import { join } from "node:path";

import {
  DAY_SNAPSHOT_SCHEMA_VERSION,
  type DayColumn,
  type DaySnapshot,
  type ParsedDay,
} from "./types.ts";

// rows/<pdf_sha256>/<person_hash>.json — next to the row PNG, so nginx's
// existing /source/ location serves it.
export function daySnapshotPath(
  rowsDir: string,
  pdfSha: string,
  personHash: string,
): string {
  return join(rowsDir, pdfSha, `${personHash}.json`);
}

export function serializeDaySnapshot(
  days: ParsedDay[],
  columns: DayColumn[],
): string {
  const snapshot: DaySnapshot = {
    schema_version: DAY_SNAPSHOT_SCHEMA_VERSION,
    days,
    columns,
  };
  return JSON.stringify(snapshot) + "\n";
}
