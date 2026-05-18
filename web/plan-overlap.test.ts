import { describe, expect, test } from "bun:test";

import { plansShareAnyDate } from "./plan-overlap.ts";

describe("plansShareAnyDate", () => {
  test("identical months and days → true", () => {
    const a = [{ year: 2026, month: 1, days_covered: [1, 2, 3] }];
    const b = [{ year: 2026, month: 1, days_covered: [1, 2, 3] }];
    expect(plansShareAnyDate(a, b)).toBe(true);
  });

  test("same month, disjoint days → false (the motivating case)", () => {
    // Old plan covers Feb 1-15, new plan covers Feb 16-28. No event overlap.
    const a = [
      { year: 2026, month: 2, days_covered: Array.from({ length: 15 }, (_, i) => i + 1) },
    ];
    const b = [
      { year: 2026, month: 2, days_covered: Array.from({ length: 13 }, (_, i) => i + 16) },
    ];
    expect(plansShareAnyDate(a, b)).toBe(false);
  });

  test("same month, single shared day → true", () => {
    const a = [{ year: 2026, month: 2, days_covered: [1, 2, 3, 15] }];
    const b = [{ year: 2026, month: 2, days_covered: [15, 16, 17] }];
    expect(plansShareAnyDate(a, b)).toBe(true);
  });

  test("disjoint months entirely → false", () => {
    const a = [{ year: 2026, month: 1, days_covered: [1, 2, 3] }];
    const b = [{ year: 2026, month: 3, days_covered: [1, 2, 3] }];
    expect(plansShareAnyDate(a, b)).toBe(false);
  });

  test("different years, same month and day → false", () => {
    const a = [{ year: 2025, month: 6, days_covered: [15] }];
    const b = [{ year: 2026, month: 6, days_covered: [15] }];
    expect(plansShareAnyDate(a, b)).toBe(false);
  });

  test("multi-month spans with one overlapping day → true", () => {
    const a = [
      { year: 2026, month: 1, days_covered: [29, 30, 31] },
      { year: 2026, month: 2, days_covered: [1, 2] },
    ];
    const b = [
      { year: 2026, month: 2, days_covered: [2, 3, 4] },
      { year: 2026, month: 3, days_covered: [1] },
    ];
    expect(plansShareAnyDate(a, b)).toBe(true);
  });

  test("ambiguous-looking keys do not collide (2026-1-11 vs 2026-11-1)", () => {
    // Set-key format is `${year}-${month}-${day}`. (2026, 1, 11) and (2026, 11, 1)
    // produce distinct strings "2026-1-11" and "2026-11-1" — they must not be
    // treated as the same date.
    const a = [{ year: 2026, month: 1, days_covered: [11] }];
    const b = [{ year: 2026, month: 11, days_covered: [1] }];
    expect(plansShareAnyDate(a, b)).toBe(false);
  });

  test("empty arrays → false", () => {
    expect(plansShareAnyDate([], [])).toBe(false);
    expect(plansShareAnyDate([{ year: 2026, month: 1, days_covered: [1] }], [])).toBe(false);
    expect(plansShareAnyDate([], [{ year: 2026, month: 1, days_covered: [1] }])).toBe(false);
  });
});
