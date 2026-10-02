// Same-unit coworkers per shift. Pure function.
//
// Two shifts pair when they fall on the same date, in the same period
// (day: C/Cw/L/Lw, night: N/Nw) and their unit sets overlap.
// Unit set comes from the code suffix (docs/Codes.md):
//   L1   → {1}        Lw13 → {1,2,3}       N46 → {4,5,6}
// So Lw13 pairs with C1, C2, L3; N46 pairs with N46; L1 never pairs with N13.
// Other codes (T13, V, …) carry no unit and get no colleagues.

import type { ParsedDay } from "./types.ts";

type Period = "day" | "night";

type Coverage = { period: Period; units: Set<number> };

// date → per-code (seq) list of labels, e.g. { "2026-04-18": [["Doe, J (ma, C1)"]] }
export type ColleagueMap = Record<string, string[][]>;

// Must match TENTATIVE_PREFIX in codes.ts.
const TENTATIVE_PREFIX = /^[°*#]/;
const UNIT_SHIFT_RE = /^([CLN])w?(\d)(\d)?$/;
const NIGHT_FAMILY = "N";

function coverage(raw: string): Coverage | null {
  const m = raw.replace(TENTATIVE_PREFIX, "").match(UNIT_SHIFT_RE);
  if (!m) return null;

  // Single digit = one unit; two digits = inclusive range ("13" → 1..3).
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  const units = new Set<number>();
  for (let u = from; u <= to; u++) units.add(u);

  return { period: m[1] === NIGHT_FAMILY ? "night" : "day", units };
}

function overlaps(a: Coverage, b: Coverage): boolean {
  if (a.period !== b.period) return false;
  for (const u of a.units) if (b.units.has(u)) return true;
  return false;
}

// Returns one ColleagueMap per input person, aligned by index.
export function findColleagues(
  people: Array<{ name: string; role: string; days: ParsedDay[] }>,
): ColleagueMap[] {
  type Slot = { personIdx: number; seq: number; label: string; cov: Coverage | null };

  // Group every (person, code) by date, initialising empty colleague lists.
  const result: ColleagueMap[] = people.map(() => ({}));
  const byDate = new Map<string, Slot[]>();
  people.forEach((p, personIdx) => {
    for (const day of p.days) {
      result[personIdx]![day.date] = day.codes.map(() => []);
      day.codes.forEach((code, seq) => {
        const slots = byDate.get(day.date) ?? [];
        slots.push({ personIdx, seq, label: `${p.name} (${p.role}, ${code})`, cov: coverage(code) });
        byDate.set(day.date, slots);
      });
    }
  });

  // Pair overlapping slots of different people on the same date.
  for (const [date, slots] of byDate) {
    for (const a of slots) {
      if (!a.cov) continue;

      for (const b of slots) {
        if (!b.cov || a.personIdx === b.personIdx) continue;
        if (!overlaps(a.cov, b.cov)) continue;
        result[a.personIdx]![date]![a.seq]!.push(b.label);
      }
    }
  }

  return result;
}
