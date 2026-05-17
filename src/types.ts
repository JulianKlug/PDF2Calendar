// Public types for the parser. Mirrors docs/parser-spec.md §"Output schema".

export type ParseResult = {
  source: {
    file_name: string | null;
    page_count: number;
    parsed_at: string;
    page_dims: PageDims[];
  };
  department: string | null;
  date_range: { start: string; end: string };
  // Y-bounds (PDF points, origin bottom-left) of the header strip:
  // month band + day numbers + weekday letters. Used by the row-image
  // renderer to crop "header + person row" PNGs.
  header_band: YBand;
  months: ParsedMonth[];
  people: ParsedPerson[];
  unknown_codes: string[];
  warnings: ParseWarning[];
};

export type PageDims = {
  page: number;
  width: number;
  height: number;
};

export type YBand = {
  page: number;
  y_top: number;
  y_bottom: number;
};

export type ParsedMonth = {
  year: number;
  month: number;
  days_covered: number[];
};

export type ParsedPerson = {
  role: string;
  name: string;
  days: ParsedDay[];
  row_band: YBand;
};

export type ParsedDay = {
  date: string;
  codes: string[];
};

export type ParseWarning =
  | { kind: "duplicate_name"; name: string; rows: number[] }
  | { kind: "row_length_mismatch"; name: string; expected: number; got: number }
  | { kind: "month_band_inference"; reason: string }
  | { kind: "unrecognized_role_header"; text: string; row: number }
  | { kind: "header_missing_year"; assumed_year: number }
  // Sentinel: no V1 shift code contains whitespace. Seeing one means the
  // parser's per-column split missed a pdfjs multi-shift concatenation
  // (e.g. "Nw46 Nw46 N46" emitted as one text item). Hard signal of a
  // parser regression — surface loudly so a real PDF can be captured.
  | { kind: "whitespace_in_code"; name: string; date: string; code: string };

export type ParseErrorCode =
  | "no_text_layer"
  | "day_row_not_found"
  | "too_many_months"
  | "multiple_tables"
  | "empty_pdf"
  | "internal_validation_failed";

export class ParseError extends Error {
  constructor(
    public code: ParseErrorCode,
    public detail?: { page?: number; check?: string; reason?: string },
  ) {
    super(`${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "ParseError";
  }
}

// Internal — what loadPages() returns and parsePages() consumes.
// Exported so tests can feed canned fixtures without touching pdfjs.
export type RawTextItem = {
  str: string;
  x: number;       // transform[4]
  y: number;       // transform[5] (PDF coords, origin bottom-left)
  width: number;
  height: number;
};

export type RawPage = {
  page: number;    // 1-indexed
  width: number;   // viewport width (PDF points, scale=1)
  height: number;
  items: RawTextItem[];
};

// ─── V2 disk artifacts ────────────────────────────────────────────────────
//
// Schema version 2 is written by V2 uploads. Pre-V2 manifests are read-tolerant
// (silently skipped from /api/manifest until the corresponding plan is
// re-uploaded). See docs/v2-spec.md § Server changes.

export type Plan = {
  schema_version: 2;
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  person_hashes: string[];
};

export type ManifestEntry = {
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number }>;
};

export type PersonManifest = {
  schema_version: 2;
  name: string;
  role: string;
  last_uploaded_at: string;
  last_pdf_sha256: string;
  last_date_range: { start: string; end: string };
  entries: ManifestEntry[];
};

// ─── /api/manifest response shape ─────────────────────────────────────────
//
// Returned by GET /api/manifest. Shared between server (src/manifest-cache.ts)
// and frontend (web/main.ts) so the frontend can type the fetch result
// without importing node:fs-flavored modules.

export type ManifestPlanInfo = {
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number; days_covered: number[] }>;
};

export type ManifestStaffEntry = {
  person_hash: string;
  name: string;
  role: string;
  feed_url: string;
  entries: Array<{
    pdf_sha256: string;
    original_filename: string;
    uploaded_at: string;
    months: Array<{ year: number; month: number }>;
    row_url: string;
  }>;
};

export type ManifestResponse = {
  schema_version: 2;
  department_slug: string;
  latest_plan: ManifestPlanInfo | null;
  plans: ManifestPlanInfo[];
  staff: ManifestStaffEntry[];
};
