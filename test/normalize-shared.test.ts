// Cross-implementation gate for normalize(). The shared fixture
// `test/fixtures/normalize.json` is also imported by
// `web/person-hash.test.ts`. Any drift between the server's normalize()
// and the frontend's fails one or both sides on the next CI run.

import { describe, expect, test } from "bun:test";

import { normalize } from "../src/server.ts";
import fixture from "./fixtures/normalize.json" with { type: "json" };

type Row = {
  name: string;
  expected_normalize: string;
  department?: string;
  expected_person_hash?: string;
  note?: string;
};

describe("normalize() — shared fixture (server side)", () => {
  for (const row of fixture as Row[]) {
    test(`normalize(${JSON.stringify(row.name)}) → ${JSON.stringify(row.expected_normalize)}`, () => {
      expect(normalize(row.name)).toBe(row.expected_normalize);
    });
  }
});
