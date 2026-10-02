import { describe, expect, test } from "bun:test";
import { findColleagues } from "../src/colleagues.ts";

const DATE = "2026-04-18";

function person(name: string, role: string, codes: string[]) {
  return { name, role, days: [{ date: DATE, codes }] };
}

describe("findColleagues", () => {
  test("L1 (cdc) works with C1 (ma)", () => {
    const res = findColleagues([person("A", "cdc", ["L1"]), person("B", "ma", ["C1"])]);
    expect(res[0]![DATE]).toEqual([["B (ma, C1)"]]);
    expect(res[1]![DATE]).toEqual([["A (cdc, L1)"]]);
  });

  test("N46 works with N46", () => {
    const res = findColleagues([person("A", "cdc", ["N46"]), person("B", "ma", ["N46"])]);
    expect(res[0]![DATE]).toEqual([["B (ma, N46)"]]);
  });

  test("Lw13 works with C1, C2, L3 but not C4", () => {
    const res = findColleagues([
      person("A", "cdc", ["Lw13"]),
      person("B", "ma", ["C1"]),
      person("C", "ma", ["C2"]),
      person("D", "ma", ["L3"]),
      person("E", "ma", ["C4"]),
    ]);
    expect(res[0]![DATE]).toEqual([["B (ma, C1)", "C (ma, C2)", "D (ma, L3)"]]);
    expect(res[4]![DATE]).toEqual([[]]);
  });

  test("day and night shifts on same units don't pair", () => {
    const res = findColleagues([person("A", "cdc", ["L1"]), person("B", "ma", ["N13"])]);
    expect(res[0]![DATE]).toEqual([[]]);
  });

  test("tentative prefix still matches; raw code shown", () => {
    const res = findColleagues([person("A", "cdc", ["Cw13"]), person("B", "ma", ["°Cw2"])]);
    expect(res[0]![DATE]).toEqual([["B (ma, °Cw2)"]]);
  });

  test("non-unit codes have no colleagues", () => {
    const res = findColleagues([person("A", "cdc", ["T13"]), person("B", "ma", ["C1"])]);
    expect(res[0]![DATE]).toEqual([[]]);
    expect(res[1]![DATE]).toEqual([[]]);
  });

  test("different dates don't pair", () => {
    const res = findColleagues([
      person("A", "cdc", ["C1"]),
      { name: "B", role: "ma", days: [{ date: "2026-04-19", codes: ["C1"] }] },
    ]);
    expect(res[0]![DATE]).toEqual([[]]);
  });
});
