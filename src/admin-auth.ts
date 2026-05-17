// Admin-auth helpers: password compare, filename sanitize, CSRF header check,
// 401 logging. See docs/v2-spec.md § Server changes / New module.
//
// All admin-auth code lives here so the OAuth migration is a clean delete of
// this file (paired with web/admin-auth.ts). This module never touches
// Response objects directly; failures throw BadRequest and the upload
// handler converts them to HTTP responses.

import { createHash, timingSafeEqual } from "node:crypto";
import { BadRequest } from "./server.ts";

// Constant-time password compare via SHA-256 digests. Both digests are
// always 32 bytes, so timingSafeEqual is constant-time without padding.
// Empty expected → always false (defensive; readEnv() rejects empty at boot).
export function verifyAdminPassword(supplied: string, expected: string): boolean {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (expected.length === 0) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Sanitize an admin-supplied original filename for logging + manifest storage.
// Rejects control chars and path separators outright (those are signs of an
// attacker, not a typo). Truncates to 200 chars.
export function sanitizeOriginalFilename(raw: string): string {
  if (typeof raw !== "string") {
    throw new BadRequest("schema", "original_filename must be a string");
  }
  if (raw.length === 0) {
    throw new BadRequest("schema", "original_filename must be non-empty");
  }
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new BadRequest("schema", "original_filename contains control characters");
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new BadRequest("schema", "original_filename must not contain / or \\");
  }
  return raw.length > 200 ? raw.slice(0, 200) : raw;
}

// CSRF defense: require an explicit X-PDF2Cal-Admin: 1 header on /api/upload.
// Browsers don't send custom headers cross-origin without a CORS preflight,
// and we never enable CORS — so a form POST from a foreign origin can't
// reach this code path.
export function requireAdminHeader(req: Request): void {
  const v = req.headers.get("x-pdf2cal-admin");
  if (v !== "1") {
    throw new BadRequest("csrf", "missing X-PDF2Cal-Admin header");
  }
}

// One-line stderr log on 401. journald captures stderr for the systemd unit,
// so this lands in `journalctl -u pdf2calendar`. The from=<ip> comes from
// the X-Forwarded-For header that nginx sets on /api/upload only (the p2c
// access log_format omits client IPs by design).
export function logAuthFailure(req: Request): void {
  const xff = req.headers.get("x-forwarded-for");
  const from = xff && xff.length > 0 ? xff.split(",")[0]!.trim() : "unknown";
  console.error(
    `${new Date().toISOString()} WARN admin_password_mismatch from=${from || "unknown"}`,
  );
}
