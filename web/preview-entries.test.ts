import { describe, expect, test } from "bun:test";

import { selectPreviewEntries } from "./preview-entries.ts";

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

const OCT_2026 = { year: 2026, month: 10 };
const ids = (es: E[]) => es.map((e) => e.id);

describe("selectPreviewEntries", () => {
  test("keeps only the most recent upload of a month", () => {
    const entries = [
      entry("oct-v2", "2026-09-30T10:00:00Z", [2026, 10]),
      entry("oct-v1", "2026-09-01T10:00:00Z", [2026, 10]),
    ];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["oct-v2"]);
  });

  test("most recent wins regardless of input order", () => {
    const entries = [
      entry("oct-v1", "2026-09-01T10:00:00Z", [2026, 10]),
      entry("oct-v2", "2026-09-30T10:00:00Z", [2026, 10]),
    ];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["oct-v2"]);
  });

  test("skips months before the current one, keeps the current month", () => {
    const entries = [
      entry("sep", "2026-08-20T10:00:00Z", [2026, 9]),
      entry("oct", "2026-09-20T10:00:00Z", [2026, 10]),
      entry("aug-2027", "2026-09-20T11:00:00Z", [2027, 8]),
    ];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["oct", "aug-2027"]);
  });

  test("past year with a later month number is still past", () => {
    const entries = [entry("dec-2025", "2025-11-20T10:00:00Z", [2025, 12])];
    expect(selectPreviewEntries(entries, OCT_2026)).toEqual([]);
  });

  test("two-month plan kept while it still owns a current month", () => {
    const entries = [entry("sep-oct", "2026-08-20T10:00:00Z", [2026, 9], [2026, 10])];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["sep-oct"]);
  });

  test("two-month plan dropped once a newer upload owns its future month", () => {
    const entries = [
      entry("sep-oct", "2026-08-20T10:00:00Z", [2026, 9], [2026, 10]),
      entry("oct", "2026-09-20T10:00:00Z", [2026, 10]),
    ];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["oct"]);
  });

  test("sorted chronologically by month", () => {
    const entries = [
      entry("dec", "2026-09-01T10:00:00Z", [2026, 12]),
      entry("oct", "2026-09-02T10:00:00Z", [2026, 10]),
      entry("nov", "2026-09-03T10:00:00Z", [2026, 11]),
    ];
    expect(ids(selectPreviewEntries(entries, OCT_2026))).toEqual(["oct", "nov", "dec"]);
  });
});
