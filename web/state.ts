// UI state machine — pure module, no DOM. See docs/frontend-spec.md § UI state machine.
//
// The `success` state extends the spec's definition with `rows` and `fileName` so the
// post-upload lightbox can serve the in-memory PNGs without a network round-trip
// (spec § Preview row). Everything else mirrors the spec one-to-one.

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
  | { kind: "unknown"; message?: string };

export type State =
  | { stage: "idle" }
  | { stage: "parsing"; file: File }
  | { stage: "rendering_rows"; file: File; parsed: ParseResult }
  | {
      stage: "hashing";
      file: File;
      parsed: ParseResult;
      rows: Map<string, Blob>;
    }
  | {
      stage: "uploading";
      file: File;
      parsed: ParseResult;
      rows: Map<string, Blob>;
      pdf_sha256: string;
    }
  | {
      stage: "success";
      result: UploadResponse;
      rows: Map<string, Blob>;
      parsed: ParseResult;
      fileName: string;
    }
  | {
      stage: "error";
      from_stage: BusyStage;
      cause: ErrorCause;
    };

export const initialState: State = { stage: "idle" };

// Drop-while-busy rule (spec § UI state machine): drop/dragover handlers MUST
// no-op when the pipeline is running.
export function canDrop(state: State): boolean {
  return state.stage === "idle";
}

// Pre-flight checks (spec § Pre-flight checks). Failures stay in `idle` and
// surface as an inline message — they do NOT transition to `error`.
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

export function toParsing(state: State, file: File): State {
  if (state.stage !== "idle") return state;
  return { stage: "parsing", file };
}

export function toRenderingRows(state: State, parsed: ParseResult): State {
  if (state.stage !== "parsing") return state;
  return { stage: "rendering_rows", file: state.file, parsed };
}

export function toHashing(state: State, rows: Map<string, Blob>): State {
  if (state.stage !== "rendering_rows") return state;
  return {
    stage: "hashing",
    file: state.file,
    parsed: state.parsed,
    rows,
  };
}

export function toUploading(state: State, pdf_sha256: string): State {
  if (state.stage !== "hashing") return state;
  return {
    stage: "uploading",
    file: state.file,
    parsed: state.parsed,
    rows: state.rows,
    pdf_sha256,
  };
}

export function toSuccess(
  state: State,
  result: UploadResponse,
): State {
  if (state.stage !== "uploading") return state;
  return {
    stage: "success",
    result,
    rows: state.rows,
    parsed: state.parsed,
    fileName: state.file.name,
  };
}

export function toError(state: State, cause: ErrorCause): State {
  if (
    state.stage === "idle" ||
    state.stage === "success" ||
    state.stage === "error"
  ) {
    return state;
  }
  return { stage: "error", from_stage: state.stage, cause };
}

// Reset rule (spec § UI state machine): success → idle and error → idle wipe
// all state including parsed result and rendered Blobs.
export function reset(_state: State): State {
  return { stage: "idle" };
}
