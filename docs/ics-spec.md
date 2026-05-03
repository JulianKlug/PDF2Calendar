# iCalendar Generator Specification

Status: DRAFT
Owner: @klug
Related:
- Parser spec: `docs/parser-spec.md`
- Design doc: `~/.gstack/projects/JulianKlug-PDF2Calendar/klug-main-design-20260503-093154.md`
- Manual test: `docs/manual-deletion-test.md`

---

## Purpose

A pure function that turns one person's parsed shifts into a valid RFC 5545
`.ics` document. No I/O, no DOM, no clock reads (uploaded time is passed in).
Same input → same byte-for-byte output.

```ts
generate(input: GenerateInput): string
```

This module is **load-bearing**: it produces the bytes Google and Apple
Calendar consume. If UIDs drift across re-uploads, calendar clients show
duplicates. If timezones are wrong, shifts appear at the wrong hour. If
escape rules are wrong, half the events silently disappear in some clients.
Be precise.

---

## Inputs

```ts
type GenerateInput = {
  // From the parser
  person: ParsedPerson;                 // see parser-spec §"Output schema"

  // Identity for UID + URLs
  person_hash: string;                  // 16 hex chars: sha256(dept + "|" + normalize(name))[:16]

  // Behavior
  codes: Record<string, Code>;          // see src/codes.ts
  emit_tentative_for_prefixes: boolean; // default true; °/* prefix → STATUS:TENTATIVE

  // Source attribution (goes into every event's DESCRIPTION)
  source: {
    file_name: string;                  // e.g. "5_Mars2026_26.03_30.04.2026.pdf"
    uploaded_at: Date;                  // when this .ics was generated
    pdf_sha256: string;                 // 64 hex chars; used to build the row-image URL
    base_url: string;                   // e.g. "https://pdf2calendar.example.com" — no trailing slash
  };

  // Optional: tombstones for the STATUS:CANCELLED fallback strategy.
  // Only used if the deletion test (docs/manual-deletion-test.md) shows
  // Google ignores plain deletions. V1 default: empty.
  tombstones?: Array<{
    date: string;   // "YYYY-MM-DD"
    seq: number;    // 0-indexed position within the cell (for multi-code cells)
  }>;
};

type Code =
  | { kind: "timed";  title: string; start: string; end: string }   // HH:mm; if end <= start, the shift crosses midnight
  | { kind: "allday"; title: string }
  | { kind: "skip"   };
```

### Why `Date` for `uploaded_at`, not a string

The function is a pure transform. Passing a real `Date` lets the test fixture
control the timestamp deterministically (snapshot tests need byte-for-byte
output). The function reads it once, formats it once.

---

## Outputs

A single string. Complete RFC 5545 document. CRLF line endings. UTF-8.

Structure:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//pdf2calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VTIMEZONE
…Europe/Zurich block…
END:VTIMEZONE
BEGIN:VEVENT
…
END:VEVENT
… more VEVENTs …
END:VCALENDAR
```

If the person has zero events (every day is `skip` or empty), the output is
still a valid `VCALENDAR` with the VTIMEZONE block and zero VEVENTs.
Subscribers see an empty calendar, which is the correct semantics — nothing
scheduled — and is also what enables the deletion path (an event that vanishes
from the .ics gets removed by polling clients).

---

## Algorithm

### Step 1 — Iterate days, expand cells to events

For each `day` in `person.days`:

1. If `day.codes.length === 0`: skip (no event).
2. For each `(code_str, seq)` in `day.codes` (preserving order):
   - **Strip prefix**: if `code_str` starts with `°` or `*`, set
     `tentative = true`, `lookup_key = code_str.slice(1)`. Otherwise
     `tentative = false`, `lookup_key = code_str`.
   - **Resolve**: `code = codes[lookup_key]`.
     - If `lookup_key` is not in the table → emit an `"allday"` event titled
       `"Unknown: " + code_str` with `STATUS:TENTATIVE` (so it surfaces as
       a "fix me" signal in the calendar).
     - If `code.kind === "skip"` → no event.
     - If `code.kind === "allday"` → emit one all-day event for `day.date`.
     - If `code.kind === "timed"` → emit one timed event (see Step 2).
   - **UID**: `{person_hash}-{YYYYMMDD}-{seq}@pdf2calendar` where `YYYYMMDD`
     is the **start day** of the event (a night shift starting `2026-04-19`
     at 20:00 has UID suffix `20260419`, regardless of when it ends).
     - When `day.codes.length === 1`, `seq` is `0`. Always include it. Stable
       UIDs across single-code → multi-code transitions matter less than
       simple, predictable rules.

### Step 2 — Timed event date math

For a `code.kind === "timed"` cell on `day.date = YYYY-MM-DD`:

- `dtstart = parseLocal(day.date, code.start)` in `Europe/Zurich`
- If `code.end > code.start` (string compare, e.g. `"18:00" > "08:00"`):
  - `dtend = parseLocal(day.date, code.end)` (same day)
- Else (shift crosses midnight, e.g. `start: "20:00"`, `end: "08:00"`):
  - `dtend = parseLocal(day.date + 1, code.end)` (next day)

Emit `DTSTART;TZID=Europe/Zurich:YYYYMMDDTHHMMSS` and likewise for `DTEND`.
Do **not** emit `Z` suffix — that means UTC and would shift the wall-clock
time. Calendar clients honor the `TZID` parameter and the `VTIMEZONE` block
embedded in the file.

### Step 3 — All-day event date math

For `code.kind === "allday"`:

- `DTSTART;VALUE=DATE:YYYYMMDD` (no time, no TZID)
- `DTEND;VALUE=DATE:YYYYMMDD+1` (next day, exclusive end per RFC 5545)

Per RFC 5545: all-day `DTEND` is **exclusive**. A vacation on 2026-04-19
is `DTSTART;VALUE=DATE:20260419` and `DTEND;VALUE=DATE:20260420`. Forgetting
this is a common bug; events display as 2 days instead of 1.

### Step 4 — Per-event fields

Every VEVENT contains:

| Field | Value |
|---|---|
| `UID` | `{person_hash}-{YYYYMMDD}-{seq}@pdf2calendar` |
| `DTSTAMP` | `source.uploaded_at` formatted as `YYYYMMDDTHHMMSSZ` (UTC). RFC 5545 requires this; calendar clients use it for tie-breaking. |
| `DTSTART` | per Step 2 or 3 |
| `DTEND` | per Step 2 or 3 |
| `SUMMARY` | `code.title` (escaped per Step 6) |
| `DESCRIPTION` | three-line block (escaped per Step 6) — see "DESCRIPTION format" below |
| `STATUS` | `TENTATIVE` if `tentative === true`; otherwise `CONFIRMED` |
| `TRANSP` | `OPAQUE` (default — shift blocks the time) |

Tombstones (when present) emit a VEVENT with all the above plus:
- `STATUS:CANCELLED`
- The same UID the event would have had when it existed (so clients match it
  to the event they previously stored)
- `SUMMARY: (cancelled)` to satisfy clients that require the field

### Step 5 — DESCRIPTION format

```
Source: {source.file_name}
Uploaded: {YYYY-MM-DD HH:MM} UTC
View your row: {base_url}/source/{pdf_sha256}/{person_hash}.png
```

Three lines. Newlines are encoded as `\n` per RFC 5545 (literal backslash +
n, not a real newline byte) — a real LF would terminate the property.

### Step 6 — Escaping

Per RFC 5545 §3.3.11, text values must escape:

| Character | Escape |
|---|---|
| `\` (backslash) | `\\` |
| `,` (comma) | `\,` |
| `;` (semicolon) | `\;` |
| `\n` (real newline in input) | `\n` |
| `\r` (real CR in input) | drop |

Order matters: escape `\` first, then the others. Apply to every text
value: `SUMMARY`, `DESCRIPTION`, etc. Do **not** escape colons (they're
delimiters in their own right).

### Step 7 — Line folding

Per RFC 5545 §3.1, lines longer than 75 octets must be folded: insert
`CRLF` then a single space at the wrap point. Folding happens **after**
escaping. UTF-8 multi-byte characters must not be split mid-character —
fold on a code-point boundary that keeps each line ≤ 75 bytes.

A single `DESCRIPTION` line with a long URL will hit this. Get folding
right or some clients drop the field silently.

### Step 8 — VTIMEZONE block

Embed a static `VTIMEZONE` block for `Europe/Zurich` covering CET/CEST
transitions. Use a long-lived block with `RRULE`-driven transitions (not
hard-coded years), so the file works in 2027, 2030, etc., without
regeneration.

Reference block (verified to import correctly into Google + Apple
Calendar):

```
BEGIN:VTIMEZONE
TZID:Europe/Zurich
X-LIC-LOCATION:Europe/Zurich
BEGIN:STANDARD
DTSTART:19961027T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19810329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
```

Hard-code this in the source. Do not generate it dynamically. Stable
bytes = stable diff = clean re-publish semantics.

### Step 9 — Output assembly + line endings

Concatenate everything in order:
1. `BEGIN:VCALENDAR` block headers (5 lines: VERSION, PRODID, CALSCALE, METHOD)
2. VTIMEZONE block
3. VEVENT blocks in **chronological order** (sorted by DTSTART). Stable
   ordering helps diff debugging across re-uploads.
4. `END:VCALENDAR`

Join with `\r\n`. End the file with a final `\r\n`.

---

## Failure modes

The function does not throw on malformed code data. It either:
- Skips silently (`code.kind === "skip"`, empty codes array)
- Emits an `Unknown: X` placeholder event (unknown lookup key)

The function **does** throw on programmer errors:

| Error | Trigger |
|---|---|
| `IcsError("invalid_person_hash")` | `person_hash` is not 16 hex chars |
| `IcsError("invalid_pdf_sha256")` | `source.pdf_sha256` is not 64 hex chars |
| `IcsError("invalid_base_url")` | `source.base_url` doesn't start with `https://` or `http://`, or has trailing slash |
| `IcsError("invalid_time_format", code)` | A code's `start` or `end` doesn't match `^\d{2}:\d{2}$` |

Validation runs once at the top of the function. Emit-time errors mean
the codes table is broken — fix the table, not the .ics.

---

## Validation rules (post-generation, debug only)

In tests, after generation, parse the output back with `ical` (npm) or
`node-ical` and assert:

1. Output round-trips (parser doesn't error)
2. Every UID is unique
3. Every UID matches `^[0-9a-f]{16}-\d{8}-\d+@pdf2calendar$`
4. Event count = expected (sum of non-empty, non-skip cells across all days)
5. No DTEND falls before its DTSTART
6. VTIMEZONE block is present
7. Every line is ≤ 75 octets after folding
8. Every event has DTSTAMP, UID, DTSTART, DTEND, SUMMARY, DESCRIPTION, STATUS

---

## Test plan

### Unit tests (`test/ics.test.ts`)

| Test | Assertion |
|---|---|
| `single timed event, day shift` | `C2` on 2026-04-15 → DTSTART/DTEND on 2026-04-15, TZID=Europe/Zurich |
| `single timed event, night shift crosses midnight` | `Nw13` on 2026-04-18 → DTSTART 2026-04-18T20:00, DTEND 2026-04-19T08:00 |
| `all-day event` | `V` on 2026-04-19 → DTSTART;VALUE=DATE:20260419, DTEND;VALUE=DATE:20260420 |
| `skip code` | `X` → no event emitted |
| `unknown code` | `XYZ123` → all-day "Unknown: XYZ123" with STATUS:TENTATIVE |
| `tentative prefix` | `°C2` → C2 event with STATUS:TENTATIVE |
| `multi-code cell` | `["Nw13", "Nw13"]` → 2 events with `seq` 0 and 1, distinct UIDs |
| `escaping` | code title `"Surgery, Dr. Müller; AM"` → emits `Surgery\, Dr. Müller\; AM` |
| `line folding` | DESCRIPTION line > 75 bytes → wrapped with CRLF + space |
| `empty person` | all skips → valid VCALENDAR with 0 VEVENTs |
| `tombstones` | tombstone for `(2026-04-19, 0)` → VEVENT with STATUS:CANCELLED, matching UID |
| `stable output` | same input → byte-for-byte identical bytes (snapshot test) |
| `chronological order` | events sorted by DTSTART regardless of input order |

### Integration test

Parse `example_data/5_Mars2026_26.03_30.04.2026.pdf`, find Klug, J,
generate `.ics`. Snapshot the output. Re-run after every parser /
codes / ics change to catch regressions.

### Round-trip test

Parse the generated `.ics` with `node-ical`. Assert all events
preserve their UID, SUMMARY, DTSTART, DTEND, STATUS.

---

## Out of scope (V1)

- Recurring events (RRULE) — every shift is a single instance.
- Attendees, organizers, alarms — no notifications.
- Attachments — the row-image link goes in DESCRIPTION, not as ATTACH.
- iTIP scheduling (METHOD:REQUEST/REPLY) — we publish (METHOD:PUBLISH) only.
- Localized event text — codes table can use any language; the generator
  passes through.
- Diff-based output (only emit changed events) — server reads existing .ics,
  drops month-range events, regenerates the rest. ics.ts always produces
  a complete document for its input set.

---

## Open questions

1. **PRODID stability.** `-//pdf2calendar//EN` is fine for V1. If we ever
   sign / verify .ics files, PRODID may need a version suffix. Defer.
2. **Multi-month merge in this function?** Currently no — server reads
   existing .ics, splices. Could move into ics.ts as `merge(existing,
   fresh, dropRange)`. Defer until the server is being written; it's
   easier to decide with the call site in front of us.
3. **Per-deployment overrides for VTIMEZONE.** Other hospitals are in
   Europe/Berlin or Europe/Paris. The block should be selectable via
   a `tzid` input, with a small lookup table of pre-baked blocks.
   V1: hard-code Zurich. V2: parameterize.
