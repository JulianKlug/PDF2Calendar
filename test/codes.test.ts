import { describe, expect, test } from "bun:test";
import { codes } from "../src/codes.ts";

// Hours effective from October 2026 plans.
describe("codes: shift hours", () => {
  const cases: [string, string, string][] = [
    ["C1", "07:15", "17:30"],
    ["Cw1", "08:00", "17:15"],
    ["C13", "07:15", "17:30"],
    ["Cw13", "08:00", "17:15"],
    ["L1", "07:15", "20:45"],
    ["Lw1", "08:00", "20:45"],
    ["N13", "20:00", "08:15"],
    ["Nw13", "20:00", "08:30"],
    ["T", "09:00", "19:00"],
    ["T2", "07:15", "17:15"],
    ["T13", "07:15", "17:15"],
    ["T45", "09:00", "19:00"],
    ["TDS", "10:00", "20:00"],
  ];

  for (const [key, start, end] of cases) {
    test(`${key}: ${start}–${end}`, () => {
      expect(codes[key]).toMatchObject({ kind: "timed", start, end });
    });
  }

  test("TIR titles carry the full code", () => {
    expect(codes.T).toMatchObject({ title: "TIR (T1)" });
    expect(codes.TDS).toMatchObject({ title: "TIR (TDS)" });
  });

  test("FI2 and FD are all-day", () => {
    expect(codes.FI2).toEqual({ kind: "allday", title: "Formation interne" });
    expect(codes.FD).toEqual({ kind: "allday", title: "Formation donnée" });
  });
});
