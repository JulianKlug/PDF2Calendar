// Spec-driven tests for the parser. See docs/parser-spec.md §"Spot-check assertions".
//
// Tests run end-to-end (parse(Uint8Array)) — they double as a sanity check
// that the legacy pdfjs build wires up cleanly under bun test.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "../src/parser.ts";
import { isKnownCode, V1_CODES } from "../src/codes.ts";
import { ParseError } from "../src/types.ts";

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
