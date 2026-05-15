# Frontend Specification

Status: DRAFT
Owner: @klug
Related:
- Parser spec: `docs/parser-spec.md`
- iCal generator spec: `docs/ics-spec.md`
- Design doc: `~/.gstack/projects/JulianKlug-PDF2Calendar/klug-main-design-20260503-093154.md`
- Manual test (sibling): `docs/manual-deletion-test.md`

---

## Purpose

A static SPA — drop a hospital shift PDF, get a list of per-person subscribe
URLs. Owns the browser-side pipeline:

```
parse → render row PNGs → hash PDF → POST multipart → render result list
```

No framework, no router, no SSR. Two screens of UI: pre-upload (drop zone)
and post-upload (name list). All heavy work happens client-side; the backend
only persists the result.

**Boundary rule.** Pure pipeline modules (state machine, row renderer, hash,
API client) are testable in Bun without a DOM. Only `web/main.ts` touches
the DOM. If a unit test ever needs `jsdom`, the boundary is wrong.

The frontend imports `parse()` from `src/parser.ts`. There is **one parser
implementation** (per parser-spec § Inputs). The frontend never imports
`src/ics.ts` — `.ics` generation lives entirely server-side. The frontend
ships parsed JSON; the server resolves codes and writes `.ics`.

---

## Inputs

### User input

One PDF file via drag-drop onto the page, or via a hidden
`<input type=file accept="application/pdf,.pdf">` clicked by the drop
zone. The `accept` attribute filters the native picker to PDFs (cosmetic
on most platforms; some honor it strictly). Multi-file drop, folder drop,
and any non-PDF MIME are still rejected before the pipeline starts (see
§ Pre-flight checks) — `accept` is hint, not enforcement.

### Build-time environment

| Var | Required | Notes |
|---|---|---|
| `VITE_DEPARTMENT_SLUG` | **yes** | Slug like `anesthesia-chuv`. Baked into every `person_hash`. The build must fail loud if unset — a missing slug silently corrupts every URL. |
| `VITE_API_BASE_URL` | no | Defaults to same-origin (empty string). Set in local dev (`http://localhost:3001`) when the backend runs on a different port. |

No runtime config. No localStorage in V1 (see § Screen layouts and visual hierarchy).

---

## Outputs

The frontend produces one HTTP call. `POST /api/upload`, `multipart/form-data`,
parts:

| Part name | Content-Type | Content |
|---|---|---|
| `payload` | `application/json` | `UploadPayload` JSON, see below |
| `pdf` | `application/pdf` | Original PDF bytes |
| `row_<person_hash>` | `image/png` | One part per person, the cropped row image |

```ts
type UploadPayload = {
  department: string;            // from VITE_DEPARTMENT_SLUG
  pdf_sha256: string;            // 64 hex; server re-verifies against the `pdf` part
  source_file_name: string;      // original filename
  date_range: { start: string; end: string };
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  people: Array<{
    role: string;
    name: string;
    person_hash: string;         // sha256(department + "|" + normalize(name))[:16]
    days: Array<{ date: string; codes: string[] }>;
  }>;
};
```

This shape is the **source of truth** for the upload contract.
The design doc § API contract mirrors this section verbatim
(updated 2026-05-15 to match). If the two ever drift in the future,
this spec wins — the frontend is where the contract is consumed.

Design notes on the shape:

- `feeds` is an **array**, not a `{name → ...}` map: PDF order is
  preserved without a re-sort, and two colleagues with the same display
  name don't silently overwrite each other.
- Each entry carries `role` so the result page groups by role without
  having to keep the parsed payload alive after the server response.
- Field names are `person_hash` and `webcal_url` — unambiguous at every
  call site.

### Result rendered to the page

On `200 OK` the body is:

```ts
type UploadResponse = {
  feeds: Array<{
    name: string;
    role: string;
    person_hash: string;
    webcal_url: string;          // "webcal://pdf2calendar.example.com/feed/<hash>.ics"
  }>;
  unknown_codes: string[];
};
```

The frontend renders `feeds` grouped by role, with `[Preview row]`,
`[Copy URL]`, and `[Open in Google Calendar]` buttons per person.
`unknown_codes` becomes the dismissable banner described in § Screen
layouts and visual hierarchy.

---

## Directory layout and files

`web/` at repo root, sibling to `src/`. The `src/` tree remains the pure
backend / shared library that `web/` imports from.

```
web/
  index.html         # single entry: drop zone + result container
  main.ts            # DOM wiring + state machine orchestration only
  state.ts           # pure state machine (testable without a DOM)
  row-image.ts       # pdfjs canvas crop → PNG Blob @ 144 DPI
  pdf-hash.ts        # WebCrypto sha256(file_bytes) → 64 hex
  person-hash.ts     # normalize(name) + sha256(dept + "|" + name)[:16]
  api.ts             # multipart builder + POST + typed error mapping
vite.config.ts       # root: 'web', build.outDir: '../dist'
```

Seven files in `web/`. If an eighth is needed, prefer growing one of the
existing six over splitting further — this is two screens.

`main.ts` is the only file that imports browser DOM APIs (`document`,
event listeners). Every other module takes its inputs by parameter and
returns plain values.

---

## Identifier hashing (normative)

The frontend must produce `person_hash` values that **byte-match** the
server's re-derivation. The server **rejects** the upload with `400`
on any mismatch (design doc § API contract). The single highest-impact
bug in this pipeline is a hash that disagrees with the server because
of an off-by-one in `normalize()`. Lock the contract down.

`web/person-hash.ts` exports two pure functions:

```ts
export function normalize(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")        // collapse internal whitespace
    .replace(/[.,;:!?]+$/, "");  // strip trailing punctuation
}

export async function personHash(
  department: string,
  name: string,
): Promise<string> {
  const input = `${department}|${normalize(name)}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
```

The `normalize()` body is copy-paste-identical with the design doc's
function and (when implemented) the server's. If any of the three drifts
from any of the others, the test suite below catches it before any user
sees a 400.

`personHash.test.ts` MUST include a small fixture table cross-validated
against the server implementation: at minimum the literal pair
`(department: "anesthesia-chuv", name: "Klug, J")` plus four edge cases
that each exercise one step of `normalize()` (NFC composition, case,
internal whitespace, trailing punctuation). When the server adds a
matching test, include the same fixture file from both sides — drift is
caught in CI rather than in production.

---

## UI state machine

Single discriminated-union state. Lives in `web/state.ts`, mutated only by
named transitions.

```ts
type State =
  | { stage: "idle" }
  | { stage: "parsing"; file: File }
  | { stage: "rendering_rows"; file: File; parsed: ParseResult }
  | { stage: "hashing"; file: File; parsed: ParseResult; rows: Map<string, Blob> }
  | { stage: "uploading"; file: File; parsed: ParseResult; rows: Map<string, Blob>; pdf_sha256: string }
  | { stage: "success"; result: UploadResponse; rows: Map<string, Blob>; parsed: ParseResult; fileName: string }
  | { stage: "error"; from_stage: Exclude<State["stage"], "idle" | "success" | "error">; cause: ErrorCause };
```

The `success` state retains `rows` (for the `[Preview row]` lightbox per
§ Preview row), `parsed` (for PDF-order role grouping per § Step 5 and
the result heading), and `fileName` (for the lightbox `alt` text per
§ Screen reader copy). § Reset rule wipes them when leaving the stage.

### Per-stage UI contract

| Stage | Visible | Interactive | Label |
|---|---|---|---|
| `idle` | Drop zone | Drag-drop + file picker | "Drop your shift PDF here" |
| `parsing` | Spinner | — | (none for < 800 ms, then) "Reading the PDF…" |
| `rendering_rows` | Spinner + progress | — | "Preparing row previews… (N / total)" |
| `hashing` | Spinner | — | "Almost done…" |
| `uploading` | Spinner | — | "Saving to the server…" |
| `success` | Result list + banner | Preview / Copy / Open / Re-upload buttons | "Found N people in this PDF" |
| `error` | Full-screen error replacing the drop zone (see § Error screen layout) | "Try again" button | (per § Failure modes) |

Labels are written for the user, not the implementer. "Hashing PDF" is
correct but meaningless to a hospital colleague — "Almost done" is what
they actually need to hear. The row-render counter is kept literal
because the count is itself the trust signal (the user sees the tool
working through their colleagues one by one).

**Label delay rule** (normative): in `parsing`, render no text until 800 ms
has elapsed in that stage, then render "Reading the PDF…". This avoids a
flicker on fast PDFs.

**Reset rule**: `success → idle` and `error → idle` both wipe all state
(including the parsed result and the rendered Blobs). User expects to see
the drop zone before committing to another upload. On reset, focus
returns to the drop zone's file input so a keyboard user lands in the
right place.

**Drop-while-busy rule** (normative): `dragover` / `drop` handlers MUST
no-op when `state.stage !== "idle"`. The drop zone is not visible during
non-idle states, but the document still receives drag events globally;
ignoring them prevents an accidental second drop from racing the in-flight
pipeline. Use `e.preventDefault()` + early return — do NOT queue.

---

## Algorithm

### Step 0 — pdfjs build choice (normative)

Both the parser and the row renderer load pdfjs via the **legacy ESM
build**: `pdfjs-dist/legacy/build/pdf.mjs`. This is the same entry
`src/parser.ts` uses today (see `loadPages()` there). The legacy build:

- Runs without a Web Worker **in Node/Bun** (no `GlobalWorkerOptions.workerSrc`
  setup needed there). In **browsers**, pdfjs v4 still spawns a real worker
  regardless of which build is used — see worker-setup snippet below.
- Is the same module instance in `parser.ts` and `web/row-image.ts` —
  ESM module identity is preserved, so pdfjs is loaded once per page
  load even though two files import it.
- Eliminates the Node-vs-browser pdfjs divergence that the parser-spec
  § "Re-validation gate" calls out — both environments now use the same
  build.

**Worker setup (browser, normative).** Set `GlobalWorkerOptions.workerSrc`
once at boot, before any `getDocument()` call, in `web/main.ts`:

```ts
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
```

ESM module identity propagates the setting to the dynamic imports inside
`parse()` and `renderRowImages()`. Without this, pdfjs throws
`No "GlobalWorkerOptions.workerSrc" specified` on the first parse.

If row rendering is ever measured to exceed the budget in § Performance
budgets, the V2 move is the modern build with a worker — keep that switch
off the critical path for V1.

### Step 1 — `idle → parsing`

1. User drops a file (or picks via the hidden input).
2. Run § Pre-flight checks. Reject before transitioning if they fail.
3. Transition to `parsing`. Render spinner; arm the 800 ms label timer.
4. `const bytes = new Uint8Array(await file.arrayBuffer())`.
5. `const parsed = parse(bytes)` — from `src/parser.ts`. Throws
   `ParseError` on hard failures (see parser-spec § Failure modes).

### Step 2 — `parsing → rendering_rows`

1. Transition. Update label to `"Preparing row previews… (0 / N)"`.
2. **Compute `person_hash` for every person** via
   `await personHash(VITE_DEPARTMENT_SLUG, person.name)` (see § Identifier
   hashing). Done up front so the row Map can be keyed by hash directly
   and so Step 4 can attach hashes to the payload without re-computing.
   `Promise.all` over ~45 people is < 10 ms.
3. **Open the PDF once.** Call `getDocument({ data: bytes.slice() }).promise`
   one time, outside the per-person loop. Re-opening per row would
   re-parse the entire PDF 45× — wrong by orders of magnitude.
4. **Render each touched page once.** Collect the distinct page numbers
   referenced by `parsed.header_band.page` and every `person.row_band.page`
   (in single-page PDFs this is just page 1). For each, call
   `page.render({ canvasContext, viewport })` at scale 2.0 (= 144 DPI),
   keep the resulting canvas in a `Map<page_number, HTMLCanvasElement>`.
5. **Crop per person.** For each `person` in `parsed.people`:
   - **Always composite header strip + person row** into a fresh canvas,
     with a 4 px gutter between them. Header on top, row below. The two
     crops may come from the same source canvas (same-page case) or from
     two source canvases (multi-page case) — that's the only difference.
     - Header crop: `y_top = header_band.y_top + 5 PDF-pt margin`,
       `y_bottom = header_band.y_bottom`.
     - Row crop: `y_top = row_band.y_top`,
       `y_bottom = row_band.y_bottom − 5 PDF-pt margin`.
   - Do **not** read a single rectangle from `header_band.y_top` down to
     `row_band.y_bottom` even when both bands sit on the same page: that
     would include every colleague's row in the user's preview (privacy
     leak) and balloon each PNG to ~1.7 MP, pushing the multipart over the
     9.5 MB pre-flight on a 45-person page.
   - Convert PDF points to canvas pixels with the scale (`canvas_y =
     (page_height_pts - y_pdf) * 2`). pdfjs canvases are top-origin;
     `header_band` / `row_band` are PDF-origin (bottom-left) — flip.
   - `await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"))`.
     If `null`, throw `internal_validation_failed` (Validation rule 2 fires).
   - Store the Blob in `rows: Map<person_hash, Blob>` keyed by `person_hash`
     (computed in step 2 above).
   - Increment the label counter.
6. **Yield rule**: every 5 people, `await new Promise(r => setTimeout(r, 0))`
   so the spinner and counter actually paint.
7. Call `await doc.cleanup()` and drop the cached page canvases before
   transitioning. The Blobs in `rows` are independent of pdfjs internals.

### Step 3 — `rendering_rows → hashing`

1. Transition. Label `"Almost done…"`.
2. `const buf = await crypto.subtle.digest("SHA-256", bytes)`.
3. `const pdf_sha256 = Array.from(new Uint8Array(buf))
     .map(b => b.toString(16).padStart(2, "0")).join("")`.

### Step 4 — `hashing → uploading`

1. Transition. Label `"Saving to the server…"`.
2. Attach the `person_hash` values (already computed in Step 2.2) to the
   payload — one per person, parallel to `parsed.people`.
3. Build `FormData`:
   - Append `payload`, a `Blob([JSON.stringify(uploadPayload)], { type: "application/json" })`.
   - Append `pdf`, a `Blob([bytes], { type: "application/pdf" })` named `parsed.source.file_name ?? "upload.pdf"`.
   - For each `(person_hash, blob)` in `rows`: append `row_${person_hash}`, the blob.
4. **Total-payload pre-flight (normative).** Sum the byte sizes of the
   PDF blob, the payload JSON blob, and every row blob. If the total
   exceeds **9.5 MB** (0.5 MB headroom under the 10 MB design-doc
   ceiling), throw `payload_too_large` and transition to `error`. The
   `400`-from-server fallback still catches it server-side; the
   client-side check avoids a wasted upload over slow hospital wifi.
5. `const res = await fetch(API_BASE + "/api/upload", { method: "POST", body: fd })`.
   After this line, **`bytes` can be dropped** — `FormData` has captured
   the blob view, and nothing later in the pipeline needs the original
   `Uint8Array`. Setting the local binding to `null` lets the GC reclaim
   ~PDF-sized memory while waiting for the server.
6. Branch on `res.status` per § Failure modes.

### Step 5 — `uploading → success`

1. Transition with the parsed `UploadResponse`. The `rows: Map<person_hash, Blob>`
   from Step 2 stays in memory for the `[Preview row]` lightbox.
2. Render the result list:
   - Group `feeds` by `role`. Order roles in PDF order (use the order they
     first appear in `parsed.people`).
   - For each person, render: name, `[Preview row]`, `[Copy URL]`,
     `[Open in Google Calendar]` (see § Screen layouts and visual hierarchy
     for normative ordering and button weight).
   - If `unknown_codes.length > 0`, render the dismissable banner above
     the list.
3. Render `[Re-upload PDF]` at the bottom, which calls reset → `idle`.

### Step 6 — error transitions

Any throw at any step transitions to `error` with `{ from_stage, cause }`.
The error card renders the user copy mapped from `cause` per § Failure
modes and a "Try again" button that calls reset → `idle`.

### Pre-flight checks

Before transitioning from `idle`:

| Check | Action on fail |
|---|---|
| `file.type === "application/pdf"` (or extension `.pdf` if browser omits the type) | Stay in `idle`. Render inline error "Please drop a PDF file." under the drop zone. |
| `file.size <= 5 * 1024 * 1024` (5 MB) | Stay in `idle`. Render inline error "PDF too large (max 5 MB)." under the drop zone. |

Inline errors are red text positioned directly below the drop zone (not
a toast — no toast system in V1). The error clears on the next `dragover`
or file-picker open, so the user is never blocked by a stale message.

5 MB is chosen against the 10 MB total-multipart 413 ceiling (design doc
§ API contract). The PNGs add ~50–100 KB × ~45 rows = ~4.5 MB. A 5 MB
PDF + 4.5 MB of rows fits with headroom.

---

## Screen layouts and visual hierarchy

### Idle screen

The drop zone **is** the page on first paint. No header, no footer, no
navigation chrome — this is a two-screen internal tool and chrome that
doesn't earn its pixels gets cut.

Layout:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│                                                  │
│      ┌────────────────────────────────────┐      │
│      │                                    │      │
│      │      Drop your shift PDF here      │      │
│      │                                    │      │
│      │           or click to choose       │      │
│      │                                    │      │
│      └────────────────────────────────────┘      │
│                                                  │
│      Codes for: <VITE_DEPARTMENT_SLUG>            │
│                                                  │
└──────────────────────────────────────────────────┘
```

- Dashed-border drop target centered horizontally, vertically near the
  optical center (not geometric center — bias up ~10%).
- Drop target is a `<label for="pdf-input">` wrapping the visible UI,
  paired with a visually-hidden `<input id="pdf-input" type=file
  accept="application/pdf,.pdf">`. The input is what Tab focuses; the
  label is clickable but not focusable. **One** focus stop on this
  region, not two. The label's `:has(:focus-visible)` (or a class
  toggled from the input's focus event for older browsers) renders the
  focus ring on the visible drop target.
- Sub-label under the drop target: `Codes for: <VITE_DEPARTMENT_SLUG>` so
  the user can confirm at a glance they're on the right deployment.
- Drop target reflects drag state: idle border, dragover border + subtle
  fill tint, drop releases the file into the pipeline.

### Result page — visual hierarchy

User's primary task: find their own name and copy a URL. Optimize for the
3-second scan, not for inspection.

Hierarchy, loudest to quietest:

1. **Person name** — largest text on the row.
2. **`[Copy URL]` button** — primary affordance per row.
3. **Role caption** — small label above each group (one per role).
4. **`Open in Google Calendar` link** — secondary, less weight than Copy URL.
5. **Fallback copy under the Google link** — small grey, only when the row is hovered/focused.
6. **`Re-upload PDF`** — quiet text button at the bottom of the page.
7. **Unknown-codes banner** — only present when non-empty; see below. Sits
   *above* the role groups so it doesn't fight the result list for first focus.

Approximate row composition (normative ordering, not normative styling):

```
ma                              ← role caption, quiet
─────────────────────────────────────────────────────
Klug, J          [Preview row]   [Copy URL]  Open in Google Calendar
                                              If the button doesn't work…
─────────────────────────────────────────────────────
Baldwin, J       [Preview row]   [Copy URL]  Open in Google Calendar
...
```

The page lists everyone in PDF order within each role group. Roles
themselves are ordered by first appearance in `parsed.people`. This
matches what the user sees on the source PDF, which reduces "where am I?"
cognitive load.

### Preview row (normative)

Every row exposes a `[Preview row]` affordance — quiet text button between
the name and the primary buttons. Clicking opens a lightbox showing the
PNG that was rendered for this person during Step 2 of the pipeline. The
Blob is already in memory at `success` state (the `rows: Map<person_hash, Blob>`
from § UI state machine), so no network call is needed.

This is the **trust anchor** of the page. A colleague who's never used the
tool needs to confirm "this really is my row from the PDF" before pasting
a URL into their calendar. Without an on-page preview, the only ground
truth is the link inside each calendar event's `DESCRIPTION` field — which
they only see *after* subscribing. By then the URL is already shared.

Lightbox behavior:
- Click on `[Preview row]` allocates a Blob URL via
  `URL.createObjectURL(blob)`, sets it as the `<img>` `src`, and opens
  the dialog over a dimmed page background. On close, call
  `URL.revokeObjectURL(url)` so the browser releases its blob reference.
  Repeated open/close pairs MUST NOT leak — each open creates a new URL,
  each close revokes it.
- Click anywhere outside the image, press `Esc`, or click an `[×]` button
  closes the lightbox.
- The image is rendered at natural size with a `max-width: 95vw; max-height: 90vh`
  cap. Horizontal scroll is fine if the image is wider than the viewport
  (the PDF row is wide; users will pan).
- No download button on the preview in V1 (the row PNG goes into Google
  Calendar event descriptions; if the user wants the file, they get it there).

### Button weight rule (normative)

`[Copy URL]` is the **primary** action on every row — filled button,
strongest visual weight. `Open in Google Calendar` is **secondary** — a
text-style link or quiet button next to it. Rationale: Copy URL is the
universal action (Google, Apple, anything else); the Google deep link is
fragile (design doc § visual sketch flags this). The user should never
land on a broken primary action because Google changed their URL pattern.

### Copy-feedback rule (normative)

When the user clicks `[Copy URL]`:

1. Write `feed.webcal_url` (verbatim, with the `webcal://` scheme — that
   is what Apple Calendar's "Subscribe by URL" wants) to the clipboard
   via `navigator.clipboard.writeText`.
2. Swap the button label from `Copy URL` to `Copied!` immediately.
3. After exactly **1500 ms**, swap back to `Copy URL`.
4. The button stays enabled throughout — repeated clicks work; each click
   re-arms the 1500 ms timer.

No toast, no icon. Inline state change. If `clipboard.writeText` rejects
(very rare — Safari/old browsers), the label swaps to `Copy failed` for
the same 1500 ms, then back. No retry path needed in V1.

### Error screen layout (normative)

The `error` state replaces the page contents — same vertical-center
treatment as the drop zone, no inline overlay or modal. Layout:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│                                                  │
│      Something went wrong.                       │
│                                                  │
│      {user-visible error copy per § Failure      │
│       modes — large enough to read, not tiny}    │
│                                                  │
│      {one-sentence suggested action, smaller}    │
│                                                  │
│      [ Try again ]                               │
│                                                  │
└──────────────────────────────────────────────────┘
```

`[Try again]` calls reset → `idle`. No "Report this" or "Contact support"
button in V1 — the deployment is internal and the maintainer hears about
errors directly. The error stage drops all parsed data and Blobs before
returning, so the user starts clean.

### Open in Google Calendar — URL format

Normative. The button's `href` is:

```
https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal_url)}
```

`webcal_url` comes from the upload response (e.g., `webcal://pdf2calendar.example.com/feed/<hash>.ics`).
The encoder converts `:` and `/` to percent-encoded bytes — required, or
Google strips them.

### Fallback copy (verbatim)

Rendered as small grey text directly under the `[Open in Google Calendar]`
button on every row:

> If the button doesn't work: 1) Copy this URL. 2) In Google Calendar,
> click '+' → 'From URL' and paste.

This text is **normative**. Do not paraphrase. The Google Calendar deep
link has broken historically; the fallback keeps users unblocked when it
does.

### Unknown-codes banner

Dismissable yellow info banner at the top of the result page, shown only
when `unknown_codes.length > 0`. Structure:

- `<h2>` heading: **"Unrecognized codes"** — visible, sized at
  `--text-lg`, sits at the top of the banner so screen-reader users get
  a real heading they can navigate to with the headings list, and
  sighted users see the banner's purpose without parsing the body.
- Body copy:

  > These codes weren't recognized and were skipped: `X, Y, Z`. Email
  > your admin to add them.

- Dismiss `<button aria-label="Dismiss">` top-right.

The visible `<h2>` replaces the bare `aria-label="Unrecognized codes"`
on the region (the region's `aria-labelledby` now points at the heading
— see § Accessibility → ARIA roles).

Informational tone, not error. The codes appear inline, comma-separated,
in monospace. Dismissing the banner does not persist — re-uploading shows
it again if codes are still unknown. (No localStorage in V1.)

### Re-upload

`[Re-upload PDF]` calls reset → `idle`. The drop zone reappears. All
parsed data, Blobs, and the previous result are dropped from memory. No
silent re-pipeline on a fresh file pick — the user sees the drop zone
before committing.

### Highlight-your-own-row

**Not in V1.** Every mechanism has friction (URL param, prompt,
localStorage) and the role-grouped list is already the moment-of-magic.
Tracked in § Open questions.

### Minimum-viable design tokens (normative)

No project-wide `DESIGN.md` exists. Rather than reinvent on the fly, the
spec fixes a small token set. Implementations declare them as CSS custom
properties in `:root` so they're inspectable and overrideable.

```css
:root {
  /* spacing — 4px base scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  /* type scale */
  --text-xs: 12px;   /* fallback copy, role captions */
  --text-sm: 14px;   /* secondary buttons, banner body */
  --text-base: 16px; /* body, names */
  --text-lg: 20px;   /* progress labels, banner heading */
  --text-xl: 28px;   /* drop zone main line, error screen heading */

  /* font: commit intentionally to system stack — no custom typeface in V1 */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
               Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  /* color — neutral surface, single accent */
  --bg: #ffffff;
  --bg-muted: #f6f6f6;          /* drop-zone fill, dragover tint */
  --text: #111111;
  --text-muted: #6b6b6b;        /* role captions, fallback copy */
  --border: #e5e5e5;            /* row dividers, drop-zone border */
  --accent: #1a5fb4;            /* primary button, focus ring */
  --accent-fg: #ffffff;         /* text on accent */
  --warning-bg: #fff8e1;        /* unknown-codes banner background */
  --warning-border: #f0c419;    /* unknown-codes banner border */
  --error: #b3261e;             /* inline pre-flight error text, error screen */

  /* radius — one small value, applied sparingly */
  --radius: 4px;

  /* misc */
  --focus-ring: 0 0 0 2px var(--accent);
}
```

System fonts are an intentional choice, not a default. Rationale: this
runs on hospital workstations across browsers and OSes; loading a web
font adds latency, CLS, and a license decision for an internal tool that
doesn't need a brand. If a future fork wants a brand, override `--font-sans`.

If the project later wants a full design system (multiple deployments,
shared styling, dark mode), run `/design-consultation` and lift the
output into `DESIGN.md`. Until then, these tokens are the system.

### Visual treatment guardrails (normative)

Defaults the implementer must not violate. Not a style guide — these are
the patterns that turn a quiet internal tool into generic SaaS:

| Forbidden | Required |
|---|---|
| Icons inside colored circles as role indicators | Role captions are plain text |
| Emoji as decoration (no 📅, ✅, 🚀, 📄, etc.) | Plain glyphs only |
| Centered text on the result list (each row left-aligned) | Result list and rows left-aligned |
| Per-row card with shadow / colored left border | Rows separated by hairline dividers; no card chrome |
| Decorative SVG blobs, wavy dividers, gradient overlays | Flat backgrounds; structure carries the design |
| Generic hero copy on the drop zone ("Welcome to…", "Convert PDFs in seconds!") | Literal task language: "Drop your shift PDF here" |
| Multiple accent colors competing for attention | One accent color, used for the primary button + drag-over fill tint |
| Default system font stack as a passive choice (`-apple-system, …`) | Either pick one real typeface and name it, or commit to system fonts intentionally and say so |

These are App UI rules — the tool is workspace-driven, not brand-driven.
"As little design as possible" (Rams) is the posture: structure does the
work; ornament is the enemy.

---

## Responsive behavior

The tool is used on hospital workstations (desktop) and on colleagues'
phones (small screens, no drag-drop). Both must work.

### Breakpoints

Two viewport tiers, mobile-first:

| Tier | Width | Notes |
|---|---|---|
| Mobile | ≤ 640 px | One-handed phone use; no hover; touch-only |
| Desktop | > 640 px | Drag-drop primary affordance |

No tablet-specific tier. Tablets in portrait pick mobile; in landscape
pick desktop — both work.

### Idle screen — mobile rules

- Drop-zone copy swaps from `Drop your shift PDF here` to
  `Choose your shift PDF` — drag-drop is undiscoverable on phones, so
  the visible affordance becomes the file picker.
- The whole drop target is the button; tap opens the native file picker.
- Sub-label (`Codes for: …`) stays.

### Result page — mobile rules

Each row reflows from one line to two:

```
Klug, J                                                [Preview row]
[Copy URL]            Open in Google Calendar
  If the button doesn't work…
```

- Name + `[Preview row]` on the first line (name left, button right).
- `[Copy URL]` + `Open in Google Calendar` on the second line.
- Fallback copy stays under the Google link, always visible on mobile
  (hover-on-desktop reveal does not work).
- Role caption stays as a small text divider between groups.

### Lightbox — mobile rules

- `max-width: 100vw`, `max-height: 100vh` — fills the screen.
- Pinch-zoom enabled (do **not** set `user-scalable=no` in the meta viewport
  for this site; the lightbox needs it).
- Close button (`[×]`) is at least 44 × 44 px and pinned top-right with
  `position: fixed`.

## Accessibility (normative)

### Keyboard

- Tab order matches visual order: hidden file `<input>` (the only
  focusable element in the drop region — see § Idle screen), then on
  success: banner dismiss (if shown) → first row's `Preview` →
  `Copy URL` → `Open in Google Calendar` → next row → … → `Re-upload`.
- All buttons reachable by Tab, activatable by Enter or Space.
- Focus ring is visible on every focusable element. Use `--focus-ring`
  (see § Minimum-viable design tokens). Never `outline: none` without
  a replacement.
- Lightbox traps focus while open. Esc closes it. Focus returns to the
  `[Preview row]` button that opened it.

### Touch targets

Every interactive element is at least **44 × 44 px**. This includes
`[Preview row]`, `[Copy URL]`, the banner dismiss `×`, and the lightbox
close `×`. Padding counts toward the target; don't ship 24 px buttons
with 24 px text.

### ARIA roles

| Element | Role / Attributes |
|---|---|
| Inline pre-flight error under drop zone | `role="alert"` (announces immediately) |
| Progress label during pipeline | `role="status"` `aria-live="polite"` |
| Unknown-codes banner | `role="region" aria-labelledby="<heading-id>"` referencing the visible `<h2>`; dismiss `<button aria-label="Dismiss">` |
| Lightbox | `role="dialog" aria-modal="true" aria-label="Row preview for {name}"` |
| Error screen heading | `<h1>` so screen readers announce the page change |

### Screen reader copy

- Drop zone: the file input has `<label>` text "Upload a shift PDF" even
  if the visible label says "Drop your shift PDF here".
- Row preview image: `alt="Schedule row for {name} from {file_name}"`.
  The implementer reads `{file_name}` from the local upload state
  (the same `source_file_name` we sent in `payload`). The response does
  not echo it back — we already have it.
- Re-upload button: visible text is enough; no extra `aria-label`.

### Contrast

Token colors must meet **WCAG AA**:

- `--text` on `--bg`: 16.6 : 1 (passes).
- `--text-muted` on `--bg`: must be ≥ 4.5 : 1 for body, ≥ 3 : 1 for large
  text (≥ 18.66 px). `#6b6b6b on #ffffff` is 5.74 : 1 — passes.
- `--accent-fg` on `--accent`: `#ffffff on #1a5fb4` is 6.4 : 1 — passes.
- `--error` on `--bg`: `#b3261e on #ffffff` is 5.99 : 1 — passes.

If a fork overrides any token, the implementer is responsible for re-checking.

### Reduced motion

Respect `prefers-reduced-motion: reduce`:
- Skip the dragover background-tint transition (jump instead of fade).
- Skip the spinner animation; render a static "Working…" label instead.
- Banner dismiss is instant (no slide-out).

---

## Failure modes

Every error path returns to `idle` via a "Try again" button.

### Parse errors (typed `ParseError` from parser-spec § Failure modes)

| Code | User copy | Recovery |
|---|---|---|
| `no_text_layer` | "This PDF doesn't have selectable text — it's an image scan. Ask the schedule maintainer for the original (not a scan)." | Try again with a different file |
| `day_row_not_found` | "Couldn't find the row of day numbers. The PDF layout may have changed — please report this." | Try again |
| `too_many_months` | "This PDF covers more than 2 months. V1 supports up to two months per upload." | Try again with a shorter range |
| `multiple_tables` | "This PDF has more than one schedule on a page. V1 supports one table at a time." | Try again |
| `empty_pdf` | "This PDF appears to be empty." | Try again |
| `internal_validation_failed` | "Parser self-check failed: {check}. This is a bug — please report it." | Try again |

### Upload errors

| Status | User copy | Recovery |
|---|---|---|
| 400 | "Server rejected the upload: {error.message}." | Try again |
| 413 | "Upload too large for the server (max 10 MB total)." | Try again with a smaller PDF |
| 415 | "Server rejected the file type." | Try again |
| 429 | "Too many uploads. Try again in {retry_after}s." | Try again later |
| 500 | "Server error — please try again. If it keeps failing, report it." | Try again |

If the body contains `{ error: string }`, splice it into the 400 copy.
Otherwise show the generic line.

### Client-side pre-flight errors (pipeline aborts before fetch)

| Cause | User copy | Recovery |
|---|---|---|
| `payload_too_large` (total multipart > 9.5 MB; see § Step 4) | "Your PDF plus the row previews total more than 10 MB — the server won't accept it. Try a smaller PDF." | Try again with a smaller PDF |

### Unexpected errors

| Cause | User copy | Recovery |
|---|---|---|
| `fetch` throws (network down, DNS, CORS) | "Couldn't reach the server. Check your connection and try again." | Try again |
| 200 OK but `Content-Type` is not `application/json` (Validation rule 4) | "Server returned an unexpected response. Refresh and try again." | Refresh |
| Any other throw | "Something went wrong: {message}. Refresh and try again." | Refresh |

---

## Validation rules

The pipeline self-checks at the boundaries.

1. After Step 1 (`parsing`): assert `parsed.people.length >= 1`. If zero,
   transition to `error` with cause "No people found in this PDF."
2. After Step 2 (`rendering_rows`): assert `rows.size === parsed.people.length`.
   Internal invariant — if it fails, this is a bug, not a bad PDF.
3. Before fetch in Step 4 (`uploading`): assert `FormData` has exactly
   `2 + parsed.people.length` parts (`payload` + `pdf` + N row PNGs),
   AND assert the total payload byte sum is ≤ 9.5 MB. The latter
   triggers `payload_too_large` per § Failure modes if it fails.
4. After Step 4: assert `res.headers.get("content-type")` starts with
   `application/json` on 2xx. If not, treat as an unexpected error.

### Performance budgets (normative)

Restating design doc § Open Questions #6 and adding row-render and
total-pipeline targets:

| Stage | Budget | If exceeded |
|---|---|---|
| Parse | < 2 s | Move pdfjs to a Web Worker (V2 if it bites in practice) |
| Row render | ≤ 1 s per page for ~45 rows | Drop DPI from 144 to 96, or render lazily on result-page row click |
| Total client pipeline (parse + render + hash) | < 5 s on mid-range laptop | Investigate which stage exceeds; do not pre-optimise |

The 800 ms label rule in § UI state machine is calibrated against these
budgets — most PDFs finish parsing before any text appears.

---

## Test plan

### Unit tests (`bun test`)

Bun is the test runner already used by `test/parser.test.ts` and
`test/ics.test.ts` — same harness, no new dev dep.

| File | Asserts |
|---|---|
| `web/state.test.ts` | State machine transitions: every `(stage, event) → next_stage` path; reset behavior; that `error` records `from_stage`; that drop/dragover are no-ops when `stage !== "idle"`; that pre-flight checks (file type, file size > 5 MB) stay in `idle` and surface inline. No DOM. |
| `web/row-image.test.ts` | Given a fixture PDF + a `ParsedPerson` + a `header_band`, returns a PNG `Blob` whose `size > 0` and dimensions match `144 / 72 * (header_band.height + row_band.height + 10)`. No pixel-diff — too brittle. Includes one multi-page fixture case (header on page 1, row on page 2) covered when such a fixture exists; until then, the multi-page composition path is verified by code review only and tagged in the manual test. |
| `web/pdf-hash.test.ts` | Known input bytes → known 64-hex output. Cross-check against `bun run` `crypto.createHash("sha256")` for the same bytes. |
| `web/person-hash.test.ts` | `normalize()` cases: NFC composition (`"é"` → `"é"`), case (`"KLUG, J"` → `"klug, j"`), trim + collapse (`"  Klug,   J  "` → `"klug, j"`), trailing punctuation (`"Klug, J."` → `"klug, j"`). `personHash()` cross-check: `("anesthesia-chuv", "Klug, J")` produces the same 16-hex prefix the server computes. Fixture file is **shared** with the server side once that's implemented — copy or symlink, not retype. |
| `web/api.test.ts` | Multipart shape: assert exactly `2 + N` parts, content-types correct, part names match `payload`, `pdf`, `row_<hash>`. Total byte sum check (`payload_too_large` fires above 9.5 MB). Error mapping: mock `fetch` returning each status code and assert the right cause is emitted, including 200 with non-JSON content-type (Validation rule 4) and 429 with `Retry-After` parsed into `{retry_after}`. |

Row-image tests require a headless DOM for `canvas.toBlob`. Use the same
`pdfjs-dist` Node entry the existing parser tests use; if `canvas`
behaviour differs (Node has no built-in canvas), gate `web/row-image.test.ts`
behind an env flag and document it. Do **not** add a heavy headless-browser
dep for V1.

### Browser-vs-Node parser parity check (normative)

Parser-spec § "Re-validation gate" requires the browser to produce
byte-identical parse output to the Node-side probe. The check is
inexpensive once the frontend exists:

1. `bun scripts/probe.ts example_data/1_mai_21.04.2026.pdf > out/probe-1.json`
   (and the other fixture).
2. Add a one-time `web/main.ts` developer flag (or a side script that
   imports `parse()` and serializes the result) that runs the same PDFs
   through the browser pipeline and prints the JSON.
3. `diff` the two outputs. They MUST be identical in `people`,
   `header_band`, `months`, `date_range`. Drift here means the browser
   and Node pdfjs builds disagree on text-item ordering — file a parser
   issue before shipping.

This check runs once per fixture per pdfjs upgrade, not in CI. With Step 0
mandating the legacy build in both environments, the divergence surface
is small but not zero.

### Manual smoke test

Create `docs/manual-upload-test.md` in the same shape as
`docs/manual-deletion-test.md`. Steps:

1. Run `bun run dev` (Vite dev server).
2. Drop `example_data/1_mai_21.04.2026.pdf`. Verify result lists ~45 people
   grouped by role; spot-check Klug, J appears under `ma`.
3. Click `[Preview row]` on your own row. Confirm the lightbox shows the
   PNG of your row from the PDF. Close it via `[×]`, then again via `Esc`.
4. Click `[Copy URL]` on your row. Confirm the button label swaps to
   `Copied!` and reverts to `Copy URL` after ~1.5 s. Confirm the URL is
   actually on the clipboard (paste into a scratch field).
5. Click `[Open in Google Calendar]` on your own row. Confirm the subscribe
   prompt shows the right URL.
6. Add the calendar to a real Google account. Wait. Verify shifts appear.
7. Drop `5_Mars2026_26.03_30.04.2026.pdf`. Verify it spans both months and
   that any `unknown_codes` show in the yellow banner at the top. Dismiss
   the banner; confirm it stays dismissed for this session.
8. Force each error path: drop a non-PDF (inline error under the drop
   zone); drop a 20 MB PDF (size pre-check inline error); drop a PDF
   that's exactly inside the 5 MB limit but whose rendered rows push the
   multipart over 10 MB (full-screen `payload_too_large` — synthesize by
   temporarily lowering the 9.5 MB cap in `web/api.ts` for the test);
   kill the backend and drop a PDF (full-screen error → `[Try again]`).
9. On a phone (or DevTools narrow viewport ≤ 640 px): confirm the drop
   zone copy reads "Choose your shift PDF", that each result row renders
   on two lines, and that the lightbox fills the screen with pinch-zoom
   working.
10. Keyboard-only pass: Tab through the result page. Confirm every button
    is reachable in visual order, focus rings visible, Enter activates,
    Esc closes the lightbox and returns focus to the `[Preview row]` button.

### Non-requirements

**No Playwright, Cypress, or other headless-browser test rigs in V1.**
The UI surface is small enough that the manual test plus the unit tests
above catch what matters.

---

## Out of scope (V1)

- No OAuth, no auth on the upload page (lives behind whatever the deployment puts in front of nginx).
- No in-browser codes-table editor.
- No diff/preview between current and new feed.
- No `.ics` download — subscribe-by-URL only (per design doc § Constraints).
- No highlight-your-own-row.
- No multi-file upload, no folder drag.
- No analytics, no telemetry, no error reporting.
- No i18n — UI strings hardcoded English.
- No service worker, no offline mode.
- No re-render of row images on the result page from a re-fetched PDF —
  the renderer only runs at upload time.
- No dark mode. Token set is light-only; a fork that wants dark mode
  overrides `--bg`, `--text`, and related tokens.
- No multi-department picker on the upload page. The deployment is the
  picker (one slug per deployment, set at build time).

If a user hits any of the above, V1 either ignores it or surfaces an error
via § Failure modes.

---

## Open questions

1. **Highlight-your-own-row.** Which V2 mechanism — `?me=<person_hash>` query
   param (cheap, stateless, shareable) or first-visit prompt (more friction,
   one-time)? Defer until one colleague asks for it.
2. **`VITE_API_BASE_URL` default.** Currently same-origin; local dev sets it.
   If local dev becomes painful (CORS, port juggling), flip to "required"
   and document both deployments and local dev.
3. **Caption on row PNGs.** Should `web/row-image.ts` bake a 1-line caption
   (person name + date range) onto the rendered PNG before `toBlob`? Design
   doc is silent. Pro: a colleague who saves the PNG knows what they're
   looking at. Con: more rendering code, more breakage surface. Defer until
   a user reports the missing context.
4. **Re-upload button placement.** Currently bottom-of-page only. With 45
   names the scroll is non-trivial. Should there be a second re-upload
   button at the top (sticky header) or near the unknown-codes banner?
   Defer until a user reports the friction.
5. **Sort order within a role group.** Currently PDF order (matches what
   the user sees on the source). Alphabetical would be faster to scan if
   the user already knows their name. Defer to V2; PDF order is the safer
   default since it preserves the trust signal "same order as the PDF".
6. **Lightbox zoom behavior.** Natural-size with viewport caps assumes the
   PDF row is roughly fitting. If real rows are far wider than tall (likely),
   the user has to scroll horizontally. A "fit-to-viewport on first paint,
   tap to zoom to 100%" interaction may be better — but adds gesture
   handling. Defer until the manual smoke test reveals which feels worse.
