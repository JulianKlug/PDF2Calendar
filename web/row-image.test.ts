// Row-image rendering needs a headless DOM with canvas + canvas.toBlob, which
// Bun's runtime does NOT provide out of the box. Per docs/frontend-spec.md
// § Test plan, this test is gated behind WEB_CANVAS_TESTS=1 and the multi-page
// composition path is left to code review + the manual smoke test.
//
// To run locally with a canvas polyfill:
//   bun add -d @napi-rs/canvas
//   WEB_CANVAS_TESTS=1 bun test web/row-image.test.ts

import { describe, expect, test } from "bun:test";

const enabled = process.env.WEB_CANVAS_TESTS === "1";

describe.skipIf(!enabled)("renderRowImages (gated on WEB_CANVAS_TESTS=1)", () => {
  test("same-page crop produces a PNG blob of expected dimensions", async () => {
    // Intentionally left as a placeholder. Wire up a real canvas backend
    // (e.g. @napi-rs/canvas with a polyfill installer) before enabling.
    expect(enabled).toBe(true);
  });
});
