// Pure helpers for the per-month version compare in the preview lightbox.
//
//   entries for one person            Nov targets
//   ───────────────────────           ─────────────────────────────
//   nov-dec v2 (Oct 20)  ← latest ─┐  month: Nov
//   nov     v1 (Oct 01)  ← older  ─┘  older: [nov v1]
//
// diffMonth then compares the latest snapshot against one older snapshot,
// day by day, for that month only.

import type { ParsedDay } from "../src/types.ts";

type YearMonth = { year: number; month: number };

type VersionEntry = { uploaded_at: string; months: YearMonth[] };

export type CompareTarget<T> = { month: YearMonth; older: T[] };

export type DayChange = { date: string; before: string[]; after: string[] };

// Entries covering `month`, newest first. ISO timestamps compare as strings.
export function versionsForMonth<T extends VersionEntry>(
  entries: readonly T[],
  month: YearMonth,
): T[] {
  return entries
    .filter((e) => e.months.some((m) => sameMonth(m, month)))
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
}

// Months `entry` is the latest version of, each with its older versions.
// Months without older versions get no target (nothing to compare).
export function compareTargetsFor<T extends VersionEntry>(
  entries: readonly T[],
  entry: T,
): CompareTarget<T>[] {
  const targets: CompareTarget<T>[] = [];
  for (const month of entry.months) {
    const [latest, ...older] = versionsForMonth(entries, month);
    if (latest !== entry || older.length === 0) continue;
    targets.push({ month, older });
  }
  return targets;
}

// Days of `month` whose codes differ. Days absent from either version are
// skipped: a missing column is not a change. Code order within a cell is
// ignored, e.g. ["C2","L2"] equals ["L2","C2"].
export function diffMonth(
  latest: { days: ParsedDay[] },
  older: { days: ParsedDay[] },
  month: YearMonth,
): DayChange[] {
  const prefix = `${month.year}-${String(month.month).padStart(2, "0")}-`;
  const olderByDate = new Map(older.days.map((d) => [d.date, d.codes]));

  const changes: DayChange[] = [];
  for (const day of latest.days) {
    if (!day.date.startsWith(prefix)) continue;

    const before = olderByDate.get(day.date);
    if (before === undefined) continue;
    if (cellKey(before) === cellKey(day.codes)) continue;

    changes.push({ date: day.date, before, after: day.codes });
  }
  return changes;
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

function cellKey(codes: string[]): string {
  return [...codes].sort().join(" ");
}
