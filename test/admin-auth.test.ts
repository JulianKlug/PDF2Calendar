// Spec-driven tests for admin-auth. See docs/v2-spec.md § Verification step 15.

import { afterEach, describe, expect, test } from "bun:test";

import {
  logAuthFailure,
  requireAdminHeader,
  sanitizeOriginalFilename,
  verifyAdminPassword,
} from "../src/admin-auth.ts";
import { BadRequest } from "../src/server.ts";

describe("verifyAdminPassword", () => {
  test("correct password → true", () => {
    expect(verifyAdminPassword("hunter2", "hunter2")).toBe(true);
  });

  test("wrong password → false", () => {
    expect(verifyAdminPassword("hunter3", "hunter2")).toBe(false);
  });

  test("near-miss (one char off) → false", () => {
    expect(verifyAdminPassword("hunter22", "hunter2")).toBe(false);
    expect(verifyAdminPassword("hunter", "hunter2")).toBe(false);
  });

  test("empty supplied → false", () => {
    expect(verifyAdminPassword("", "hunter2")).toBe(false);
  });

  test("empty expected → false (defensive; readEnv rejects at boot)", () => {
    expect(verifyAdminPassword("hunter2", "")).toBe(false);
  });

  test("long password → still constant-length digests, true on match", () => {
    const long = "a".repeat(10_000);
    expect(verifyAdminPassword(long, long)).toBe(true);
  });
});

describe("sanitizeOriginalFilename", () => {
  test("normal filename → returned as-is", () => {
    expect(sanitizeOriginalFilename("Plan_Mai_2026.pdf")).toBe("Plan_Mai_2026.pdf");
  });

  test("unicode filename → returned as-is", () => {
    expect(sanitizeOriginalFilename("Garde_Mai_éé.pdf")).toBe("Garde_Mai_éé.pdf");
  });

  test("250-char input → truncated to 200", () => {
    const long = "a".repeat(250);
    const result = sanitizeOriginalFilename(long);
    expect(result.length).toBe(200);
    expect(result).toBe("a".repeat(200));
  });

  test("control char rejected", () => {
    expect(() => sanitizeOriginalFilename("evil\x00name.pdf")).toThrow(BadRequest);
  });

  test("newline rejected", () => {
    expect(() => sanitizeOriginalFilename("evil\nname.pdf")).toThrow(BadRequest);
  });

  test("DEL char rejected", () => {
    expect(() => sanitizeOriginalFilename("evil\x7fname.pdf")).toThrow(BadRequest);
  });

  test("forward slash rejected", () => {
    expect(() => sanitizeOriginalFilename("../etc/passwd")).toThrow(BadRequest);
  });

  test("backslash rejected", () => {
    expect(() => sanitizeOriginalFilename("evil\\name.pdf")).toThrow(BadRequest);
  });

  test("empty string rejected", () => {
    expect(() => sanitizeOriginalFilename("")).toThrow(BadRequest);
  });
});

describe("requireAdminHeader", () => {
  test("header value '1' → ok", () => {
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-pdf2cal-admin": "1" },
    });
    expect(() => requireAdminHeader(req)).not.toThrow();
  });

  test("header missing → throws csrf BadRequest", () => {
    const req = new Request("http://localhost/api/upload", { method: "POST" });
    try {
      requireAdminHeader(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequest);
      expect((e as BadRequest).code).toBe("csrf");
    }
  });

  test("header value other than '1' → throws csrf BadRequest", () => {
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-pdf2cal-admin": "true" },
    });
    try {
      requireAdminHeader(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequest);
      expect((e as BadRequest).code).toBe("csrf");
    }
  });

  test("empty header value → throws csrf BadRequest", () => {
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-pdf2cal-admin": "" },
    });
    try {
      requireAdminHeader(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequest);
      expect((e as BadRequest).code).toBe("csrf");
    }
  });
});

describe("logAuthFailure", () => {
  let captured: unknown[][] = [];
  const origErr = console.error;

  function startCapture() {
    captured = [];
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
  }

  afterEach(() => {
    console.error = origErr;
    captured = [];
  });

  test("emits one stderr line with ISO ts + token + from=<ip>", () => {
    startCapture();
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    logAuthFailure(req);
    expect(captured).toHaveLength(1);
    const line = String(captured[0]![0]);
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN admin_password_mismatch from=203\.0\.113\.42$/,
    );
  });

  test("uses first hop when X-Forwarded-For is a comma list", () => {
    startCapture();
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
    });
    logAuthFailure(req);
    const line = String(captured[0]![0]);
    expect(line).toContain("from=198.51.100.7");
  });

  test("falls back to from=unknown when X-Forwarded-For is missing", () => {
    startCapture();
    const req = new Request("http://localhost/api/upload", { method: "POST" });
    logAuthFailure(req);
    const line = String(captured[0]![0]);
    expect(line).toContain("from=unknown");
  });

  test("falls back to from=unknown when X-Forwarded-For is empty", () => {
    startCapture();
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "x-forwarded-for": "" },
    });
    logAuthFailure(req);
    const line = String(captured[0]![0]);
    expect(line).toContain("from=unknown");
  });
});
