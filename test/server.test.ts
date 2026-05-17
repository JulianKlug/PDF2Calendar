// Spec-driven tests for the V1 server. See docs/server-spec.md § Test plan.
// Each test spins up Bun.serve() on a random free port against a fresh
// tmp PDF2CAL_DATA_DIR.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrap,
  createServer,
  orphanSweep,
  personHash,
  type Env,
  type ServerLike,
} from "../src/server.ts";

const DEPT = "anesthesia-chuv";

let server: ServerLike;
let env: Env;
let baseUrl: string;

beforeEach(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "p2c-test-"));
  env = {
    port: 0,
    dataDir,
    baseUrl: "http://localhost:3001",
    departmentSlug: DEPT,
    maxUploadBytes: 10 * 1024 * 1024,
  };
  await bootstrap(env);
  server = createServer(env);
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  await rm(env.dataDir, { recursive: true, force: true });
});

// ─── fixture helpers ──────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pngBytes(): Uint8Array {
  // 1×1 PNG. Bytes are valid PNG; Content-Type is what the server checks.
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
    0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
    0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
    0x01, 0x5a, 0xe2, 0x45, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
}

function pdfBytes(label: string = "pdf-a"): Uint8Array {
  // Arbitrary bytes — the server hashes whatever we send and checks against
  // payload.pdf_sha256. We compute the sha at fixture time so they match.
  return new TextEncoder().encode(`%PDF-1.4 stub fixture ${label}\n`);
}

type Person = {
  role: string;
  name: string;
  days: Array<{ date: string; codes: string[] }>;
};

type PayloadSpec = {
  pdfSha?: string;
  pdfBytes?: Uint8Array;
  department?: string;
  source_file_name?: string;
  date_range?: { start: string; end: string };
  months?: Array<{ year: number; month: number; days_covered: number[] }>;
  people: Person[];
};

async function buildPayload(spec: PayloadSpec): Promise<{
  payload: Record<string, unknown>;
  hashes: Map<string, Person>;
}> {
  const dept = spec.department ?? DEPT;
  const hashes = new Map<string, Person>();
  const peopleOut = [];
  for (const p of spec.people) {
    const h = await personHash(dept, p.name);
    hashes.set(h, p);
    peopleOut.push({
      role: p.role,
      name: p.name,
      person_hash: h,
      days: p.days,
    });
  }
  const pdf = spec.pdfBytes ?? pdfBytes("pdf-a");
  const pdfSha = spec.pdfSha ?? (await sha256Hex(pdf));
  const payload = {
    department: dept,
    pdf_sha256: pdfSha,
    source_file_name: spec.source_file_name ?? "shifts.pdf",
    date_range: spec.date_range ?? { start: "2026-05-01", end: "2026-05-31" },
    months: spec.months ?? [{ year: 2026, month: 5, days_covered: [15] }],
    people: peopleOut,
  };
  return { payload, hashes };
}

type FormOpts = {
  payload: Record<string, unknown> | string;
  pdf?: { bytes: Uint8Array; type?: string; filename?: string } | null;
  rows?: Array<{ hash: string; bytes?: Uint8Array; type?: string; filename?: string }>;
  contentType?: string;
};

async function postUpload(opts: FormOpts): Promise<Response> {
  // NB: Bun's FormData serializer overrides the Blob's `type` when the
  // filename has a recognized extension (e.g. `.pdf` → `application/pdf`).
  // To exercise the 415 paths, callers can pass a non-suggestive filename
  // (e.g. `.bin`) so the explicit `type` is preserved on the wire.
  const form = new FormData();
  if (opts.payload !== undefined) {
    const payloadText =
      typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload);
    form.append("payload", new Blob([payloadText], { type: "application/json" }), "payload.json");
  }
  if (opts.pdf !== null && opts.pdf !== undefined) {
    form.append(
      "pdf",
      new Blob([opts.pdf.bytes as unknown as BlobPart], {
        type: opts.pdf.type ?? "application/pdf",
      }),
      opts.pdf.filename ?? "shifts.pdf",
    );
  }
  for (const row of opts.rows ?? []) {
    form.append(
      `row_${row.hash}`,
      new Blob([(row.bytes ?? pngBytes()) as unknown as BlobPart], {
        type: row.type ?? "image/png",
      }),
      row.filename ?? `row_${row.hash}.png`,
    );
  }
  return fetch(`${baseUrl}/api/upload`, { method: "POST", body: form });
}

async function postHappy(spec: PayloadSpec): Promise<{
  res: Response;
  body: any;
  hashes: Map<string, Person>;
  pdfSha: string;
}> {
  const pdf = spec.pdfBytes ?? pdfBytes("pdf-a");
  const built = await buildPayload({ ...spec, pdfBytes: pdf });
  const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
  const res = await postUpload({
    payload: built.payload,
    pdf: { bytes: pdf },
    rows,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { res, body, hashes: built.hashes, pdfSha: built.payload.pdf_sha256 as string };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("happy path", () => {
  test("1 person, 1 shift → 200 + files on disk", async () => {
    const { res, body, hashes, pdfSha } = await postHappy({
      people: [
        { role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(body.feeds).toHaveLength(1);
    expect(body.feeds[0].name).toBe("Klug, J");
    expect(body.feeds[0].role).toBe("ma");
    expect(body.feeds[0].person_hash).toBe("79897ea12fbe8e91");
    expect(body.feeds[0].webcal_url).toBe(
      "webcal://localhost:3001/feed/79897ea12fbe8e91.ics",
    );
    expect(body.unknown_codes).toEqual([]);

    const hash = Array.from(hashes.keys())[0]!;
    const ics = await readFile(join(env.dataDir, "feeds", `${hash}.ics`), "utf-8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;TZID=Europe/Zurich:20260515T071500");

    const manifest = JSON.parse(
      await readFile(join(env.dataDir, "manifest", `${hash}.json`), "utf-8"),
    );
    expect(manifest.name).toBe("Klug, J");
    expect(manifest.last_pdf_sha256).toBe(pdfSha);

    const sourcePdf = await readFile(join(env.dataDir, "sources", `${pdfSha}.pdf`));
    expect(sourcePdf.length).toBeGreaterThan(0);

    const rowPng = await readFile(
      join(env.dataDir, "rows", pdfSha, `${hash}.png`),
    );
    expect(rowPng.length).toBeGreaterThan(0);
  });
});

describe("400 — schema", () => {
  test("missing department", async () => {
    const res = await postUpload({
      payload: { pdf_sha256: "x", people: [] },
      pdf: { bytes: pdfBytes() },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("schema");
  });

  test("payload is not valid JSON", async () => {
    const res = await postUpload({
      payload: "not json",
      pdf: { bytes: pdfBytes() },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("schema");
  });

  test("days.length != months days_covered sum", async () => {
    const built = await buildPayload({
      people: [
        {
          role: "ma",
          name: "Klug, J",
          // months covers day 15, but person has TWO days
          days: [
            { date: "2026-05-15", codes: ["C2"] },
            { date: "2026-05-16", codes: ["C2"] },
          ],
        },
      ],
    });
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("schema");
  });
});

describe("400 — missing_part", () => {
  test("payload absent", async () => {
    const res = await postUpload({
      payload: undefined as unknown as Record<string, unknown>,
      pdf: { bytes: pdfBytes() },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_part");
  });

  test("pdf absent", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const res = await postUpload({ payload: built.payload, pdf: null });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_part");
  });

  test("person without matching row", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows: [], // no rows
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_part");
  });

  test("orphan row_*", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const goodHash = Array.from(built.hashes.keys())[0]!;
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows: [
        { hash: goodHash },
        { hash: "0000000000000000" }, // orphan
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_part");
  });
});

describe("400 — hash_mismatch", () => {
  test("submitted person_hash differs from server-derived", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    // Corrupt the submitted hash.
    const tampered = JSON.parse(JSON.stringify(built.payload));
    const realHash = tampered.people[0].person_hash;
    tampered.people[0].person_hash = "ffffffffffffffff";
    const res = await postUpload({
      payload: tampered,
      pdf: { bytes: pdfBytes() },
      rows: [{ hash: realHash }, { hash: "ffffffffffffffff" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("hash_mismatch");
  });
});

describe("400 — hash_collision", () => {
  test("two persons normalize to the same hash", async () => {
    // "Klug, J" and "klug,   j." both normalize to "klug, j".
    const built = await buildPayload({
      people: [
        { role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] },
        { role: "ma", name: "klug,   j.", days: [{ date: "2026-05-15", codes: ["L3"] }] },
      ],
    });
    // buildPayload computed the same hash for both — only one row would map.
    // The server must reject with hash_collision before any write.
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("hash_collision");
  });
});

describe("400 — pdf_hash_mismatch", () => {
  test("claimed sha != actual bytes", async () => {
    const pdf = pdfBytes("pdf-a");
    const wrongSha = "0".repeat(64);
    const built = await buildPayload({
      pdfSha: wrongSha,
      pdfBytes: pdf,
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdf },
      rows,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("pdf_hash_mismatch");
  });
});

describe("400 — department_mismatch", () => {
  test("payload.department != env.departmentSlug", async () => {
    const built = await buildPayload({
      department: "wrong-dept",
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("department_mismatch");
  });
});

describe("415 — bad content types", () => {
  test("request Content-Type not multipart", async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  test("pdf part has Content-Type application/octet-stream", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes(), type: "application/octet-stream", filename: "shifts.bin" },
      rows,
    });
    expect(res.status).toBe(415);
  });

  test("row part has Content-Type image/jpeg", async () => {
    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const h = Array.from(built.hashes.keys())[0]!;
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows: [{ hash: h, type: "image/jpeg", filename: `row_${h}.bin` }],
    });
    expect(res.status).toBe(415);
  });
});

describe("413 — body too large", () => {
  test("body over maxUploadBytes rejected without writing", async () => {
    // Shrink the cap on a freshly-spun server. Stop the default one, start a tiny one.
    server.stop(true);
    env = { ...env, maxUploadBytes: 256 };
    server = createServer(env);
    baseUrl = `http://localhost:${server.port}`;

    const built = await buildPayload({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const rows = Array.from(built.hashes.keys()).map((h) => ({ hash: h }));
    const res = await postUpload({
      payload: built.payload,
      pdf: { bytes: pdfBytes() },
      rows,
    });
    expect(res.status).toBe(413);
    // Assert no files written.
    const feeds = await readdir(join(env.dataDir, "feeds"));
    expect(feeds).toEqual([]);
  });
});

describe("multi-month merge", () => {
  test("upload April then May → final .ics contains both months", async () => {
    const aprilPdf = pdfBytes("april");
    const mayPdf = pdfBytes("may");

    const first = await postHappy({
      pdfBytes: aprilPdf,
      date_range: { start: "2026-04-01", end: "2026-04-30" },
      months: [{ year: 2026, month: 4, days_covered: [15] }],
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-04-15", codes: ["C2"] }] }],
    });
    expect(first.res.status).toBe(200);

    const second = await postHappy({
      pdfBytes: mayPdf,
      date_range: { start: "2026-05-01", end: "2026-05-31" },
      months: [{ year: 2026, month: 5, days_covered: [20] }],
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-20", codes: ["L3"] }] }],
    });
    expect(second.res.status).toBe(200);

    const ics = await readFile(
      join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
      "utf-8",
    );
    expect(ics).toContain("DTSTART;TZID=Europe/Zurich:20260415");
    expect(ics).toContain("DTSTART;TZID=Europe/Zurich:20260520");
  });
});

describe("semantic idempotence", () => {
  test("same payload twice → same VEVENT structure (DTSTAMP may differ)", async () => {
    const spec: PayloadSpec = {
      people: [
        {
          role: "ma",
          name: "Klug, J",
          days: [{ date: "2026-05-15", codes: ["C2"] }],
        },
      ],
    };
    const first = await postHappy(spec);
    expect(first.res.status).toBe(200);
    const ics1 = await readFile(
      join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
      "utf-8",
    );

    const second = await postHappy(spec);
    expect(second.res.status).toBe(200);
    const ics2 = await readFile(
      join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
      "utf-8",
    );

    const evCount = (s: string) => (s.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(evCount(ics1)).toBe(evCount(ics2));
    expect(evCount(ics1)).toBe(1);

    const uidOf = (s: string) => s.match(/UID:([^\r\n]+)/)![1];
    expect(uidOf(ics1)).toBe(uidOf(ics2));

    const dtstartOf = (s: string) => s.match(/DTSTART[^\r\n]*/)![0];
    const dtendOf = (s: string) => s.match(/DTEND[^\r\n]*/)![0];
    const summaryOf = (s: string) => s.match(/SUMMARY:[^\r\n]*/)![0];
    expect(dtstartOf(ics1)).toBe(dtstartOf(ics2));
    expect(dtendOf(ics1)).toBe(dtendOf(ics2));
    expect(summaryOf(ics1)).toBe(summaryOf(ics2));

    expect(first.body.feeds[0].webcal_url).toBe(second.body.feeds[0].webcal_url);
  });
});

describe("empty-days person", () => {
  test("person with only skip codes → valid VCALENDAR, 0 VEVENTs", async () => {
    const { res } = await postHappy({
      people: [
        {
          role: "ma",
          name: "Klug, J",
          days: [{ date: "2026-05-15", codes: ["X"] }], // skip
        },
      ],
    });
    expect(res.status).toBe(200);
    const ics = await readFile(
      join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
      "utf-8",
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics.match(/BEGIN:VEVENT/g)).toBeNull();
  });
});

describe("orphan sweep at startup", () => {
  test("planted .tmp files are unlinked", async () => {
    // Plant orphans in this run's dataDir.
    await writeFile(join(env.dataDir, "feeds", "deadbeefdeadbeef.ics.tmp"), "garbage");
    await writeFile(
      join(env.dataDir, "manifest", "deadbeefdeadbeef.json.tmp"),
      "garbage",
    );
    const count = await orphanSweep(env);
    expect(count).toBe(2);
    expect(await readdir(join(env.dataDir, "feeds"))).toEqual([]);
    expect(await readdir(join(env.dataDir, "manifest"))).toEqual([]);
  });
});

describe("manifest failure isolation", () => {
  test("manifest write failure → 200 + .ics on disk", async () => {
    // Sabotage: chmod manifest dir to read-only. Bun runs as the user, so
    // chmod 555 prevents new files. After the test, afterEach restores by
    // rm -rf.
    const { chmod } = await import("node:fs/promises");
    const happy = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(happy.res.status).toBe(200);
    // Now lock manifest dir and retry — second upload should still 200.
    await chmod(join(env.dataDir, "manifest"), 0o555);
    try {
      const second = await postHappy({
        people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["L3"] }] }],
      });
      expect(second.res.status).toBe(200);
      const ics = await readFile(
        join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
        "utf-8",
      );
      expect(ics).toContain("SUMMARY:Long shift\\, unit 3");
    } finally {
      await chmod(join(env.dataDir, "manifest"), 0o755);
    }
  });
});

describe("concurrent uploads serialize", () => {
  test("two fetches in parallel both 200; final ics matches second", async () => {
    const pdfA = pdfBytes("a");
    const pdfB = pdfBytes("b");
    const a = buildPayload({
      pdfBytes: pdfA,
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const b = buildPayload({
      pdfBytes: pdfB,
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["L3"] }] }],
    });
    const [ba, bb] = await Promise.all([a, b]);
    const rowsA = Array.from(ba.hashes.keys()).map((h) => ({ hash: h }));
    const rowsB = Array.from(bb.hashes.keys()).map((h) => ({ hash: h }));

    // Fire both without awaiting in sequence; the mutex must serialize them.
    const [resA, resB] = await Promise.all([
      postUpload({ payload: ba.payload, pdf: { bytes: pdfA }, rows: rowsA }),
      postUpload({ payload: bb.payload, pdf: { bytes: pdfB }, rows: rowsB }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Final .ics is whichever completed last. Both produce exactly one VEVENT
    // on 2026-05-15; assert one of the two SUMMARY values is present.
    const ics = await readFile(
      join(env.dataDir, "feeds", "79897ea12fbe8e91.ics"),
      "utf-8",
    );
    const hasC2 = ics.includes("SUMMARY:Day shift\\, unit 2");
    const hasL3 = ics.includes("SUMMARY:Long shift\\, unit 3");
    expect(hasC2 || hasL3).toBe(true);
    expect(hasC2 && hasL3).toBe(false); // mutex prevented interleaving
  });
});

describe("corrupt existing .ics", () => {
  test("truncated feed → merge falls back to fresh-only, 200, no throw", async () => {
    const hash = "79897ea12fbe8e91";
    // Plant a corrupt feed for this person.
    await writeFile(join(env.dataDir, "feeds", `${hash}.ics`), "BEGIN:VCALENDAR\r\n");
    const { res } = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(res.status).toBe(200);
    const ics = await readFile(join(env.dataDir, "feeds", `${hash}.ics`), "utf-8");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("DTSTART;TZID=Europe/Zurich:20260515");
  });
});

describe("webcal_url construction", () => {
  test("https base URL", async () => {
    server.stop(true);
    env = { ...env, baseUrl: "https://pdf2calendar.example.com" };
    server = createServer(env);
    baseUrl = `http://localhost:${server.port}`;
    const { body } = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(body.feeds[0].webcal_url).toBe(
      "webcal://pdf2calendar.example.com/feed/79897ea12fbe8e91.ics",
    );
  });

  test("http base URL", async () => {
    const { body } = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(body.feeds[0].webcal_url).toBe(
      "webcal://localhost:3001/feed/79897ea12fbe8e91.ics",
    );
  });
});

describe("unknown_codes shape", () => {
  test("raw °/* preserved; sorted, deduplicated; logged with triples", async () => {
    const { res, body } = await postHappy({
      people: [
        {
          role: "ma",
          name: "Klug, J",
          days: [
            { date: "2026-05-15", codes: ["°C2", "ZZZ", "ZZZ", "C2"] },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    // °C2 is known via prefix-strip rule in isKnownCode; ZZZ is unknown.
    expect(body.unknown_codes).toEqual(["ZZZ"]);

    const log = await readFile(join(env.dataDir, "unknown-codes.log"), "utf-8");
    const lines = log.trim().split("\n");
    // Two ZZZ occurrences → two log lines.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\tZZZ\t79897ea12fbe8e91\t2026-05-15");
  });
});

describe("response order", () => {
  test("feeds[i] matches payload.people[i] in PDF order", async () => {
    const { body } = await postHappy({
      people: [
        { role: "ma", name: "Baldwin, J", days: [{ date: "2026-05-15", codes: ["C2"] }] },
        { role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["L3"] }] },
        { role: "ca", name: "Smith, A", days: [{ date: "2026-05-15", codes: ["V"] }] },
      ],
    });
    expect(body.feeds.map((f: any) => f.name)).toEqual([
      "Baldwin, J",
      "Klug, J",
      "Smith, A",
    ]);
  });
});

describe("/healthz", () => {
  test("GET /healthz → 200 ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("/api/manifest — empty data dir", () => {
  test("GET → 200 with empty arrays + correct headers", async () => {
    const res = await fetch(`${baseUrl}/api/manifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.schema_version).toBe(2);
    expect(body.department_slug).toBe(DEPT);
    expect(body.latest_plan).toBeNull();
    expect(body.plans).toEqual([]);
    expect(body.staff).toEqual([]);
  });
});

describe("plans/<sha>.json + V2 manifest", () => {
  test("upload writes plans/<sha>.json with schema_version 2", async () => {
    const { res, pdfSha } = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(res.status).toBe(200);
    const planFile = JSON.parse(
      await readFile(join(env.dataDir, "plans", `${pdfSha}.json`), "utf-8"),
    );
    expect(planFile.schema_version).toBe(2);
    expect(planFile.pdf_sha256).toBe(pdfSha);
    expect(planFile.original_filename).toBe("shifts.pdf");
    expect(planFile.months).toEqual([{ year: 2026, month: 5, days_covered: [15] }]);
    expect(planFile.person_hashes).toEqual(["79897ea12fbe8e91"]);
  });

  test("re-upload same sha overwrites plan file atomically (idempotent)", async () => {
    const first = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(first.res.status).toBe(200);
    const second = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["L3"] }] }],
    });
    expect(second.res.status).toBe(200);
    // Same sha → still one plan file.
    const planFiles = await readdir(join(env.dataDir, "plans"));
    expect(planFiles.filter((f) => !f.endsWith(".tmp"))).toHaveLength(1);
  });

  test("manifest is V2 shape with entries[] replace-wholesale on re-upload of same sha", async () => {
    const { pdfSha } = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    const hash = "79897ea12fbe8e91";
    const after1 = JSON.parse(
      await readFile(join(env.dataDir, "manifest", `${hash}.json`), "utf-8"),
    );
    expect(after1.schema_version).toBe(2);
    expect(after1.entries).toHaveLength(1);
    expect(after1.entries[0].pdf_sha256).toBe(pdfSha);
    // V1 fields kept for read compatibility.
    expect(after1.last_pdf_sha256).toBe(pdfSha);

    // Re-upload same sha with different codes — entries[] replaced wholesale.
    await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["L3"] }] }],
    });
    const after2 = JSON.parse(
      await readFile(join(env.dataDir, "manifest", `${hash}.json`), "utf-8"),
    );
    expect(after2.entries).toHaveLength(1);
    expect(after2.entries[0].pdf_sha256).toBe(pdfSha);
  });

  test("entries[] grows when a different sha is uploaded", async () => {
    await postHappy({
      pdfBytes: pdfBytes("april"),
      date_range: { start: "2026-04-01", end: "2026-04-30" },
      months: [{ year: 2026, month: 4, days_covered: [15] }],
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-04-15", codes: ["C2"] }] }],
    });
    await postHappy({
      pdfBytes: pdfBytes("may"),
      date_range: { start: "2026-05-01", end: "2026-05-31" },
      months: [{ year: 2026, month: 5, days_covered: [20] }],
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-20", codes: ["L3"] }] }],
    });
    const hash = "79897ea12fbe8e91";
    const manifest = JSON.parse(
      await readFile(join(env.dataDir, "manifest", `${hash}.json`), "utf-8"),
    );
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.map((e: any) => e.months)).toEqual([
      [{ year: 2026, month: 4 }],
      [{ year: 2026, month: 5 }],
    ]);
  });
});

describe("/api/manifest cache invalidation", () => {
  test("GET reflects new plan after upload", async () => {
    let res = await fetch(`${baseUrl}/api/manifest`);
    expect(((await res.json()) as any).latest_plan).toBeNull();

    const happy = await postHappy({
      people: [{ role: "ma", name: "Klug, J", days: [{ date: "2026-05-15", codes: ["C2"] }] }],
    });
    expect(happy.res.status).toBe(200);

    res = await fetch(`${baseUrl}/api/manifest`);
    const body = (await res.json()) as any;
    expect(body.latest_plan).not.toBeNull();
    expect(body.latest_plan.pdf_sha256).toBe(happy.pdfSha);
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0].name).toBe("Klug, J");
    expect(body.staff[0].entries[0].pdf_sha256).toBe(happy.pdfSha);
  });
});

describe("/api/manifest — populated fixture", () => {
  test("GET → returns plan + staff joined with row_url + feed_url", async () => {
    const planJson = {
      schema_version: 2,
      pdf_sha256: "abc",
      original_filename: "Plan_Mai.pdf",
      uploaded_at: "2026-05-01T10:00:00.000Z",
      months: [{ year: 2026, month: 5, days_covered: [1, 2, 3] }],
      person_hashes: ["1111111111111111"],
    };
    await writeFile(
      join(env.dataDir, "plans", "abc.json"),
      JSON.stringify(planJson),
    );

    const personJson = {
      schema_version: 2,
      name: "Klug, J",
      role: "ma",
      last_uploaded_at: "2026-05-01T10:00:00.000Z",
      last_pdf_sha256: "abc",
      last_date_range: { start: "2026-05-01", end: "2026-05-31" },
      entries: [
        {
          pdf_sha256: "abc",
          original_filename: "Plan_Mai.pdf",
          uploaded_at: "2026-05-01T10:00:00.000Z",
          months: [{ year: 2026, month: 5 }],
        },
      ],
    };
    await writeFile(
      join(env.dataDir, "manifest", "1111111111111111.json"),
      JSON.stringify(personJson),
    );

    const res = await fetch(`${baseUrl}/api/manifest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest_plan).not.toBeNull();
    expect(body.latest_plan.pdf_sha256).toBe("abc");
    expect(body.latest_plan.original_filename).toBe("Plan_Mai.pdf");
    expect(body.plans).toHaveLength(1);
    expect(body.staff).toHaveLength(1);
    const s = body.staff[0];
    expect(s.person_hash).toBe("1111111111111111");
    expect(s.name).toBe("Klug, J");
    expect(s.feed_url).toBe(
      `${env.baseUrl}/feed/1111111111111111.ics`,
    );
    expect(s.entries[0].row_url).toBe(
      `${env.baseUrl}/source/abc/1111111111111111.png`,
    );
  });

  test("V1-shaped manifest (no schema_version) is silently absent from staff[]", async () => {
    await writeFile(
      join(env.dataDir, "manifest", "1111111111111111.json"),
      JSON.stringify({
        name: "Legacy, V",
        role: "ma",
        last_uploaded_at: "2026-04-01T10:00:00.000Z",
        last_pdf_sha256: "old",
        last_date_range: { start: "2026-04-01", end: "2026-04-30" },
      }),
    );
    const res = await fetch(`${baseUrl}/api/manifest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff).toEqual([]);
  });
});
