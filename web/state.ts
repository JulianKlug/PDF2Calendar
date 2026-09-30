// UI state machine — pure module, no DOM. See docs/v2-spec.md § Frontend
// changes / State machine.
//
// The admin password is carried explicitly inside the State variants from
// `auth_prompt` onward so State is the single source of truth (no module-
// level secrets). One login covers every upload until page reload or
// Log out; only `error[invalid_admin_password]` drops it.

import {
  type ParseErrorCode,
  type ParseResult,
} from "../src/types.ts";
import type { UploadResponse } from "./api.ts";

export type BusyStage = "parsing" | "rendering_rows" | "hashing" | "uploading";

export type ErrorCause =
  | { kind: "parse_error"; code: ParseErrorCode; detail?: string }
  | { kind: "no_people_found" }
  | { kind: "payload_too_large" }
  | { kind: "http_400"; serverMessage?: string }
  | { kind: "http_413" }
  | { kind: "http_415" }
  | { kind: "http_429"; retryAfter?: number }
  | { kind: "http_500" }
  | { kind: "network" }
  | { kind: "unexpected_content_type" }
  | { kind: "invalid_admin_password" }
  | { kind: "unknown"; message?: string };

export type State =
  | { stage: "landing"; admin_password?: string }
  | { stage: "auth_prompt" }
  | { stage: "idle_upload"; admin_password: string }
  | { stage: "parsing"; admin_password: string; file: File }
  | {
      stage: "rendering_rows";
      admin_password: string;
      file: File;
      parsed: ParseResult;
    }
  | {
      stage: "hashing";
      admin_password: string;
      file: File;
      parsed: ParseResult;
      rows: Map<string, Blob>;
    }
  | {
      stage: "confirm_overwrite";
      admin_password: string;
      file: File;
      parsed: ParseResult;
      rows: Map<string, Blob>;
      pdf_sha256: string;
    }
  | {
      stage: "uploading";
      admin_password: string;
      file: File;
      parsed: ParseResult;
      rows: Map<string, Blob>;
      pdf_sha256: string;
    }
  | {
      stage: "success";
      admin_password: string;
      result: UploadResponse;
      rows: Map<string, Blob>;
      parsed: ParseResult;
      fileName: string;
    }
  | {
      stage: "error";
      from_stage: BusyStage;
      cause: ErrorCause;
      admin_password?: string;
    };

export const initialState: State = { stage: "landing" };

// Drop-while-busy rule: drop/dragover handlers MUST no-op outside idle_upload.
export function canDrop(state: State): boolean {
  return state.stage === "idle_upload";
}

// Pre-flight checks (spec § Pre-flight checks). Failures stay in idle_upload
// and surface as an inline message — they do NOT transition to `error`.
export type ValidateFileResult =
  | { ok: true }
  | { ok: false; reason: "wrong_type"; message: string }
  | { ok: false; reason: "too_large"; message: string };

const MAX_PDF_BYTES = 5 * 1024 * 1024;

export function validateFile(file: File): ValidateFileResult {
  const isPdfType = file.type === "application/pdf";
  const isPdfExt = file.name.toLowerCase().endsWith(".pdf");
  if (!isPdfType && !isPdfExt) {
    return {
      ok: false,
      reason: "wrong_type",
      message: "Please drop a PDF file.",
    };
  }
  if (file.size > MAX_PDF_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: "PDF too large (max 5 MB).",
    };
  }
  return { ok: true };
}

// ─── Transitions ──────────────────────────────────────────────────────────

// landing → auth_prompt (Upload click on landing).
// Also accepts error[invalid_admin_password] (Retry from wrong-password screen).
export function toAuthPrompt(state: State): State {
  if (state.stage === "landing") return { stage: "auth_prompt" };
  if (state.stage === "error" && state.cause.kind === "invalid_admin_password") {
    return { stage: "auth_prompt" };
  }
  return state;
}

// auth_prompt → idle_upload (Submit with password).
export function toIdleUpload(state: State, admin_password: string): State {
  if (state.stage !== "auth_prompt") return state;
  return { stage: "idle_upload", admin_password };
}

// Always-allowed escape to landing. Keeps the session password, if any.
// Used by: success → landing auto-redirect, Cancel in auth_prompt and
// confirm_overwrite modals, "Try again" from error screens (non-auth errors).
export function toLanding(state: State): State {
  const pw = "admin_password" in state ? state.admin_password : undefined;
  if (pw === undefined) return { stage: "landing" };
  return { stage: "landing", admin_password: pw };
}

// Upload click on landing, or "Upload another plan" on success. Skips the
// password prompt when the session is already logged in.
export function toUploadStart(state: State): State {
  if (state.stage === "success") {
    return { stage: "idle_upload", admin_password: state.admin_password };
  }
  if (state.stage !== "landing") return state;
  if (state.admin_password === undefined) return { stage: "auth_prompt" };
  return { stage: "idle_upload", admin_password: state.admin_password };
}

// Log out click on landing — forget the session password.
export function toLogout(state: State): State {
  if (state.stage !== "landing") return state;
  return { stage: "landing" };
}

// Back-compat alias for V1 callers. Same semantics as toLanding.
export const reset = toLanding;

// idle_upload → parsing.
export function toParsing(state: State, file: File): State {
  if (state.stage !== "idle_upload") return state;
  return { stage: "parsing", admin_password: state.admin_password, file };
}

// parsing → rendering_rows.
export function toRenderingRows(state: State, parsed: ParseResult): State {
  if (state.stage !== "parsing") return state;
  return {
    stage: "rendering_rows",
    admin_password: state.admin_password,
    file: state.file,
    parsed,
  };
}

// rendering_rows → hashing.
export function toHashing(state: State, rows: Map<string, Blob>): State {
  if (state.stage !== "rendering_rows") return state;
  return {
    stage: "hashing",
    admin_password: state.admin_password,
    file: state.file,
    parsed: state.parsed,
    rows,
  };
}

// hashing → confirm_overwrite. Spec § Upload flow step 4 — modal shown
// before the POST so the admin sees what they're about to replace.
export function toConfirmOverwrite(state: State, pdf_sha256: string): State {
  if (state.stage !== "hashing") return state;
  return {
    stage: "confirm_overwrite",
    admin_password: state.admin_password,
    file: state.file,
    parsed: state.parsed,
    rows: state.rows,
    pdf_sha256,
  };
}

// confirm_overwrite → uploading (Confirm in modal).
export function toUploading(state: State): State {
  if (state.stage !== "confirm_overwrite") return state;
  return {
    stage: "uploading",
    admin_password: state.admin_password,
    file: state.file,
    parsed: state.parsed,
    rows: state.rows,
    pdf_sha256: state.pdf_sha256,
  };
}

// uploading → success. Keeps admin_password for the next upload.
export function toSuccess(
  state: State,
  result: UploadResponse,
): State {
  if (state.stage !== "uploading") return state;
  return {
    stage: "success",
    admin_password: state.admin_password,
    result,
    rows: state.rows,
    parsed: state.parsed,
    fileName: state.file.name,
  };
}

// any busy → error. Idempotent on terminal/idle states. A rejected
// password is dropped; any other failure keeps the session logged in.
export function toError(state: State, cause: ErrorCause): State {
  if (
    state.stage !== "parsing" &&
    state.stage !== "rendering_rows" &&
    state.stage !== "hashing" &&
    state.stage !== "uploading"
  ) {
    return state;
  }

  if (cause.kind === "invalid_admin_password") {
    return { stage: "error", from_stage: state.stage, cause };
  }
  return {
    stage: "error",
    from_stage: state.stage,
    cause,
    admin_password: state.admin_password,
  };
}
