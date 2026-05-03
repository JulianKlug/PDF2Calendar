# Parser Specification

Status: APPROVED (2026-05-03)
Owner: @klug
Related: design doc at `~/.gstack/projects/JulianKlug-PDF2Calendar/klug-main-design-20260503-093154.md`

---

## Purpose

A pure function that turns a hospital shift-schedule PDF into structured data:
people, dates, codes. No I/O, no side effects, no DOM. Same input → same output.

```ts
parse(pdf: Uint8Array): ParseResult
```

The parser is the **gate** for the whole project. If it can't reliably extract
the grid from the two example PDFs, the architecture in the design doc does not
work and we change course before writing any server code.

---

## Inputs

| Field | Type | Notes |
|---|---|---|
| `pdf` | `Uint8Array` | Raw PDF bytes. Must have a text layer. Image-only / scanned PDFs are rejected. |

The same parser runs in two environments:

1. **Browser** (production): called from the upload page using `pdfjs-dist` ESM.
2. **Node/Bun** (CI + local probe): called by the feasibility probe and tests, also using `pdfjs-dist`.

There must be **one** parser implementation. Any environment-specific glue
(worker URL, font config) is set up at the call site.

---

## Output schema

```ts
type ParseResult = {
  source: {
    file_name: string | null;       // optional — caller passes if known
    page_count: number;
    parsed_at: string;              // ISO 8601 UTC
    page_dims: PageDims[];          // one per page; needed by the row-image renderer
  };
  department: string | null;        // best-effort from header text; often null
  date_range: {
    start: string;                  // "YYYY-MM-DD" — first column
    end: string;                    // "YYYY-MM-DD" — last column
  };
  // Y-bounds (PDF points, origin bottom-left) of the header strip
  // (month band + day numbers + weekday letters). Used by the row-image
  // renderer to crop "person row + header" PNGs on upload. See design doc
  // §"Per-person row images" for context.
  header_band: { page: number; y_top: number; y_bottom: number };
  months: ParsedMonth[];            // one entry per (year, month) the PDF touches
  people: ParsedPerson[];           // flat list, in PDF order
  unknown_codes: string[];          // distinct codes not in the V1 dictionary
  warnings: ParseWarning[];         // non-fatal issues (see "Failure modes")
};

type PageDims = {
  page: number;                     // 1-indexed
  width: number;                    // PDF points
  height: number;                   // PDF points
};

type ParsedMonth = {
  year: number;                     // e.g., 2026
  month: number;                    // 1–12
  days_covered: number[];           // sorted day numbers present in the PDF for this month
                                    // e.g., March covered = [23,24,...,31]; April = [1,2,...,30]
};

type ParsedPerson = {
  role: string;                     // "cdc", "ma", etc. — lowercased, trimmed
  name: string;                     // raw, as it appears in the PDF (e.g., "Klug, J")
  // One entry per column in the PDF. Length === total day count across all months.
  // Each entry's date is unambiguous (year + month + day).
  days: ParsedDay[];
  // Y-bounds (PDF points) of this row on its page. Used by the row-image
  // renderer to crop "header + this row" into a PNG.
  row_band: { page: number; y_top: number; y_bottom: number };
};

type ParsedDay = {
  date: string;                     // "YYYY-MM-DD"
  codes: string[];                  // raw code strings from the cell, in left-to-right order
                                    // empty array = blank cell
};

type ParseWarning =
  | { kind: "duplicate_name"; name: string; rows: number[] }
  | { kind: "row_length_mismatch"; name: string; expected: number; got: number }
  | { kind: "month_band_inference"; reason: string }
  | { kind: "unrecognized_role_header"; text: string; row: number }
  | { kind: "header_missing_year"; assumed_year: number };
```

### Why `codes` is `string[]` (not `string`)

In the example PDFs, some cells visibly contain two adjacent code tokens
(e.g., `Cw13 Cw13`, or training combined with another marker). The parser
preserves them as a list and lets the downstream code mapper decide whether
each token produces a calendar event. The parser does not deduplicate.

### Why no `category` / `kind` field on days

Code interpretation (timed vs all-day vs skip) lives in `codes.ts`, **not**
the parser. The parser only does grid recovery. This keeps the parser stable
when the codes table changes.

### Why y-bounds on rows + header

The design includes a "view your row" feature: every calendar event's
`DESCRIPTION` links to a PNG of the source PDF cropped to that person's
row plus the header. Rendering happens in the browser at upload time
(canvas + `pdfjs-dist`). The parser is the only thing that knows where
each row sits on the page, so it emits y-bounds for the renderer. The
renderer crops `[header_band.y_top → row_band.y_bottom]` and saves
`<pdf-hash>/<person-hash>.png`. Parser stays pure; renderer is a
separate ~30-line module.

---

## Algorithm

### Step 0 — Probe text layer

Use `pdfjs-dist` `getDocument()` then `getTextContent()` per page. Each text
item exposes:

- `str` — the literal text fragment
- `transform[4]` — x position (PDF points, origin bottom-left)
- `transform[5]` — y position (PDF points, origin bottom-left)
- `width`, `height` — bounding box

If `getTextContent()` returns zero items on every page, the PDF has no text
layer (scanned image). Throw `ParseError("no_text_layer")`. We do not fall
back to OCR.

### Step 1 — Identify the day-number row

The day-number row is the anchor for the entire grid. Strategy:

1. Bucket all text items by y (within ±2 points → same row).
2. For each row, count items whose `str` is a 1- or 2-digit integer in `[1, 31]`.
3. The day-number row is the row with the **most** such tokens (ties → topmost).
4. Sort that row by x. Record each token's `(x_center, day_number)`.

The count of day-number tokens establishes the **column count** (≈ 28–42).

If no row has ≥ 20 day-number tokens, throw `ParseError("day_row_not_found")`.

### Step 2 — Identify the month-band row

The row immediately above the day-number row contains one or more **month
band labels** like `MARS 2026`, `AVRIL 2026`. They span multiple columns each.

For each text item in this row:

1. Match `^([A-ZÉÈÀ]+)\s+(\d{4})$` (case-insensitive).
2. Map the French month name (`JANVIER`…`DÉCEMBRE`) to its number 1–12.
3. Record `(x_start, x_end, year, month)` using the item's bounding box.

If the month-band row is missing or unparseable, fall through to **Step 3.5
(inference)** below.

### Step 3 — Identify the weekday-letters row

The row immediately below the day-number row contains French weekday
abbreviations (`lun.`, `mar.`, `mer.`, `jeu.`, `ven.`, `sam.`, `dim.`).
Used as a sanity check, not authoritative. We trust the day numbers + month
bands.

### Step 3.5 — Assign each column a full date

For each `(x_center, day_number)` in the day-number row, find which month
band's `[x_start, x_end]` contains `x_center`. That gives `(year, month, day)`.

**If month bands are missing** (parser could not find them):

- Walk the day numbers left to right.
- Detect transitions where `day(i) < day(i-1)` (e.g., `31 → 1`). Each transition
  starts a new month, +1 from the previous.
- For the **first** month, look at:
  1. The PDF filename if passed in (e.g., `5_Mars2026_…` → March 2026)
  2. Otherwise scan all text items for any `MMMM YYYY` pattern in French.
  3. Otherwise emit `header_missing_year` warning and assume current year.
- For year rollover (December → January), bump the year.

After Step 3.5, every column has an unambiguous `YYYY-MM-DD`. This is the
key invariant — every later step depends on it.

### Step 4 — Identify person rows

A person row has these properties:

- y is **below** the weekday-letters row.
- The leftmost text item is non-numeric and matches a name pattern: `Lastname, F` or `Lastname, F.` (comma-separated, French convention).
- The next text item to the right is a short role tag (`cdc`, `ma`, etc.) — but role may also live in its own column to the left of the name.

Strategy:

1. Bucket all items below the weekday row into y-rows (±2 points).
2. For each row, identify role + name:
   - Role tokens are short lowercase strings in `{cdc, ma, ...}` (allow extension via config).
   - Name tokens match `/^[A-ZÉÈÀÂÊÎÔÛÄËÏÖÜÇ][\p{L}\-' ]+,\s?[A-Z]\.?$/u`.
3. If neither matches, emit `unrecognized_role_header` and skip the row (likely a section header like "Role  Nom").

### Step 5 — Extract cells per row

For each person row:

1. For each column `c` (defined by `x_center` from Step 1), collect text items in this y-row whose `x_center` falls within `[x_center(c) - col_width/2, x_center(c) + col_width/2]`.
   - `col_width` = median spacing between consecutive `x_center` values.
2. Sort the collected items by x.
3. The cell value is the list of their `str` values, **trimmed**, after removing empty strings.
4. If the cell is empty, `codes: []`.

### Step 6 — Validate and emit warnings

- **duplicate_name**: if two rows produce the same `name`, warn (don't merge — they may be different people; let the user disambiguate).
- **row_length_mismatch**: if a row's column count differs from the day-number row count, warn and pad/truncate as needed.
- **unknown_codes**: collect distinct `code` strings across all rows that don't appear in the V1 codes dictionary. Return as `unknown_codes: string[]`.

---

## Multi-month handling (the headline case)

The two example PDFs already show both shapes:

| Filename | Title in header | Actual range | Months covered |
|---|---|---|---|
| `1_mai_21.04.2026.pdf` | "MAI 2026" | TBD (probe will tell us) | likely just May 2026 |
| `5_Mars2026_26.03_30.04.2026.pdf` | "MARS 2026" + "AVRIL 2026" | Mon 23 Mar → Thu 30 Apr | March 2026 + April 2026 |

The second case is the one the user explicitly called out. The parser handles
it by:

1. **Trusting column day-numbers + month bands**, not the filename or title text.
2. Treating `months: ParsedMonth[]` as a **list**, not a single value.
3. Storing one `date: "YYYY-MM-DD"` per cell, so downstream code never has to
   re-derive which month a column belongs to.

### Edge cases the spec must handle

| Case | Behavior |
|---|---|
| Single-month PDF (all 28–31 days within one month) | `months.length === 1`, no transition logic needed. |
| Two-month PDF, both bands present | `months.length === 2`, columns assigned via x-bounds of bands. |
| Two-month PDF, one band missing or merged | Fall back to day-number reset detection (Step 3.5). |
| Year rollover (Dec → Jan) | When transition crosses December, bump year. |
| Three+ month PDF | Not supported in V1. Throw `ParseError("too_many_months")` if detected. (Real schedules don't span > 6 weeks.) |
| Two months side-by-side (separate tables on same page) | Not supported in V1. Throw `ParseError("multiple_tables")` if detected. |
| Same PDF, multiple pages, each one full month | Supported: parse each page's grid, merge `people` by name (concatenate `days` in date order). |

---

## Code dictionary reference

The parser does **not** validate codes against the dictionary at parse time —
it only flags unknowns. The dictionary lives at `src/codes.ts`; the
human-readable source of truth is `docs/Codes.md`. V1 dictionary covers:

`N13, Nw13, N46, Nw46, L1–L6, Lw1–Lw6, C1–C6, Cw1–Cw6, T, T2, P, E, DTC,
SIM, V, SC, FI, FE, CHV, CAR, X, MAL, CP`

(See `docs/Codes.md` for shift hours and `src/codes.ts` for the executable
mapping.)

`°` and `*` prefixes are NOT separate codes — they mark a shift as
"to be confirmed". The parser preserves them as raw strings; the iCal
generator strips the prefix and looks up the base code, then emits
`STATUS:TENTATIVE`.

Anything else → goes into `unknown_codes`. Frontend will surface this so the
user can either edit the dictionary (V2) or accept the cell as ignored.

---

## Failure modes

### Hard failures (throw `ParseError`)

| Error code | Trigger |
|---|---|
| `no_text_layer` | `getTextContent()` returns zero items on every page. |
| `day_row_not_found` | No row has ≥ 20 day-number tokens. |
| `too_many_months` | More than 2 distinct months detected. |
| `multiple_tables` | More than one day-number row found per page. |
| `empty_pdf` | 0 pages or all pages empty. |

`ParseError` includes the failing page index and a short diagnostic string.
Frontend renders this directly so the user knows what to fix.

### Soft failures (warnings, parsing continues)

See `ParseWarning` union in the schema. Warnings never block output —
they're metadata for the upload UI to surface.

---

## Validation rules

After Step 6, the parser self-checks before returning:

1. `date_range.end >= date_range.start`
2. Every `person.days[i].date` matches the i-th column's date
3. `people.length` is in `[1, 100]` (sanity check; warn if outside)
4. Each `person.days.length === total_columns`
5. `unknown_codes` is sorted + deduplicated
6. `months` is sorted by `(year, month)`

If any check fails, throw `ParseError("internal_validation_failed", {check})`.
Internal-validation failures indicate a parser bug, not a bad PDF.

---

## Test fixtures

Live in `example_data/` and (later) `test/fixtures/`.

| Fixture | Purpose |
|---|---|
| `1_mai_21.04.2026.pdf` | Single-month case (May 2026) |
| `5_Mars2026_26.03_30.04.2026.pdf` | Two-month case (Mar + Apr 2026) |
| `_synthetic/year_rollover.pdf` | TODO — Dec/Jan crossover |
| `_synthetic/scanned_image.pdf` | TODO — must throw `no_text_layer` |
| `_synthetic/three_months.pdf` | TODO — must throw `too_many_months` |

Tests will assert on a known-good `ParseResult` snapshot for each real fixture
and on specific error codes for the synthetic ones.

### Spot-check assertions for `5_Mars2026_…`

To prove the multi-month logic works, the test asserts:

- `months.length === 2`
- `months[0] === { year: 2026, month: 3, days_covered: [23,24,25,26,27,28,29,30,31] }`
- `months[1] === { year: 2026, month: 4, days_covered: [1,2,…,30] }`
- `date_range === { start: "2026-03-23", end: "2026-04-30" }`
- `people` includes `{ role: "ma", name: "Klug, J", days: [...] }` with `days.length === 39`
- `people.find(p => p.name === "Klug, J").days[0].date === "2026-03-23"`
- `people.find(p => p.name === "Klug, J").days[38].date === "2026-04-30"`

---

## Out of scope (V1)

- OCR / image-only PDFs
- Hand-written annotations
- Non-French locale (English/German month names)
- Color information (the colored cells in the PDF are decorative; the code text is authoritative)
- Cell formatting (bold, italic) — never load-bearing
- More than 2 months in a single PDF
- Multiple separate tables on a single page
- Columns that aren't day-of-month (e.g., a "Total" summary column at the right)

If a real PDF in production hits one of these, the parser throws and the user
sees a clear error. We'd rather block than silently misparse.

---

## Open questions

1. **Title row vs. filename: tiebreak rule.** ✅ Resolved 2026-05-03: parser
   ignores both. It only uses column day-numbers + month bands to assign
   dates. Filename is consumed by the upload UI / server for display labels
   and version detection — never by the parser.

2. **Multi-page PDFs.** ✅ Resolved 2026-05-03: punt until we see one. V1
   throws `multiple_tables` if more than one day-number row is detected.
   When a real multi-page PDF surfaces in production, revisit with the
   actual shape in front of us.

3. **Department detection.** ✅ Resolved 2026-05-03: baked-in
   `VITE_DEPARTMENT_SLUG` env var per deployment. Parser leaves
   `department: null`. Server fills it in. One deployment serves one
   department; if multi-tenancy is ever needed, switch to an upload-time
   dropdown then.

4. **`°` and `*` prefixes.** ✅ Resolved 2026-05-03: these are
   "to be confirmed" flags. Parser preserves the raw string (`°C2` stays
   `°C2`). `codes.ts` strips the prefix to look up the base code, then
   marks the resulting iCal event as `STATUS:TENTATIVE` instead of
   `STATUS:CONFIRMED`. Google Calendar renders tentative events as faded
   so the colleague can tell at a glance.

5. **Empty cells vs. explicitly-blank.** ✅ Resolved 2026-05-03:
   whitespace = "no shift". Parser treats both empty and whitespace-only
   cells as `codes: []`. Downstream: no event emitted; if a prior version
   had a code on that day, the diff produces a tombstone.

6. **Performance budget.** ✅ Resolved 2026-05-03: target < 2s in-browser
   on a mid-range laptop. Don't optimize until measured. Probe reports
   actual latency; if < 500ms ship as-is, if 1–2s add a "Parsing…"
   spinner, if > 2s evaluate moving `pdfjs-dist` into a Web Worker.

---

## Implementation plan (informational, not normative)

This spec is the contract. Implementation order, per the design doc's Step 1
gate:

1. **Probe** (~50 lines, 2h time-box): standalone Bun script that loads both
   example PDFs and prints the raw `getTextContent()` output for page 1.
   Eyeball: do day numbers and codes appear at sensible (x, y)? If yes, the
   architecture works. If no, stop and reconsider.
2. **Skeleton parser** (~200 lines): Steps 0–3.5 only. Output `date_range`
   and `months` for both PDFs. Spot-check assertions above.
3. **Person rows + cells** (~150 lines): Steps 4–6. Full `ParseResult`.
4. **Snapshot tests**: lock in known-good output for both real fixtures.
5. **Synthetic fixtures**: cover error paths.

If step 1 reveals the text layer is unreliable (codes glued together,
positions wrong), revise the spec before writing more code. Don't paper
over a broken foundation.
