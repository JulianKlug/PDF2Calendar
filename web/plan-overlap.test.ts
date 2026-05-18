import { describe, expect, test } from "bun:test";

import { findOverlappingPlans, plansShareAnyDate } from "./plan-overlap.ts";

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

describe("findOverlappingPlans", () => {
  // The motivating bug: May plan uploaded first, October plan uploaded second
  // (so it becomes `latest_plan`), then May plan re-uploaded. The old May plan
  // overlaps with the incoming and its events get overwritten by mergeIcs,
  // but the warning previously only checked latest_plan (October) and falsely
  // said "covers different dates and will be kept".
  test("regression: re-uploading May finds the older non-latest May plan", () => {
    const may = [{ year: 2026, month: 5, days_covered: [1, 2, 3] }];
    const october = [{ year: 2026, month: 10, days_covered: [1, 2, 3] }];
    // plans[] arrives sorted by uploaded_at desc, so October (latest) is first.
    const plans = [
      { original_filename: "6_octobre_13.04.2026.pdf", months: october },
      { original_filename: "1_mai_11.05.2026.pdf", months: may },
    ];
    const overlapping = findOverlappingPlans(may, plans);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.original_filename).toBe("1_mai_11.05.2026.pdf");
  });

  test("returns matches in input order (sorted desc → most-recent first)", () => {
    const target = [{ year: 2026, month: 6, days_covered: [10, 11, 12] }];
    const plans = [
      {
        original_filename: "june_v2.pdf",
        months: [{ year: 2026, month: 6, days_covered: [12] }],
      },
      {
        original_filename: "june_v1.pdf",
        months: [{ year: 2026, month: 6, days_covered: [10, 11] }],
      },
      {
        original_filename: "july.pdf",
        months: [{ year: 2026, month: 7, days_covered: [1] }],
      },
    ];
    const overlapping = findOverlappingPlans(target, plans);
    expect(overlapping.map((p) => p.original_filename)).toEqual([
      "june_v2.pdf",
      "june_v1.pdf",
    ]);
  });

  test("no overlap with any plan → empty array", () => {
    const target = [{ year: 2026, month: 5, days_covered: [1, 2, 3] }];
    const plans = [
      {
        original_filename: "october.pdf",
        months: [{ year: 2026, month: 10, days_covered: [1, 2, 3] }],
      },
      {
        original_filename: "november.pdf",
        months: [{ year: 2026, month: 11, days_covered: [1, 2, 3] }],
      },
    ];
    expect(findOverlappingPlans(target, plans)).toEqual([]);
  });

  test("empty plans array → empty result", () => {
    const target = [{ year: 2026, month: 5, days_covered: [1] }];
    expect(findOverlappingPlans(target, [])).toEqual([]);
  });
});
