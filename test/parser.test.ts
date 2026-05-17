// Spec-driven tests for the parser. See docs/parser-spec.md §"Spot-check assertions".
//
// Tests run end-to-end (parse(Uint8Array)) — they double as a sanity check
// that the legacy pdfjs build wires up cleanly under bun test.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse, parsePages, scanWhitespaceInCodes } from "../src/parser.ts";
import { isKnownCode, V1_CODES } from "../src/codes.ts";
import type { ParsedPerson, RawPage, RawTextItem } from "../src/types.ts";

const MAY = "example_data/1_mai_21.04.2026.pdf";
const MARS_AVRIL = "example_data/5_Mars2026_26.03_30.04.2026.pdf";

async function load(rel: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(rel)));
}

describe("parse(): Phase A — header, dates, months", () => {
  test("single-month PDF (May 2026)", async () => {
    const r = await parse(await load(MAY), { file_name: MAY });
    expect(r.source.page_count).toBeGreaterThanOrEqual(1);
    expect(r.source.page_dims[0]!.width).toBeGreaterThan(0);
    expect(r.source.page_dims[0]!.height).toBeGreaterThan(0);
    expect(r.source.parsed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.source.file_name).toBe(MAY);
    expect(r.date_range).toEqual({ start: "2026-05-01", end: "2026-05-31" });
    expect(r.months).toHaveLength(1);
    expect(r.months[0]).toEqual({
      year: 2026,
      month: 5,
      days_covered: Array.from({ length: 31 }, (_, i) => i + 1),
    });
    // PDF coords: y_top > y_bottom.
    expect(r.header_band.y_top).toBeGreaterThan(r.header_band.y_bottom);
    expect(r.header_band.page).toBe(1);
  });

  test("two-month PDF (Mars + Avril 2026)", async () => {
    const r = await parse(await load(MARS_AVRIL), { file_name: MARS_AVRIL });
    expect(r.date_range).toEqual({ start: "2026-03-23", end: "2026-04-30" });
    expect(r.months).toHaveLength(2);
    expect(r.months[0]).toEqual({
      year: 2026,
      month: 3,
      days_covered: [23, 24, 25, 26, 27, 28, 29, 30, 31],
    });
    expect(r.months[1]).toEqual({
      year: 2026,
      month: 4,
      days_covered: Array.from({ length: 30 }, (_, i) => i + 1),
    });
    expect(r.header_band.y_top).toBeGreaterThan(r.header_band.y_bottom);
  });

  test("opts pass through to source", async () => {
    const r = await parse(await load(MAY), { department: "neuro" });
    expect(r.department).toBe("neuro");
    expect(r.source.file_name).toBe(null);
  });

  test("rejects empty input", async () => {
    expect(parse(new Uint8Array())).rejects.toThrow();
  });
});

describe("parse(): Phase B — people, cells, unknown codes", () => {
  test("two-month PDF: Klug, J row matches spec spot-checks", async () => {
    // Spec §"Spot-check assertions for 5_Mars2026_…" (lines 333–343).
    const r = await parse(await load(MARS_AVRIL));
    const klug = r.people.find((p) => p.name === "Klug, J");
    expect(klug).toBeDefined();
    expect(klug!.role).toBe("ma");
    expect(klug!.days).toHaveLength(39);
    expect(klug!.days[0]!.date).toBe("2026-03-23");
    expect(klug!.days[0]!.codes).toEqual(["N13"]);
    expect(klug!.days[38]!.date).toBe("2026-04-30");

    // row_band: PDF coords are bottom-up.
    expect(klug!.row_band.y_top).toBeGreaterThan(klug!.row_band.y_bottom);
    expect(klug!.row_band.page).toBe(1);
    // Row sits below the header.
    expect(klug!.row_band.y_top).toBeLessThan(r.header_band.y_bottom);
  });

  test("two-month PDF: every person has the right shape", async () => {
    const r = await parse(await load(MARS_AVRIL));
    expect(r.people.length).toBeGreaterThan(0);
    expect(r.people.length).toBeLessThanOrEqual(100);
    for (const p of r.people) {
      expect(p.name).toMatch(/^[A-ZÉÈÀÂÊÎÔÛÄËÏÖÜÇ]/u);
      expect(p.name).not.toMatch(/\s,/);   // normalization removed pre-comma space
      expect(p.days).toHaveLength(39);
      expect(p.days[0]!.date).toBe("2026-03-23");
      expect(p.days[38]!.date).toBe("2026-04-30");
    }
  });

  test("single-month PDF: every person has 31 days", async () => {
    const r = await parse(await load(MAY));
    expect(r.people.length).toBeGreaterThan(0);
    for (const p of r.people) {
      expect(p.days).toHaveLength(31);
      expect(p.days[0]!.date).toBe("2026-05-01");
      expect(p.days[30]!.date).toBe("2026-05-31");
    }
  });

  test("Klug, J: narrow codes land in the correct column (column-center bug)", async () => {
    // Regression: day-number text is right-anchored in its column while codes
    // are left-anchored. Earlier the parser used the day-number's geometric
    // center as the column center, which pulled 1- and 2-char codes (L2, C2,
    // T, X, V, V2…) one column to the left. The user spotted L2 on 04-21
    // when it should have been on 04-22.
    const r = await parse(await load(MARS_AVRIL));
    const klug = r.people.find((p) => p.name === "Klug, J")!;
    const byDate = (d: string) => klug.days.find((x) => x.date === d)?.codes ?? [];

    // The user-confirmed case + the rest of the narrow codes that the
    // geometry predicts should also shift by +1 day.
    expect(byDate("2026-04-22")).toEqual(["L2"]);
    expect(byDate("2026-04-21")).toEqual([]);
    expect(byDate("2026-03-30")).toEqual(["L2"]);
    expect(byDate("2026-03-29")).toEqual([]);
    expect(byDate("2026-04-13")).toEqual(["T"]);
    expect(byDate("2026-04-27")).toEqual(["X"]);
    expect(byDate("2026-04-30")).toEqual(["V"]);
    // Wider codes (3+ chars) were already correctly placed and must not move.
    expect(byDate("2026-03-23")).toEqual(["N13"]);
    expect(byDate("2026-04-17")).toEqual(["Nw13"]);
  });

  test("unknown_codes is sorted, deduped, and contains no V1 dictionary entries", async () => {
    const r = await parse(await load(MARS_AVRIL));
    const sorted = [...r.unknown_codes].sort();
    expect(r.unknown_codes).toEqual(sorted);
    expect(new Set(r.unknown_codes).size).toBe(r.unknown_codes.length);
    for (const u of r.unknown_codes) {
      expect(V1_CODES.has(u)).toBe(false);
    }
  });
});

describe("parsePages(): multi-code text item split", () => {
  // pdfjs sometimes emits a run of same-row consecutive shifts (e.g. several
  // overnight shifts) as a single text item with str="Nw46 Nw46 N46". The
  // parser must split on whitespace and place each token in its own column.
  // Two failure modes if it doesn't:
  //   1. unknown_codes contains literal "Nw46 Nw46 N46" (user-visible: a
  //      "missing comma" between codes in the undeclared-codes message).
  //   2. The concatenated item lands midway between two columns and gets
  //      silently dropped (shifts disappear from the calendar entirely).

  function makeSyntheticPage(multiItem: RawTextItem): RawPage {
    // 31-day May 2026 page. Columns at x_right = 120, 140, 160, ... 720,
    // so each column is 20pt wide and column-center == day-token x_center.
    const items: RawTextItem[] = [];
    // Month band (x_start must be ≤ all day-row x_centers; first day's
    // x_center is 115, so anchor the band at x=100).
    items.push({ str: "MAI 2026", x: 100, y: 560, width: 60, height: 12 });
    // Day-number row (31 days, all at the same y)
    for (let d = 1; d <= 31; d++) {
      const xLeft = 110 + 20 * (d - 1);
      items.push({ str: String(d), x: xLeft, y: 530, width: 10, height: 10 });
    }
    // Weekday-letters row (optional but realistic)
    items.push({ str: "lun.", x: 110, y: 510, width: 15, height: 8 });
    // Person row: name + the multi-code item.
    items.push({ str: "Test, A", x: 30, y: 480, width: 50, height: 10 });
    items.push(multiItem);
    return { page: 1, width: 800, height: 600, items };
  }

  test("a 3-code item ('Nw46 Nw46 N46') is split into 3 adjacent days", () => {
    // Spans columns 5, 6, 7 → days 2026-05-05, -06, -07.
    // Sub-centers land exactly on column centers 190, 210, 230.
    const multi: RawTextItem = {
      str: "Nw46 Nw46 N46",
      x: 180, y: 480, width: 60, height: 8,
    };
    const r = parsePages([makeSyntheticPage(multi)]);
    const person = r.people.find((p) => p.name === "Test, A")!;
    expect(person).toBeDefined();
    const byDate = (d: string) => person.days.find((x) => x.date === d)?.codes ?? [];
    expect(byDate("2026-05-05")).toEqual(["Nw46"]);
    expect(byDate("2026-05-06")).toEqual(["Nw46"]);
    expect(byDate("2026-05-07")).toEqual(["N46"]);
    // Nothing should leak the literal concatenation into unknown_codes.
    expect(r.unknown_codes.some((c) => /\s/.test(c))).toBe(false);
  });

  test("a 4-code item is split across 4 adjacent days", () => {
    // Spans columns 10..13. Slice = 60/4 = 15; sub-centers at item.x+7.5, +22.5,
    // +37.5, +52.5. Want them at columns 10..13 centers: 290, 310, 330, 350.
    // Stretch the slice to match column-center spacing (20pt) — item.width=80,
    // slice=20, sub-centers at item.x+10, +30, +50, +70 → item.x=280.
    const multi: RawTextItem = {
      str: "Nw46 Nw46 Nw46 Nw46",
      x: 280, y: 480, width: 80, height: 8,
    };
    const r = parsePages([makeSyntheticPage(multi)]);
    const person = r.people.find((p) => p.name === "Test, A")!;
    const byDate = (d: string) => person.days.find((x) => x.date === d)?.codes ?? [];
    expect(byDate("2026-05-10")).toEqual(["Nw46"]);
    expect(byDate("2026-05-11")).toEqual(["Nw46"]);
    expect(byDate("2026-05-12")).toEqual(["Nw46"]);
    expect(byDate("2026-05-13")).toEqual(["Nw46"]);
    expect(r.unknown_codes.every((c) => isKnownCode(c))).toBe(true);
  });

  test("single-token items are unchanged (no regression)", () => {
    const single: RawTextItem = {
      str: "C1",
      x: 185, y: 480, width: 10, height: 8, // x_center=190 → column 5 (day 5)
    };
    const r = parsePages([makeSyntheticPage(single)]);
    const person = r.people.find((p) => p.name === "Test, A")!;
    expect(person.days.find((x) => x.date === "2026-05-05")?.codes).toEqual(["C1"]);
  });

  test("no whitespace-bearing entry ever appears in unknown_codes (example PDFs)", async () => {
    for (const pdf of [MAY, MARS_AVRIL]) {
      const r = await parse(await load(pdf));
      const offenders = r.unknown_codes.filter((c) => /\s/.test(c));
      expect(offenders).toEqual([]);
    }
  });
});

describe("scanWhitespaceInCodes(): inflight anomaly detector", () => {
  function fakePerson(days: { date: string; codes: string[] }[]): ParsedPerson {
    return {
      role: "ma",
      name: "Test, A",
      row_band: { page: 1, y_top: 10, y_bottom: 0 },
      days,
    };
  }

  test("flags every code that contains whitespace", () => {
    const w = scanWhitespaceInCodes([
      fakePerson([
        { date: "2026-05-01", codes: ["Nw46"] },
        { date: "2026-05-02", codes: ["Nw46 Nw46"] }, // anomaly
        { date: "2026-05-03", codes: ["Nw46\tNw46"] }, // also whitespace
        { date: "2026-05-04", codes: ["C1"] },
      ]),
    ]);
    expect(w).toEqual([
      { kind: "whitespace_in_code", name: "Test, A", date: "2026-05-02", code: "Nw46 Nw46" },
      { kind: "whitespace_in_code", name: "Test, A", date: "2026-05-03", code: "Nw46\tNw46" },
    ]);
  });

  test("returns no warnings for clean input", () => {
    expect(
      scanWhitespaceInCodes([
        fakePerson([{ date: "2026-05-01", codes: ["Nw46", "C1", "°N13"] }]),
      ]),
    ).toEqual([]);
  });

  test("example PDFs produce zero whitespace_in_code warnings", async () => {
    for (const pdf of [MAY, MARS_AVRIL]) {
      const r = await parse(await load(pdf));
      const offenders = r.warnings.filter((w) => w.kind === "whitespace_in_code");
      expect(offenders).toEqual([]);
    }
  });
});

describe("isKnownCode(): codes dictionary", () => {
  test("V1 entries are recognized", () => {
    for (const c of ["N13", "Cw3", "L6", "T", "T2", "X", "V", "CP", "MAL", "°C2"]) {
      expect(isKnownCode(c)).toBe(true);
    }
  });

  test("°/* prefix strip lets the base code match", () => {
    // "°C2" is in the dictionary verbatim; the prefix-strip rule is what
    // makes "°N13" → "N13" succeed even though "°N13" isn't a literal entry.
    expect(isKnownCode("°N13")).toBe(true);
    expect(isKnownCode("*C3")).toBe(true);
  });

  test("non-codes are unknown", () => {
    for (const c of ["Cw13", "Lw46", "ZZZ", "", "FooBar"]) {
      expect(isKnownCode(c)).toBe(false);
    }
  });
});
