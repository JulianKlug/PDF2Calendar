// Dev proxy must forward API calls only, never same-named source modules
// (e.g. web/api.ts served as /api.ts).

import { describe, expect, test } from "bun:test";

import config from "../vite.config.ts";

// Mirrors Vite's proxy matching: "^"-prefixed keys are regexes, others are
// path prefixes.
function isProxied(url: string): boolean {
  const proxy = config.server?.proxy ?? {};
  return Object.keys(proxy).some((key) =>
    key.startsWith("^") ? new RegExp(key).test(url) : url.startsWith(key),
  );
}

describe("dev proxy", () => {
  test("forwards API routes", () => {
    expect(isProxied("/api/manifest")).toBe(true);
    expect(isProxied("/api/upload")).toBe(true);
  });

  test("does not forward the api.ts module", () => {
    expect(isProxied("/api.ts")).toBe(false);
    expect(isProxied("/api.ts?t=123")).toBe(false);
  });
});
