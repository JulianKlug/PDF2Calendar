// SHA-256 of PDF bytes. Cross-check against node:crypto so the WebCrypto path
// (web/pdf-hash.ts) and any server-side re-verification agree exactly.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { pdfHash } from "./pdf-hash.ts";

describe("pdfHash", () => {
  test("known input → known 64 hex", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const bytes = new TextEncoder().encode("abc");
    const hex = await pdfHash(bytes);
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex).toHaveLength(64);
  });

  test("matches node:crypto for arbitrary bytes", async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
    const fromWebCrypto = await pdfHash(bytes);
    const fromNode = createHash("sha256").update(bytes).digest("hex");
    expect(fromWebCrypto).toBe(fromNode);
  });

  test("empty input → known sha256", async () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hex = await pdfHash(new Uint8Array(0));
    expect(hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
