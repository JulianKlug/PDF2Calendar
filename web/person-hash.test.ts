// Spec § Identifier hashing (normative). These tests lock down the byte-for-byte
// contract with the server. If the server ever re-implements personHash() and
// disagrees with these vectors, every upload from this build returns 400.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { normalize, personHash } from "./person-hash.ts";

describe("normalize", () => {
  test("NFC composes decomposed forms", () => {
    const decomposed = "é"; // "e" + combining acute → "é"
    expect(normalize(decomposed)).toBe("é");
    expect(normalize(decomposed)).toBe(normalize("é"));
  });

  test("lowercases", () => {
    expect(normalize("KLUG, J")).toBe("klug, j");
  });

  test("trims and collapses internal whitespace", () => {
    expect(normalize("  Klug,   J  ")).toBe("klug, j");
    expect(normalize("Klug,\tJ")).toBe("klug, j");
  });

  test("strips trailing .,;:!?", () => {
    expect(normalize("Klug, J.")).toBe("klug, j");
    expect(normalize("Klug, J?")).toBe("klug, j");
    expect(normalize("Klug, J!!!")).toBe("klug, j");
    // Internal punctuation is preserved.
    expect(normalize("Klug, J")).toBe("klug, j");
  });
});

describe("personHash", () => {
  test("locked-down fixture: (anesthesia-chuv, Klug, J) = 79897ea12fbe8e91", async () => {
    // Cross-validation vector for the server. Recorded value, NOT computed
    // from the function under test (otherwise this would be tautological).
    // sha256("anesthesia-chuv|klug, j")[:16]
    const got = await personHash("anesthesia-chuv", "Klug, J");
    expect(got).toBe("79897ea12fbe8e91");
    expect(got).toHaveLength(16);
  });

  test("normalize() variants converge to the same hash", async () => {
    const canonical = await personHash("anesthesia-chuv", "Klug, J");
    expect(await personHash("anesthesia-chuv", "KLUG, J")).toBe(canonical);
    expect(await personHash("anesthesia-chuv", "  Klug,   J  ")).toBe(canonical);
    expect(await personHash("anesthesia-chuv", "Klug, J.")).toBe(canonical);
  });

  test("matches node:crypto for arbitrary (dept, name) pairs", async () => {
    const cases: Array<[string, string]> = [
      ["anesthesia-chuv", "Klug, J"],
      ["anesthesia-chuv", "Baldwin, J"],
      ["neuro", "Smith, A"],
    ];
    for (const [dept, name] of cases) {
      const got = await personHash(dept, name);
      const want = createHash("sha256")
        .update(`${dept}|${normalize(name)}`)
        .digest("hex")
        .slice(0, 16);
      expect(got).toBe(want);
    }
  });
});
