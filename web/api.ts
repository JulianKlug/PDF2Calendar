// Multipart upload contract — see docs/frontend-spec.md § Outputs.
//
// The frontend produces exactly one HTTP call. `payload` is the source of truth
// for the upload shape; the server re-derives every hash from it.

import type { ParsedDay } from "../src/types.ts";
import type { ErrorCause } from "./state.ts";

export type UploadPayload = {
  department: string;
  pdf_sha256: string;
  source_file_name: string;
  date_range: { start: string; end: string };
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  people: Array<{
    role: string;
    name: string;
    person_hash: string;
    days: ParsedDay[];
  }>;
  // V2 additions. Optional at the type level so commit 4 (server-side plan
  // write) can land before commit 5 (admin gate). The runtime requirement
  // is added in commit 5 (validatePayload + verifyAdminPassword).
  admin_password?: string;
  original_filename?: string;
};

export type UploadResponseFeed = {
  name: string;
  role: string;
  person_hash: string;
  webcal_url: string;
};

export type UploadResponse = {
  feeds: UploadResponseFeed[];
  unknown_codes: string[];
};

// 9.5 MB — 0.5 MB headroom under the server's 10 MB ceiling
// (spec § Step 4: total-payload pre-flight).
export const MAX_PAYLOAD_BYTES = Math.floor(9.5 * 1024 * 1024);

export class UploadError extends Error {
  readonly errorCause: ErrorCause;
  constructor(cause: ErrorCause) {
    super(`upload failed: ${cause.kind}`);
    this.name = "UploadError";
    this.errorCause = cause;
  }
}

export type BuildMultipartResult = {
  formData: FormData;
  totalBytes: number;
};

export function buildMultipart(
  payload: UploadPayload,
  pdfBytes: Uint8Array,
  pdfFileName: string,
  rows: Map<string, Blob>,
): BuildMultipartResult {
  const payloadJson = JSON.stringify(payload);
  const payloadBlob = new Blob([payloadJson], { type: "application/json" });
  // Cast: TS's DOM lib narrows BlobPart to ArrayBufferView<ArrayBuffer> but
  // `Uint8Array<ArrayBufferLike>` is runtime-compatible.
  const pdfBlob = new Blob([pdfBytes as unknown as BlobPart], {
    type: "application/pdf",
  });

  const formData = new FormData();
  formData.append("payload", payloadBlob, "payload.json");
  formData.append("pdf", pdfBlob, pdfFileName);

  let totalBytes = payloadBlob.size + pdfBlob.size;
  for (const [hash, blob] of rows) {
    formData.append(`row_${hash}`, blob, `row_${hash}.png`);
    totalBytes += blob.size;
  }

  return { formData, totalBytes };
}

// Map an HTTP response (or network failure) to a typed ErrorCause. Caller
// decides what to do with it; this module never touches the DOM.
//
// Always sends the X-PDF2Cal-Admin: 1 CSRF header. Browsers can't add custom
// headers cross-origin without a CORS preflight, so a form-style CSRF can
// never satisfy this — see docs/v2-spec.md § Decisions / CSRF defense.
export async function uploadToServer(
  formData: FormData,
  baseUrl: string,
): Promise<UploadResponse> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-pdf2cal-admin": "1" },
      body: formData,
    });
  } catch {
    throw new UploadError({ kind: "network" });
  }

  if (res.status === 401) {
    // Server confirmed the password was wrong. Per spec § Upload flow step 6,
    // the SPA surfaces this as a "Wrong admin password" error with a Retry
    // button that returns to the password modal.
    throw new UploadError({ kind: "invalid_admin_password" });
  }

  if (res.status === 400) {
    let serverMessage: string | undefined;
    let code: string | undefined;
    try {
      const body = (await res.clone().json()) as {
        error?: unknown;
        code?: unknown;
      };
      if (typeof body?.error === "string") serverMessage = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      // body wasn't JSON; fall through with no serverMessage
    }
    if (code === "csrf") {
      // Should never happen from this SPA — uploadToServer always sends the
      // header. Surface as "unknown" so the user sees a clear error, and log
      // for diagnostics (misconfigured client or interception).
      // eslint-disable-next-line no-console
      console.error(
        "[pdf2calendar] /api/upload returned 400 csrf — the X-PDF2Cal-Admin header was missing or wrong",
      );
      throw new UploadError({
        kind: "unknown",
        message: "CSRF header missing — please refresh and retry.",
      });
    }
    throw new UploadError(
      serverMessage !== undefined
        ? { kind: "http_400", serverMessage }
        : { kind: "http_400" },
    );
  }
  if (res.status === 413) throw new UploadError({ kind: "http_413" });
  if (res.status === 415) throw new UploadError({ kind: "http_415" });
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const parsed = ra !== null ? parseInt(ra, 10) : NaN;
    throw new UploadError(
      Number.isFinite(parsed)
        ? { kind: "http_429", retryAfter: parsed }
        : { kind: "http_429" },
    );
  }
  if (res.status >= 500 && res.status < 600) {
    throw new UploadError({ kind: "http_500" });
  }
  if (!res.ok) {
    throw new UploadError({
      kind: "unknown",
      message: `HTTP ${res.status}`,
    });
  }

  // Validation rule 4 (spec): 2xx must be application/json.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new UploadError({ kind: "unexpected_content_type" });
  }

  return (await res.json()) as UploadResponse;
}
