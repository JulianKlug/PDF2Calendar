// Multipart shape + fetch error mapping. See docs/frontend-spec.md § Outputs +
// § Failure modes + § Test plan.

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildMultipart,
  MAX_PAYLOAD_BYTES,
  UploadError,
  uploadToServer,
  type UploadPayload,
} from "./api.ts";

// ─── buildMultipart ──────────────────────────────────────────────────────

function fakePayload(): UploadPayload {
  return {
    department: "anesthesia-chuv",
    pdf_sha256: "a".repeat(64),
    source_file_name: "shift.pdf",
    date_range: { start: "2026-05-01", end: "2026-05-31" },
    months: [{ year: 2026, month: 5, days_covered: [1, 2, 3] }],
    people: [
      {
        role: "ma",
        name: "Klug, J",
        person_hash: "0123456789abcdef",
        days: [{ date: "2026-05-01", codes: ["N13"] }],
      },
      {
        role: "ma",
        name: "Baldwin, J",
        person_hash: "fedcba9876543210",
        days: [{ date: "2026-05-01", codes: ["L2"] }],
      },
    ],
  };
}

describe("buildMultipart", () => {
  test("exactly 2 + N parts (payload + pdf + one row per person)", () => {
    const pdfBytes = new Uint8Array(100);
    const rows = new Map<string, Blob>([
      ["0123456789abcdef", new Blob([new Uint8Array(20)], { type: "image/png" })],
      ["fedcba9876543210", new Blob([new Uint8Array(30)], { type: "image/png" })],
    ]);
    const { formData, totalBytes } = buildMultipart(
      fakePayload(),
      pdfBytes,
      "shift.pdf",
      rows,
    );

    const entries = Array.from(formData.entries());
    expect(entries).toHaveLength(2 + 2);

    const names = entries.map(([k]) => k);
    expect(names).toContain("payload");
    expect(names).toContain("pdf");
    expect(names).toContain("row_0123456789abcdef");
    expect(names).toContain("row_fedcba9876543210");

    // Content-types and sizes match.
    const payloadPart = formData.get("payload");
    expect(payloadPart).toBeInstanceOf(Blob);
    // Bun/browser may append ";charset=utf-8" on JSON blobs; match prefix.
    expect((payloadPart as Blob).type).toMatch(/^application\/json/);

    const pdfPart = formData.get("pdf");
    expect(pdfPart).toBeInstanceOf(Blob);
    expect((pdfPart as Blob).type).toBe("application/pdf");
    expect((pdfPart as Blob).size).toBe(100);

    const rowPart = formData.get("row_0123456789abcdef");
    expect(rowPart).toBeInstanceOf(Blob);
    expect((rowPart as Blob).type).toBe("image/png");

    // totalBytes = payload JSON + 100 PDF + 20 row + 30 row
    const payloadJson = JSON.stringify(fakePayload());
    const expected = new Blob([payloadJson]).size + 100 + 20 + 30;
    expect(totalBytes).toBe(expected);
  });

  test("payload JSON round-trips through the form", async () => {
    const pdfBytes = new Uint8Array(10);
    const { formData } = buildMultipart(fakePayload(), pdfBytes, "x.pdf", new Map());
    const payloadBlob = formData.get("payload") as Blob;
    const parsed = JSON.parse(await payloadBlob.text());
    expect(parsed.department).toBe("anesthesia-chuv");
    expect(parsed.people).toHaveLength(2);
  });
});

describe("MAX_PAYLOAD_BYTES", () => {
  test("9.5 MB ceiling", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(Math.floor(9.5 * 1024 * 1024));
    // 0.5 MB headroom under the 10 MB server cap.
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});

// ─── uploadToServer (fetch mocks) ────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: () => Response | Promise<Response>): void {
  globalThis.fetch = ((..._args: unknown[]) =>
    Promise.resolve(handler())) as unknown as typeof fetch;
}

function fd(): FormData {
  const f = new FormData();
  f.append("payload", new Blob(["{}"], { type: "application/json" }));
  return f;
}

describe("uploadToServer", () => {
  test("200 with application/json → returns body", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ feeds: [], unknown_codes: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await uploadToServer(fd(), "");
    expect(res.feeds).toEqual([]);
    expect(res.unknown_codes).toEqual([]);
  });

  test("200 with non-JSON content-type → unexpected_content_type", async () => {
    mockFetch(
      () =>
        new Response("<html>nope</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "unexpected_content_type" },
    });
  });

  test("400 with {error: ...} → http_400 + serverMessage", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: "department mismatch" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await uploadToServer(fd(), "");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UploadError);
      const cause = (e as UploadError).errorCause;
      expect(cause.kind).toBe("http_400");
      if (cause.kind === "http_400") {
        expect(cause.serverMessage).toBe("department mismatch");
      }
    }
  });

  test("400 without JSON body → http_400 with no serverMessage", async () => {
    mockFetch(() => new Response("oops", { status: 400 }));
    try {
      await uploadToServer(fd(), "");
      throw new Error("should have thrown");
    } catch (e) {
      const cause = (e as UploadError).errorCause;
      expect(cause.kind).toBe("http_400");
      if (cause.kind === "http_400") {
        expect(cause.serverMessage).toBeUndefined();
      }
    }
  });

  test("413 → http_413", async () => {
    mockFetch(() => new Response("", { status: 413 }));
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "http_413" },
    });
  });

  test("415 → http_415", async () => {
    mockFetch(() => new Response("", { status: 415 }));
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "http_415" },
    });
  });

  test("429 with Retry-After → http_429 retryAfter", async () => {
    mockFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "42" },
        }),
    );
    try {
      await uploadToServer(fd(), "");
      throw new Error("should have thrown");
    } catch (e) {
      const cause = (e as UploadError).errorCause;
      expect(cause.kind).toBe("http_429");
      if (cause.kind === "http_429") expect(cause.retryAfter).toBe(42);
    }
  });

  test("429 without Retry-After → http_429 no retry", async () => {
    mockFetch(() => new Response("", { status: 429 }));
    try {
      await uploadToServer(fd(), "");
      throw new Error("should have thrown");
    } catch (e) {
      const cause = (e as UploadError).errorCause;
      expect(cause.kind).toBe("http_429");
      if (cause.kind === "http_429") expect(cause.retryAfter).toBeUndefined();
    }
  });

  test("500 → http_500", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "http_500" },
    });
  });

  test("503 → http_500 (any 5xx maps to http_500)", async () => {
    mockFetch(() => new Response("", { status: 503 }));
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "http_500" },
    });
  });

  test("fetch throws → network", async () => {
    globalThis.fetch = ((): Promise<Response> =>
      Promise.reject(new TypeError("no"))) as unknown as typeof fetch;
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "network" },
    });
  });

  test("other non-2xx → unknown", async () => {
    mockFetch(() => new Response("", { status: 418 }));
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "unknown" },
    });
  });

  test("401 → invalid_admin_password", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_admin_password" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
      errorCause: { kind: "invalid_admin_password" },
    });
  });

  test("400 with code:csrf → unknown (SPA-side bug — header should always be present)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: "missing header", code: "csrf" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    // Suppress the console.error the upload path emits for diagnostics.
    const origErr = console.error;
    console.error = () => undefined;
    try {
      await expect(uploadToServer(fd(), "")).rejects.toMatchObject({
        errorCause: { kind: "unknown" },
      });
    } finally {
      console.error = origErr;
    }
  });

  test("uploadToServer sends X-PDF2Cal-Admin: 1 header", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const h: Record<string, string> = {};
      const headers = init.headers as Record<string, string> | Headers | undefined;
      if (headers instanceof Headers) {
        headers.forEach((v, k) => (h[k] = v));
      } else if (headers) {
        for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
      }
      capturedHeaders = h;
      return Promise.resolve(
        new Response(JSON.stringify({ feeds: [], unknown_codes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    await uploadToServer(fd(), "");
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!["x-pdf2cal-admin"]).toBe("1");
  });
});
