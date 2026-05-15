// State machine — pure transitions and pre-flight checks. No DOM.
// See docs/frontend-spec.md § UI state machine + § Test plan.

import { describe, expect, test } from "bun:test";

import {
  canDrop,
  initialState,
  reset,
  toError,
  toHashing,
  toParsing,
  toRenderingRows,
  toSuccess,
  toUploading,
  validateFile,
  type State,
} from "./state.ts";
import type { ParseResult } from "../src/types.ts";
import type { UploadResponse } from "./api.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────

const fakeFile = (
  name = "shift.pdf",
  size = 100,
  type = "application/pdf",
): File =>
  new File([new Uint8Array(size)], name, { type });

const fakeParsed: ParseResult = {
  source: {
    file_name: "shift.pdf",
    page_count: 1,
    parsed_at: "2026-05-15T00:00:00.000Z",
    page_dims: [{ page: 1, width: 800, height: 600 }],
  },
  department: null,
  date_range: { start: "2026-05-01", end: "2026-05-31" },
  header_band: { page: 1, y_top: 580, y_bottom: 540 },
  months: [{ year: 2026, month: 5, days_covered: [1, 2, 3] }],
  people: [
    {
      role: "ma",
      name: "Klug, J",
      days: [],
      row_band: { page: 1, y_top: 510, y_bottom: 490 },
    },
  ],
  unknown_codes: [],
  warnings: [],
};

const fakeRows = new Map<string, Blob>([
  ["0123456789abcdef", new Blob([new Uint8Array(10)], { type: "image/png" })],
]);

const fakeResponse: UploadResponse = {
  feeds: [
    {
      name: "Klug, J",
      role: "ma",
      person_hash: "0123456789abcdef",
      webcal_url: "webcal://example.com/feed/0123456789abcdef.ics",
    },
  ],
  unknown_codes: [],
};

// ─── canDrop ─────────────────────────────────────────────────────────────

describe("canDrop", () => {
  test("true only when idle", () => {
    expect(canDrop({ stage: "idle" })).toBe(true);
    expect(canDrop({ stage: "parsing", file: fakeFile() })).toBe(false);
    expect(
      canDrop({
        stage: "rendering_rows",
        file: fakeFile(),
        parsed: fakeParsed,
      }),
    ).toBe(false);
    expect(canDrop({ stage: "error", from_stage: "parsing", cause: { kind: "network" } })).toBe(false);
    expect(
      canDrop({
        stage: "success",
        result: fakeResponse,
        rows: fakeRows,
        parsed: fakeParsed,
        fileName: "shift.pdf",
      }),
    ).toBe(false);
  });
});

// ─── validateFile ────────────────────────────────────────────────────────

describe("validateFile", () => {
  test("accepts a small PDF", () => {
    const r = validateFile(fakeFile("shift.pdf", 1024, "application/pdf"));
    expect(r.ok).toBe(true);
  });

  test("rejects wrong MIME and wrong extension", () => {
    const r = validateFile(fakeFile("notes.txt", 100, "text/plain"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_type");
  });

  test("accepts .pdf extension even with empty type", () => {
    const r = validateFile(fakeFile("shift.pdf", 100, ""));
    expect(r.ok).toBe(true);
  });

  test("rejects >5 MB PDFs", () => {
    const r = validateFile(
      fakeFile("huge.pdf", 5 * 1024 * 1024 + 1, "application/pdf"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });
});

// ─── transitions ─────────────────────────────────────────────────────────

describe("toParsing", () => {
  test("idle → parsing", () => {
    const s = toParsing(initialState, fakeFile());
    expect(s.stage).toBe("parsing");
  });

  test("drop-while-busy: no-op when not idle", () => {
    const busy: State = { stage: "parsing", file: fakeFile() };
    const s = toParsing(busy, fakeFile("other.pdf"));
    expect(s).toBe(busy);
  });
});

describe("happy-path chain", () => {
  test("parsing → rendering_rows → hashing → uploading → success", () => {
    let s: State = toParsing(initialState, fakeFile());
    s = toRenderingRows(s, fakeParsed);
    expect(s.stage).toBe("rendering_rows");
    s = toHashing(s, fakeRows);
    expect(s.stage).toBe("hashing");
    if (s.stage !== "hashing") throw new Error("nope");
    expect(s.rows).toBe(fakeRows);
    s = toUploading(s, "a".repeat(64));
    expect(s.stage).toBe("uploading");
    if (s.stage !== "uploading") throw new Error("nope");
    expect(s.pdf_sha256).toBe("a".repeat(64));
    s = toSuccess(s, fakeResponse);
    expect(s.stage).toBe("success");
    if (s.stage !== "success") throw new Error("nope");
    expect(s.result).toBe(fakeResponse);
    expect(s.rows).toBe(fakeRows);
    expect(s.fileName).toBe("shift.pdf");
  });

  test("each transition no-ops if called from the wrong prior stage", () => {
    expect(toRenderingRows(initialState, fakeParsed)).toBe(initialState);
    expect(toHashing(initialState, fakeRows)).toBe(initialState);
    expect(toUploading(initialState, "x")).toBe(initialState);
    expect(toSuccess(initialState, fakeResponse)).toBe(initialState);
  });
});

describe("toError", () => {
  test("records from_stage when transitioning from a busy stage", () => {
    const busy: State = { stage: "rendering_rows", file: fakeFile(), parsed: fakeParsed };
    const s = toError(busy, { kind: "network" });
    expect(s.stage).toBe("error");
    if (s.stage !== "error") throw new Error("nope");
    expect(s.from_stage).toBe("rendering_rows");
    expect(s.cause).toEqual({ kind: "network" });
  });

  test("no-op from idle / success / error", () => {
    expect(toError(initialState, { kind: "network" })).toBe(initialState);
    const success: State = {
      stage: "success",
      result: fakeResponse,
      rows: fakeRows,
      parsed: fakeParsed,
      fileName: "shift.pdf",
    };
    expect(toError(success, { kind: "network" })).toBe(success);
    const errored: State = {
      stage: "error",
      from_stage: "parsing",
      cause: { kind: "network" },
    };
    expect(toError(errored, { kind: "http_500" })).toBe(errored);
  });
});

describe("reset", () => {
  test("any state → idle", () => {
    expect(reset(initialState)).toEqual({ stage: "idle" });
    expect(
      reset({
        stage: "success",
        result: fakeResponse,
        rows: fakeRows,
        parsed: fakeParsed,
        fileName: "shift.pdf",
      }),
    ).toEqual({ stage: "idle" });
    expect(
      reset({ stage: "error", from_stage: "parsing", cause: { kind: "network" } }),
    ).toEqual({ stage: "idle" });
  });
});
