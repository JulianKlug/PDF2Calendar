// State machine — pure transitions and pre-flight checks. No DOM.
// See docs/v2-spec.md § Frontend changes / State machine and
// § Verification step 15.

import { describe, expect, test } from "bun:test";

import {
  canDrop,
  initialState,
  reset,
  toAuthPrompt,
  toConfirmOverwrite,
  toError,
  toHashing,
  toIdleUpload,
  toLanding,
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

const PW = "hunter2";

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

// Build a state at a given stage with admin_password already threaded.
function freshIdleUpload(): State {
  return { stage: "idle_upload", admin_password: PW };
}

// ─── initialState ────────────────────────────────────────────────────────

describe("initialState", () => {
  test("is landing", () => {
    expect(initialState).toEqual({ stage: "landing" });
  });
});

// ─── canDrop ─────────────────────────────────────────────────────────────

describe("canDrop", () => {
  test("true only when idle_upload", () => {
    expect(canDrop({ stage: "landing" })).toBe(false);
    expect(canDrop({ stage: "auth_prompt" })).toBe(false);
    expect(canDrop(freshIdleUpload())).toBe(true);
    expect(
      canDrop({ stage: "parsing", admin_password: PW, file: fakeFile() }),
    ).toBe(false);
    expect(
      canDrop({
        stage: "error",
        from_stage: "parsing",
        cause: { kind: "network" },
      }),
    ).toBe(false);
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

// ─── V2 transitions ──────────────────────────────────────────────────────

describe("toAuthPrompt", () => {
  test("landing → auth_prompt (no password yet)", () => {
    const s = toAuthPrompt(initialState);
    expect(s).toEqual({ stage: "auth_prompt" });
  });

  test("error[invalid_admin_password] → auth_prompt (clears password)", () => {
    const errored: State = {
      stage: "error",
      from_stage: "uploading",
      cause: { kind: "invalid_admin_password" },
    };
    const s = toAuthPrompt(errored);
    expect(s).toEqual({ stage: "auth_prompt" });
  });

  test("error with other cause → no-op (use toLanding for those)", () => {
    const errored: State = {
      stage: "error",
      from_stage: "uploading",
      cause: { kind: "network" },
    };
    expect(toAuthPrompt(errored)).toBe(errored);
  });

  test("from non-landing/non-auth-error states → no-op", () => {
    expect(toAuthPrompt(freshIdleUpload())).toEqual(freshIdleUpload());
  });
});

describe("toIdleUpload", () => {
  test("auth_prompt → idle_upload preserves password", () => {
    const s = toIdleUpload({ stage: "auth_prompt" }, PW);
    expect(s).toEqual({ stage: "idle_upload", admin_password: PW });
  });

  test("no-op outside auth_prompt", () => {
    expect(toIdleUpload(initialState, PW)).toBe(initialState);
  });
});

describe("toLanding (Cancel / auto-redirect / reset)", () => {
  test("auth_prompt → landing (Cancel) — password not introduced", () => {
    expect(toLanding({ stage: "auth_prompt" })).toEqual({ stage: "landing" });
  });

  test("confirm_overwrite → landing (Cancel) clears password", () => {
    const co: State = {
      stage: "confirm_overwrite",
      admin_password: PW,
      file: fakeFile(),
      parsed: fakeParsed,
      rows: fakeRows,
      pdf_sha256: "a".repeat(64),
    };
    expect(toLanding(co)).toEqual({ stage: "landing" });
  });

  test("success → landing (auto-redirect)", () => {
    const success: State = {
      stage: "success",
      result: fakeResponse,
      rows: fakeRows,
      parsed: fakeParsed,
      fileName: "shift.pdf",
    };
    expect(toLanding(success)).toEqual({ stage: "landing" });
  });

  test("reset alias matches toLanding", () => {
    expect(reset({ stage: "auth_prompt" })).toEqual({ stage: "landing" });
  });
});

// ─── happy-path chain through V2 states ──────────────────────────────────

describe("happy-path chain (V2)", () => {
  test("landing → auth_prompt → idle_upload → parsing → rendering_rows → hashing → confirm_overwrite → uploading → success", () => {
    let s: State = initialState;
    s = toAuthPrompt(s);
    expect(s.stage).toBe("auth_prompt");

    s = toIdleUpload(s, PW);
    expect(s.stage).toBe("idle_upload");

    s = toParsing(s, fakeFile());
    expect(s.stage).toBe("parsing");
    if (s.stage !== "parsing") throw new Error("nope");
    expect(s.admin_password).toBe(PW);

    s = toRenderingRows(s, fakeParsed);
    expect(s.stage).toBe("rendering_rows");
    if (s.stage !== "rendering_rows") throw new Error("nope");
    expect(s.admin_password).toBe(PW);

    s = toHashing(s, fakeRows);
    expect(s.stage).toBe("hashing");
    if (s.stage !== "hashing") throw new Error("nope");
    expect(s.admin_password).toBe(PW);
    expect(s.rows).toBe(fakeRows);

    s = toConfirmOverwrite(s, "a".repeat(64));
    expect(s.stage).toBe("confirm_overwrite");
    if (s.stage !== "confirm_overwrite") throw new Error("nope");
    expect(s.admin_password).toBe(PW);
    expect(s.pdf_sha256).toBe("a".repeat(64));

    s = toUploading(s);
    expect(s.stage).toBe("uploading");
    if (s.stage !== "uploading") throw new Error("nope");
    expect(s.admin_password).toBe(PW);

    s = toSuccess(s, fakeResponse);
    expect(s.stage).toBe("success");
    if (s.stage !== "success") throw new Error("nope");
    expect(s.result).toBe(fakeResponse);
    expect(s.rows).toBe(fakeRows);
    expect(s.fileName).toBe("shift.pdf");
    // Password cleared at toSuccess.
    expect((s as unknown as { admin_password?: unknown }).admin_password).toBeUndefined();
  });

  test("each transition no-ops if called from the wrong prior stage", () => {
    expect(toParsing(initialState, fakeFile())).toBe(initialState);
    expect(toRenderingRows(initialState, fakeParsed)).toBe(initialState);
    expect(toHashing(initialState, fakeRows)).toBe(initialState);
    expect(toConfirmOverwrite(initialState, "x")).toBe(initialState);
    expect(toUploading(initialState)).toBe(initialState);
    expect(toSuccess(initialState, fakeResponse)).toBe(initialState);
  });
});

describe("toError", () => {
  test("records from_stage when transitioning from a busy stage", () => {
    const busy: State = {
      stage: "rendering_rows",
      admin_password: PW,
      file: fakeFile(),
      parsed: fakeParsed,
    };
    const s = toError(busy, { kind: "network" });
    expect(s.stage).toBe("error");
    if (s.stage !== "error") throw new Error("nope");
    expect(s.from_stage).toBe("rendering_rows");
    expect(s.cause).toEqual({ kind: "network" });
  });

  test("toError on uploading produces invalid_admin_password error", () => {
    const uploading: State = {
      stage: "uploading",
      admin_password: PW,
      file: fakeFile(),
      parsed: fakeParsed,
      rows: fakeRows,
      pdf_sha256: "a".repeat(64),
    };
    const s = toError(uploading, { kind: "invalid_admin_password" });
    expect(s.stage).toBe("error");
    if (s.stage !== "error") throw new Error("nope");
    expect(s.cause.kind).toBe("invalid_admin_password");
  });

  test("no-op from landing / auth_prompt / idle_upload / confirm_overwrite / success / error", () => {
    const cases: State[] = [
      { stage: "landing" },
      { stage: "auth_prompt" },
      freshIdleUpload(),
      {
        stage: "confirm_overwrite",
        admin_password: PW,
        file: fakeFile(),
        parsed: fakeParsed,
        rows: fakeRows,
        pdf_sha256: "a".repeat(64),
      },
      {
        stage: "success",
        result: fakeResponse,
        rows: fakeRows,
        parsed: fakeParsed,
        fileName: "shift.pdf",
      },
      {
        stage: "error",
        from_stage: "parsing",
        cause: { kind: "network" },
      },
    ];
    for (const s of cases) {
      expect(toError(s, { kind: "http_500" })).toBe(s);
    }
  });
});
