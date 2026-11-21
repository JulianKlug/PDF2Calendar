import { describe, expect, test } from "bun:test";

import { compareTargetsFor, diffMonth, versionsForMonth } from "./version-diff.ts";

type E = {
  id: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number }>;
};

const entry = (id: string, uploaded_at: string, ...months: [number, number][]): E => ({
  id,
  uploaded_at,
  months: months.map(([year, month]) => ({ year, month })),
});

const NOV_2026 = { year: 2026, month: 11 };
const ids = (es: E[]) => es.map((e) => e.id);

describe("versionsForMonth", () => {
  test("entries covering the month, newest first", () => {
    const entries = [
      entry("nov-v1", "2026-10-01T10:00:00Z", [2026, 11]),
      entry("dec", "2026-11-01T10:00:00Z", [2026, 12]),
      entry("nov-v3", "2026-10-20T10:00:00Z", [2026, 11]),
      entry("oct-nov", "2026-09-15T10:00:00Z", [2026, 10], [2026, 11]),
    ];
    expect(ids(versionsForMonth(entries, NOV_2026))).toEqual([
      "nov-v3",
      "nov-v1",
      "oct-nov",
    ]);
  });
});

describe("compareTargetsFor", () => {
  test("one target per month the entry owns that has older versions", () => {
    const latest = entry("nov-dec-v2", "2026-10-20T10:00:00Z", [2026, 11], [2026, 12]);
    const entries = [
      latest,
      entry("nov-v1", "2026-10-01T10:00:00Z", [2026, 11]),
    ];

    const targets = compareTargetsFor(entries, latest);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.month).toEqual(NOV_2026);
    expect(ids(targets[0]!.older)).toEqual(["nov-v1"]);
  });

  test("no target for a month a newer upload owns", () => {
    const old = entry("nov-v1", "2026-10-01T10:00:00Z", [2026, 11]);
    const entries = [old, entry("nov-v2", "2026-10-20T10:00:00Z", [2026, 11])];
    expect(compareTargetsFor(entries, old)).toEqual([]);
  });
});

describe("diffMonth", () => {
  const latest = {
    days: [
      { date: "2026-10-31", codes: ["N"] },
      { date: "2026-11-01", codes: ["D"] },
      { date: "2026-11-02", codes: ["C2", "L2"] },
      { date: "2026-11-03", codes: [] },
      { date: "2026-11-04", codes: ["N"] },
    ],
  };
  const older = {
    days: [
      { date: "2026-10-31", codes: ["D"] },
      { date: "2026-11-01", codes: ["D"] },
      { date: "2026-11-02", codes: ["L2", "C2"] },
      { date: "2026-11-03", codes: ["V"] },
    ],
  };

  test("lists changed days of the month only, ignoring code order", () => {
    expect(diffMonth(latest, older, NOV_2026)).toEqual([
      { date: "2026-11-03", before: ["V"], after: [] },
    ]);
  });

  test("days missing from either version are not compared", () => {
    const changes = diffMonth(latest, older, NOV_2026);
    expect(changes.map((c) => c.date)).not.toContain("2026-11-04");
  });
});
