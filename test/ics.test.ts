// Spec-driven tests for the iCalendar generator. See docs/ics-spec.md §"Test plan".

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { generate, IcsError, type GenerateInput } from "../src/ics.ts";
import { codes as V1, type Code } from "../src/codes.ts";
import type { ParsedPerson } from "../src/types.ts";
import { parse } from "../src/parser.ts";

const MARS_AVRIL = "example_data/5_Mars2026_26.03_30.04.2026.pdf";

const PERSON_HASH = "0123456789abcdef";
const PDF_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE_URL = "https://pdf2calendar.example.com";
const UPLOADED = new Date(Date.UTC(2026, 3, 15, 10, 30, 0)); // 2026-04-15T10:30:00Z

const encoder = new TextEncoder();

function makePerson(days: Array<{ date: string; codes: string[] }>): ParsedPerson {
  return {
    role: "ma",
    name: "Test, Person",
    days,
    row_band: { page: 1, y_top: 100, y_bottom: 80 },
  };
}

function makeInput(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return {
    person: makePerson([]),
    person_hash: PERSON_HASH,
    codes: V1,
    source: {
      file_name: "test.pdf",
      uploaded_at: UPLOADED,
      pdf_sha256: PDF_SHA,
      base_url: BASE_URL,
    },
    ...overrides,
  };
}

// Pull a single VEVENT block out of the output (or null if none).
function vevents(ics: string): string[] {
  const out: string[] = [];
  const lines = ics.split("\r\n");
  let buf: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") buf = [line];
    else if (line === "END:VEVENT" && buf) {
      buf.push(line);
      out.push(buf.join("\r\n"));
      buf = null;
    } else if (buf) buf.push(line);
  }
  return out;
}

describe("generate(): per-event shapes", () => {
  test("single timed event, day shift (C2 on 2026-04-15)", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-15", codes: ["C2"] }]) }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("UID:0123456789abcdef-20260415-0@pdf2calendar");
    expect(evs[0]).toContain("DTSTART;TZID=Europe/Zurich:20260415T071500");
    expect(evs[0]).toContain("DTEND;TZID=Europe/Zurich:20260415T173000");
    expect(evs[0]).toContain("SUMMARY:Day shift\\, unit 2");
    expect(evs[0]).toContain("STATUS:CONFIRMED");
    expect(evs[0]).toContain("TRANSP:OPAQUE");
    expect(evs[0]).toContain("DTSTAMP:20260415T103000Z");
  });

  test("night shift crosses midnight (Nw13 on 2026-04-18)", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-18", codes: ["Nw13"] }]) }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    // UID uses the START day, even for a shift ending the next day.
    expect(evs[0]).toContain("UID:0123456789abcdef-20260418-0@pdf2calendar");
    expect(evs[0]).toContain("DTSTART;TZID=Europe/Zurich:20260418T200000");
    expect(evs[0]).toContain("DTEND;TZID=Europe/Zurich:20260419T083000");
  });

  test("all-day event (V on 2026-04-19) — exclusive DTEND", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-19", codes: ["V"] }]) }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("DTSTART;VALUE=DATE:20260419");
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20260420");
    expect(evs[0]).toContain("SUMMARY:Vacation");
  });

  test("skip code (X) emits no event", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-15", codes: ["X"] }]) }),
    );
    expect(vevents(ics)).toHaveLength(0);
  });

  test("unknown code → all-day Unknown: XYZ123 with STATUS:TENTATIVE", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-15", codes: ["XYZ123"] }]) }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("SUMMARY:Unknown: XYZ123");
    expect(evs[0]).toContain("DTSTART;VALUE=DATE:20260415");
    expect(evs[0]).toContain("STATUS:TENTATIVE");
  });

  test("tentative prefix (°C2) → C2 event with STATUS:TENTATIVE", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-15", codes: ["°C2"] }]) }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("SUMMARY:Day shift\\, unit 2");
    expect(evs[0]).toContain("STATUS:TENTATIVE");
    expect(evs[0]).toContain("DTSTART;TZID=Europe/Zurich:20260415T071500");
  });

  test("multi-code cell → distinct UIDs by seq", () => {
    const ics = generate(
      makeInput({
        person: makePerson([{ date: "2026-04-18", codes: ["Nw13", "Nw13"] }]),
      }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(2);
    const uids = evs.map((e) => e.match(/UID:([^\r\n]+)/)![1]);
    expect(uids[0]).toBe("0123456789abcdef-20260418-0@pdf2calendar");
    expect(uids[1]).toBe("0123456789abcdef-20260418-1@pdf2calendar");
    expect(new Set(uids).size).toBe(2);
  });

  test("escaping: comma, semicolon, backslash, UTF-8 preserved", () => {
    const customCodes: Record<string, Code> = {
      ZX: { kind: "allday", title: "Surgery, Dr. Müller; AM \\ shift" },
    };
    const ics = generate(
      makeInput({
        person: makePerson([{ date: "2026-04-15", codes: ["ZX"] }]),
        codes: customCodes,
      }),
    );
    const evs = vevents(ics);
    expect(evs[0]).toContain("SUMMARY:Surgery\\, Dr. Müller\\; AM \\\\ shift");
  });

  test("empty person (all skips) → valid VCALENDAR with 0 VEVENTs", () => {
    const ics = generate(
      makeInput({
        person: makePerson([
          { date: "2026-04-15", codes: ["X"] },
          { date: "2026-04-16", codes: [] },
          { date: "2026-04-17", codes: ["MAL"] },
        ]),
      }),
    );
    expect(vevents(ics)).toHaveLength(0);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VTIMEZONE");
  });

  test("tombstone → STATUS:CANCELLED with the matching UID", () => {
    const ics = generate(
      makeInput({
        person: makePerson([]),
        tombstones: [{ date: "2026-04-19", seq: 0 }],
      }),
    );
    const evs = vevents(ics);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("UID:0123456789abcdef-20260419-0@pdf2calendar");
    expect(evs[0]).toContain("STATUS:CANCELLED");
    expect(evs[0]).toContain("SUMMARY:(cancelled)");
    expect(evs[0]).toContain("DTSTART;VALUE=DATE:20260419");
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20260420");
  });

  test("chronological order: sorted by DTSTART regardless of input order", () => {
    const ics = generate(
      makeInput({
        person: makePerson([
          { date: "2026-04-19", codes: ["C2"] },
          { date: "2026-04-15", codes: ["L3"] },
          { date: "2026-04-17", codes: ["V"] },
        ]),
      }),
    );
    const evs = vevents(ics);
    const starts = evs.map((e) => e.match(/DTSTART[^:]*:(\S+)/)![1]);
    expect(starts).toEqual([
      "20260415T071500",
      "20260417",
      "20260419T071500",
    ]);
  });
});

describe("generate(): line folding", () => {
  test("DESCRIPTION longer than 75 octets is folded with CRLF + space", () => {
    const ics = generate(
      makeInput({ person: makePerson([{ date: "2026-04-15", codes: ["C2"] }]) }),
    );
    expect(ics).toContain("\r\n ");
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  test("UTF-8 multi-byte char is not split by folding", () => {
    // Build a long title containing 'ü' (2 bytes) to force a split near it.
    const customCodes: Record<string, Code> = {
      ZX: {
        kind: "allday",
        title: "x".repeat(70) + "ü" + "y".repeat(70),
      },
    };
    const ics = generate(
      makeInput({
        person: makePerson([{ date: "2026-04-15", codes: ["ZX"] }]),
        codes: customCodes,
      }),
    );
    // ü must appear intact somewhere in the output.
    expect(ics).toContain("ü");
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("generate(): structural invariants", () => {
  function assertWellFormed(ics: string): void {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VTIMEZONE\r\nTZID:Europe/Zurich");
    expect(ics).toContain("END:VTIMEZONE");
    expect(ics.endsWith("\r\n")).toBe(true);

    const lines = ics.split("\r\n");
    for (const line of lines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }

    // UID format + uniqueness
    const uidRe = /^[0-9a-f]{16}-\d{8}-\d+@pdf2calendar$/;
    const uids: string[] = [];
    for (const ev of vevents(ics)) {
      const m = ev.match(/UID:([^\r\n]+)/);
      expect(m).not.toBeNull();
      expect(uidRe.test(m![1]!)).toBe(true);
      uids.push(m![1]!);

      // Required fields
      expect(ev).toContain("DTSTAMP:");
      expect(ev).toContain("DTSTART");
      expect(ev).toContain("DTEND");
      expect(ev).toContain("SUMMARY:");
      expect(ev).toContain("DESCRIPTION:");
      expect(ev).toContain("STATUS:");
    }
    expect(new Set(uids).size).toBe(uids.length);
  }

  test("synthetic input passes structural checks", () => {
    const ics = generate(
      makeInput({
        person: makePerson([
          { date: "2026-04-15", codes: ["C2"] },
          { date: "2026-04-18", codes: ["Nw13", "Nw13"] },
          { date: "2026-04-19", codes: ["V"] },
          { date: "2026-04-20", codes: ["°L3"] },
        ]),
        tombstones: [{ date: "2026-04-21", seq: 0 }],
      }),
    );
    assertWellFormed(ics);
  });

  test("stable output: same input → byte-for-byte identical", () => {
    const a = generate(
      makeInput({
        person: makePerson([
          { date: "2026-04-15", codes: ["C2"] },
          { date: "2026-04-18", codes: ["Nw13"] },
        ]),
      }),
    );
    const b = generate(
      makeInput({
        person: makePerson([
          { date: "2026-04-15", codes: ["C2"] },
          { date: "2026-04-18", codes: ["Nw13"] },
        ]),
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatchSnapshot();
  });
});

describe("generate(): validation errors", () => {
  test("invalid_person_hash: not 16 hex chars", () => {
    expect(() => generate(makeInput({ person_hash: "nothex" }))).toThrow(IcsError);
    expect(() => generate(makeInput({ person_hash: "0123456789ABCDEF" }))).toThrow(IcsError);
  });

  test("invalid_pdf_sha256: not 64 hex chars", () => {
    expect(() =>
      generate(
        makeInput({
          source: {
            file_name: "x.pdf",
            uploaded_at: UPLOADED,
            pdf_sha256: "tooshort",
            base_url: BASE_URL,
          },
        }),
      ),
    ).toThrow(IcsError);
  });

  test("invalid_base_url: missing scheme or trailing slash", () => {
    expect(() =>
      generate(
        makeInput({
          source: {
            file_name: "x.pdf",
            uploaded_at: UPLOADED,
            pdf_sha256: PDF_SHA,
            base_url: "pdf2calendar.example.com",
          },
        }),
      ),
    ).toThrow(IcsError);
    expect(() =>
      generate(
        makeInput({
          source: {
            file_name: "x.pdf",
            uploaded_at: UPLOADED,
            pdf_sha256: PDF_SHA,
            base_url: "https://pdf2calendar.example.com/",
          },
        }),
      ),
    ).toThrow(IcsError);
  });

  test("invalid_time_format: code with bad start/end string", () => {
    const bad: Record<string, Code> = {
      BAD: { kind: "timed", title: "broken", start: "8:00", end: "17:00" },
    };
    expect(() => generate(makeInput({ codes: bad }))).toThrow(IcsError);
  });
});

describe("generate(): integration with parser", () => {
  test("two-month PDF: Klug, J round-trips through generate", async () => {
    const buf = new Uint8Array(await readFile(resolve(MARS_AVRIL)));
    const r = await parse(buf, { file_name: MARS_AVRIL });
    const klug = r.people.find((p) => p.name === "Klug, J");
    expect(klug).toBeDefined();

    const ics = generate({
      person: klug!,
      person_hash: PERSON_HASH,
      codes: V1,
      source: {
        file_name: MARS_AVRIL,
        uploaded_at: UPLOADED,
        pdf_sha256: PDF_SHA,
        base_url: BASE_URL,
      },
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics.endsWith("\r\n")).toBe(true);
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }

    expect(ics).toMatchSnapshot();
  });
});
