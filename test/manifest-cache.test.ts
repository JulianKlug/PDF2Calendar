// Spec-driven tests for the manifest cache. See docs/v2-spec.md
// § Server changes / New endpoint / Manifest scan tolerance.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManifestCache } from "../src/manifest-cache.ts";

const BASE_URL = "https://pdf2calendar.example.com";
const DEPT = "test-dept";

let dataDir: string;
let cache: ManifestCache;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "p2c-manifest-test-"));
  await mkdir(join(dataDir, "plans"), { recursive: true });
  await mkdir(join(dataDir, "manifest"), { recursive: true });
  cache = new ManifestCache({ dataDir, baseUrl: BASE_URL, departmentSlug: DEPT });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function planFixture(opts: {
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  person_hashes: string[];
}) {
  return {
    schema_version: 2,
    ...opts,
  };
}

function v2Manifest(opts: {
  name: string;
  role: string;
  entries: Array<{
    pdf_sha256: string;
    original_filename: string;
    uploaded_at: string;
    months: Array<{ year: number; month: number }>;
  }>;
}) {
  return {
    schema_version: 2,
    name: opts.name,
    role: opts.role,
    last_uploaded_at: opts.entries[opts.entries.length - 1]!.uploaded_at,
    last_pdf_sha256: opts.entries[opts.entries.length - 1]!.pdf_sha256,
    last_date_range: { start: "2026-05-01", end: "2026-05-31" },
    entries: opts.entries,
  };
}

async function writePlan(name: string, body: unknown) {
  await writeFile(
    join(dataDir, "plans", `${name}.json`),
    JSON.stringify(body, null, 2),
  );
}

async function writeManifest(personHash: string, body: unknown) {
  await writeFile(
    join(dataDir, "manifest", `${personHash}.json`),
    JSON.stringify(body, null, 2),
  );
}

describe("empty data dir", () => {
  test("→ latest_plan null + empty plans + empty staff", async () => {
    const res = await cache.get();
    expect(res.schema_version).toBe(2);
    expect(res.department_slug).toBe(DEPT);
    expect(res.latest_plan).toBeNull();
    expect(res.plans).toEqual([]);
    expect(res.staff).toEqual([]);
  });
});

describe("populated", () => {
  test("latest_plan is newest by uploaded_at", async () => {
    await writePlan(
      "aaa",
      planFixture({
        pdf_sha256: "aaa",
        original_filename: "old.pdf",
        uploaded_at: "2026-05-01T10:00:00.000Z",
        months: [{ year: 2026, month: 5, days_covered: [1] }],
        person_hashes: ["1111111111111111"],
      }),
    );
    await writePlan(
      "bbb",
      planFixture({
        pdf_sha256: "bbb",
        original_filename: "new.pdf",
        uploaded_at: "2026-05-20T10:00:00.000Z",
        months: [{ year: 2026, month: 5, days_covered: [20] }],
        person_hashes: ["1111111111111111"],
      }),
    );

    const res = await cache.get();
    expect(res.plans).toHaveLength(2);
    expect(res.latest_plan?.pdf_sha256).toBe("bbb");
    expect(res.latest_plan?.original_filename).toBe("new.pdf");
  });

  test("staff entries join plan info and produce row_url", async () => {
    await writePlan(
      "abc",
      planFixture({
        pdf_sha256: "abc",
        original_filename: "may.pdf",
        uploaded_at: "2026-05-01T10:00:00.000Z",
        months: [{ year: 2026, month: 5, days_covered: [1, 2] }],
        person_hashes: ["1111111111111111"],
      }),
    );
    await writeManifest(
      "1111111111111111",
      v2Manifest({
        name: "Klug, J",
        role: "ma",
        entries: [
          {
            pdf_sha256: "abc",
            original_filename: "may.pdf",
            uploaded_at: "2026-05-01T10:00:00.000Z",
            months: [{ year: 2026, month: 5 }],
          },
        ],
      }),
    );

    const res = await cache.get();
    expect(res.staff).toHaveLength(1);
    const s = res.staff[0]!;
    expect(s.person_hash).toBe("1111111111111111");
    expect(s.name).toBe("Klug, J");
    expect(s.role).toBe("ma");
    expect(s.feed_url).toBe(`${BASE_URL}/feed/1111111111111111.ics`);
    expect(s.entries[0]!.row_url).toBe(
      `${BASE_URL}/source/abc/1111111111111111.png`,
    );
    expect(s.entries[0]!.months).toEqual([{ year: 2026, month: 5 }]);
  });

  test("staff sorted by name", async () => {
    await writeManifest(
      "aaaaaaaaaaaaaaaa",
      v2Manifest({
        name: "Zylinski, A",
        role: "ma",
        entries: [
          {
            pdf_sha256: "x",
            original_filename: "x.pdf",
            uploaded_at: "2026-05-01T10:00:00.000Z",
            months: [{ year: 2026, month: 5 }],
          },
        ],
      }),
    );
    await writeManifest(
      "bbbbbbbbbbbbbbbb",
      v2Manifest({
        name: "Adams, J",
        role: "ma",
        entries: [
          {
            pdf_sha256: "x",
            original_filename: "x.pdf",
            uploaded_at: "2026-05-01T10:00:00.000Z",
            months: [{ year: 2026, month: 5 }],
          },
        ],
      }),
    );

    const res = await cache.get();
    expect(res.staff.map((s) => s.name)).toEqual(["Adams, J", "Zylinski, A"]);
  });
});

describe("scan tolerance", () => {
  test("V1-shaped manifest (no schema_version) is skipped", async () => {
    await writeManifest("ffffffffffffffff", {
      name: "Legacy, V",
      role: "ma",
      last_uploaded_at: "2026-04-01T10:00:00.000Z",
      last_pdf_sha256: "old",
      last_date_range: { start: "2026-04-01", end: "2026-04-30" },
    });
    const res = await cache.get();
    expect(res.staff).toEqual([]);
  });

  test("V2 manifest with empty entries[] is skipped", async () => {
    await writeManifest("ffffffffffffffff", {
      schema_version: 2,
      name: "Legacy, V",
      role: "ma",
      last_uploaded_at: "2026-04-01T10:00:00.000Z",
      last_pdf_sha256: "old",
      last_date_range: { start: "2026-04-01", end: "2026-04-30" },
      entries: [],
    });
    const res = await cache.get();
    expect(res.staff).toEqual([]);
  });

  test("corrupt JSON is skipped + warned; scan completes", async () => {
    await writeFile(
      join(dataDir, "manifest", "1111111111111111.json"),
      "{ not valid json",
    );
    await writeManifest(
      "2222222222222222",
      v2Manifest({
        name: "Valid, P",
        role: "ma",
        entries: [
          {
            pdf_sha256: "x",
            original_filename: "x.pdf",
            uploaded_at: "2026-05-01T10:00:00.000Z",
            months: [{ year: 2026, month: 5 }],
          },
        ],
      }),
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      const res = await cache.get();
      expect(res.staff).toHaveLength(1);
      expect(res.staff[0]!.name).toBe("Valid, P");
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("1111111111111111.json"))).toBe(true);
  });

  test(".tmp files are ignored", async () => {
    await writeFile(
      join(dataDir, "manifest", "1111111111111111.json.tmp"),
      "garbage",
    );
    await writeFile(
      join(dataDir, "plans", "aaa.json.tmp"),
      "garbage",
    );
    const res = await cache.get();
    expect(res.staff).toEqual([]);
    expect(res.plans).toEqual([]);
  });
});

describe("version counter + invalidation", () => {
  test("invalidate() increments version and forces re-scan", async () => {
    expect(cache.getVersion()).toBe(0);

    const before = await cache.get();
    expect(before.staff).toEqual([]);

    await writeManifest(
      "1111111111111111",
      v2Manifest({
        name: "Klug, J",
        role: "ma",
        entries: [
          {
            pdf_sha256: "x",
            original_filename: "x.pdf",
            uploaded_at: "2026-05-01T10:00:00.000Z",
            months: [{ year: 2026, month: 5 }],
          },
        ],
      }),
    );

    // Without invalidation, cached snapshot still shows empty.
    const stale = await cache.get();
    expect(stale.staff).toEqual([]);

    cache.invalidate();
    expect(cache.getVersion()).toBe(1);

    const fresh = await cache.get();
    expect(fresh.staff).toHaveLength(1);
  });
});
