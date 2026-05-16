# Server Specification

Status: DRAFT
Owner: @klug
Related:
- Parser spec: `docs/parser-spec.md`
- iCal generator spec: `docs/ics-spec.md`
- Frontend spec: `docs/frontend-spec.md`
- Design doc: `~/.gstack/projects/JulianKlug-PDF2Calendar/klug-main-design-20260503-093154.md`
- Deletion test (gating, PASSED 2026-05-15): `docs/test-results/manual-deletion-test-2026-05-15.md`
- Integration test (V1, PASSED 2026-05-16): `docs/test-results/server-integration-test-2026-05-16.md`

---

## Purpose

A single Bun service that receives the frontend's multipart upload,
persists per-person `.ics` files plus row PNGs plus a small manifest, and
returns the name → `webcal://` URL list. nginx serves the resulting feeds
and PNGs as static files — Bun is never in the read path.

```
Browser ──multipart──▶ Bun :3001 (POST /api/upload)
                          │ validate, hash-check, merge, write
                          ▼
                       /var/lib/pdf2calendar/{feeds,manifest,sources,rows}/…
                          ▲
Google/Apple ◀──.ics──── nginx (GET /feed/<hash>.ics, /source/<sha>/<hash>.png)
```

Implementation target: one file at `src/server.ts`, ~350 LOC, run
directly via `bun run src/server.ts` (no build step). The server is
**stateful on disk** but **stateless in memory** — restart-safe.

The deletion test passed cleanly on 2026-05-15 (Google + Apple both
deleted on plain re-publish). The server therefore **does not** emit
`STATUS:CANCELLED` tombstones and the manifest does not track them.

---

## Inputs

### HTTP request

The single write endpoint is `POST /api/upload`. `Content-Type:
multipart/form-data`. The contract is the frontend's output, copy-quoted
here from `docs/frontend-spec.md` § Outputs — that file is the source of
truth; if these two ever drift, the frontend spec wins.

The TypeScript types `UploadPayload`, `UploadResponse`, and
`UploadResponseFeed` are already exported by `web/api.ts`. The server
implementation `import`s them directly from `../web/api.ts` rather than
redeclaring — one source of truth in code. (A future cleanup may move
these types to `src/upload-contract.ts` so the frontend imports them
from `src/` instead of the other direction; deferred — not blocking
V1.)

| Part name | Content-Type | Content |
|---|---|---|
| `payload` | `application/json` | `UploadPayload` JSON (below) |
| `pdf` | `application/pdf` | Original PDF bytes |
| `row_<person_hash>` | `image/png` | One part per person, the cropped row image |

```ts
type UploadPayload = {
  department: string;            // from VITE_DEPARTMENT_SLUG / PDF2CAL_DEPARTMENT_SLUG
  pdf_sha256: string;            // 64 hex; server re-verifies against the `pdf` part
  source_file_name: string;      // original filename, used in DESCRIPTION
  date_range: { start: string; end: string };     // "YYYY-MM-DD"
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  people: Array<{
    role: string;
    name: string;
    person_hash: string;         // sha256(department + "|" + normalize(name))[:16]
    days: Array<{ date: string; codes: string[] }>;
  }>;
};
```

### Configuration (env vars)

| Var | Required | Default | Notes |
|---|---|---|---|
| `PDF2CAL_PORT` | no | `3001` | Listen port for `Bun.serve()`. |
| `PDF2CAL_DATA_DIR` | **yes** | — | Root directory. Holds `feeds/`, `manifest/`, `sources/`, `rows/`. Server exits 1 if unset or not writable. |
| `PDF2CAL_BASE_URL` | **yes** | — | Public origin, e.g. `https://pdf2calendar.example.com`. **No trailing slash.** Used for `webcal_url` in the response and for `View your row:` in every event's DESCRIPTION. Server exits 1 if missing, has a trailing slash, or doesn't start with `http(s)://`. |
| `PDF2CAL_DEPARTMENT_SLUG` | **yes** | — | Slug like `anesthesia-chuv`. **Must match the slug the frontend was built with** (`VITE_DEPARTMENT_SLUG`) — drift breaks every `person_hash`. Server exits 1 if unset. |
| `PDF2CAL_MAX_UPLOAD_BYTES` | no | `10485760` (10 MB) | Hard cap on the multipart body. Pass to **both** `Bun.serve({ maxRequestBodySize })` (framework-level reject before `request.formData()` buffers anything) **and** the nginx `client_max_body_size` directive — match the three values (env var, Bun option, nginx). |

All required vars are read at startup. The check is a single function
that exits with a one-line error and code 1 if any is missing or invalid —
same posture as the frontend's `VITE_DEPARTMENT_SLUG` check.

**Startup failures.** If `Bun.serve()` throws (e.g. `EADDRINUSE` because
another process holds `PDF2CAL_PORT`, or `EACCES` on a privileged port),
catch the throw, log a one-line error (`port 3001 in use — set PDF2CAL_PORT
or stop the other process`), and exit 1. Systemd's `Restart=always` will
otherwise hot-loop on an unrecoverable port conflict.

---

## Outputs

### On `200 OK`

`Content-Type: application/json`, body:

```ts
type UploadResponse = {
  feeds: Array<{
    name: string;
    role: string;
    person_hash: string;
    webcal_url: string;          // "webcal://<host>/feed/<person_hash>.ics"
  }>;
  unknown_codes: string[];       // distinct, sorted, V1 dictionary misses
};
```

`webcal_url` is built by replacing the scheme of `PDF2CAL_BASE_URL`
(`http://` or `https://`) with `webcal://` and appending
`/feed/<person_hash>.ics`. `webcal://` is the scheme Apple Calendar's
"Subscribe by URL" expects; Google's deep link wraps it in `cid=`
client-side (frontend-spec § Open in Google Calendar — URL format).

`feeds` is an **array** in PDF order, not a map. Two colleagues with the
same display name don't silently overwrite each other; the frontend can
render PDF order without re-sorting.

`unknown_codes` is the sorted, deduplicated set of raw `code_str` values
seen in this upload for which `isKnownCode(code_str)` (from `src/codes.ts`)
returns `false`. The `°`/`*` tentative-prefix handling lives entirely
inside `isKnownCode` — the server does not re-implement it. Frontend
surfaces the array in the dismissable banner (frontend-spec § Unknown-
codes banner). Algorithm in Step 10 below.

### On error

`Content-Type: application/json`, body:

```ts
type ErrorBody = { error: string; code?: string };
```

`error` is human-readable (the frontend may splice it into the 400 copy
per frontend-spec § Failure modes → Upload errors). `code` is a machine
tag for the rejection class — frontend may inspect it for finer-grained
behavior in V2. See § Failure modes below.

---

## Algorithm

The happy path is ten steps. Hard rejections after a step short-circuit
to a typed error response (§ Failure modes).

### Step 1 — Parse multipart

Use `request.formData()` (Bun handles multipart natively — no busboy).
The body-size cap is enforced **before this step** by
`Bun.serve({ maxRequestBodySize: PDF2CAL_MAX_UPLOAD_BYTES })`, which
returns `413` to the client without ever buffering the oversize body.
This step then rejects if:

- The `Content-Type` request header is not `multipart/form-data` → `415`.
- The form does not contain a `payload` part or a `pdf` part → `400`
  (`code: "missing_part"`).
- The `pdf` part's content-type is not `application/pdf` → `415`.
- Any `row_*` part's content-type is not `image/png` → `415`.

### Step 2 — Validate the `payload` JSON

Parse `payload` as JSON. Walk the schema, asserting:

- All required fields present and of the right primitive type.
- `pdf_sha256` matches `/^[0-9a-f]{64}$/`.
- `date_range.start` and `date_range.end` match `/^\d{4}-\d{2}-\d{2}$/`
  and `end >= start`.
- `months.length in [1, 2]`.
- `people.length >= 1`.
- For each person: `person_hash` matches `/^[0-9a-f]{16}$/`; `days.length`
  equals `months.reduce((sum, m) => sum + m.days_covered.length, 0)`
  (parser-spec § Step 3.5 guarantees each month's `days_covered` is
  already deduped within the month, so a plain sum is correct);
  every `days[i].date` is in `[date_range.start, date_range.end]`.

Any failure → `400` (`code: "schema"`), with an `error` string naming the
first failing assertion.

### Step 3 — Verify the PDF bytes

Read the `pdf` part's bytes. Compute `sha256(bytes)`. If it disagrees
with `payload.pdf_sha256` → `400` (`code: "pdf_hash_mismatch"`). This
catches both a corrupt upload and a frontend bug where the payload was
built from a different file than the one sent.

### Step 4 — Verify the department

If `payload.department !== PDF2CAL_DEPARTMENT_SLUG` → `400`
(`code: "department_mismatch"`). A frontend built with a different slug
would silently produce wrong-hash URLs; reject loudly instead.

### Step 5 — Verify every `person_hash` + row part

For each `person` in `payload.people`:

1. Re-derive `expected_hash = sha256(department + "|" + normalize(name)).slice(0, 16)`
   (§ Identifier hashing).
2. If `expected_hash !== person.person_hash` → `400`
   (`code: "hash_mismatch"`, `error: "person_hash mismatch for X"`).
3. If the form does not contain a `row_<person_hash>` part → `400`
   (`code: "missing_part"`).

Also reject if the form contains any `row_*` part whose hash does **not**
match any person in the payload (orphan part) → `400`
(`code: "missing_part"`).

If two persons in `payload.people` re-derive to the same `expected_hash`
(normalized-name collision — e.g. `"Klug, J"` and `"klug,  j"` after
`normalize()`), reject → `400` (`code: "hash_collision"`,
`error: "Two persons normalize to the same hash: X and Y"`). The
bijection check between `row_*` parts and persons cannot catch this on
its own — both persons would map to the same `row_<hash>` key and the
second `row_<hash>` part would silently overwrite the first.

### Step 6 — Acquire the write mutex

Wait on the single in-process async mutex. Bun is single-process, so a
JS-level lock is sufficient — no `flock(2)`. Pseudo:

```ts
let chain: Promise<unknown> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise((r) => (release = r));
  try { await prev; return await fn(); } finally { release(); }
}
```

The lock covers steps 7–9. Read-only steps 1–5 run outside it.

### Step 7 — Persist sources and row PNGs

For the PDF: target path is `<DATA_DIR>/sources/<pdf_sha256>.pdf`. If it
exists, skip — sources are content-addressed and immutable. Otherwise
write to `<path>.tmp` then `fs.rename()` to `<path>`.

For each person, target path is `<DATA_DIR>/rows/<pdf_sha256>/<person_hash>.png`.
`mkdir -p` the per-PDF directory. Same skip-if-exists + tmp-then-rename
discipline.

### Step 8 — Per-person `.ics` and manifest

For each person:

1. Read the existing `<DATA_DIR>/feeds/<person_hash>.ics` if it exists.
   Otherwise treat as `null`.
2. Call `mergeIcs(existing, freshInput, drop_range)` (§ Multi-month
   merge) where `freshInput` is built from the parsed `person`, the new
   upload's source metadata, and the codes table from `src/codes.ts`.
3. Write `<DATA_DIR>/feeds/<person_hash>.ics.tmp`, then `fs.rename()` to
   `<person_hash>.ics`. The `.tmp` lives in the **same directory** as the
   final file — POSIX rename is atomic only intra-filesystem.
4. Write `<DATA_DIR>/manifest/<person_hash>.json` (same tmp+rename
   pattern). Schema in § Manifest. **Manifest writes are best-effort:**
   the `.ics` from step 3 is the source of truth for the V1 calendar
   feed. Wrap step 4 in try/catch; on failure log
   `manifest write failed for <person_hash>: <error>` to stderr and
   continue the loop. Do **not** return `500` — the user-visible
   artifact (the `.ics`) is already on disk. Manifest is forward-compat
   metadata for the V2 admin listing endpoint with no V1 reader, so a
   stale manifest is recoverable on the next successful upload.

If a step-3 rename fails (disk full, permissions), abort the loop with
`500` (`code: "write_failure"`). The mutex is released in the `finally`. Past
people in the loop are durable on disk — the upload is **partial-safe**;
re-running the same upload is **semantically idempotent**: every write is
keyed by `<pdf_sha256>` / `<person_hash>`, and `mergeIcs()` produces the same
set of VEVENTs (same UIDs, same DTSTART/DTEND/SUMMARY) for the same input.
The `DTSTAMP` and the `Uploaded:` line in `DESCRIPTION` reflect the actual
upload time and therefore differ between uploads — this is correct per
RFC 5545 §3.8.7.2 and is harmless for calendar clients (same UID + same
DTSTART → no user-visible change).

### Step 9 — Release the mutex

Implicit in `withWriteLock`'s `finally`.

### Step 10 — Build the response

For each person in payload order:

```ts
{
  name: person.name,
  role: person.role,
  person_hash: person.person_hash,
  webcal_url: toWebcalUrl(PDF2CAL_BASE_URL, person.person_hash),
}
```

`toWebcalUrl` is explicit, not regex-clever:

```ts
function toWebcalUrl(base_url: string, person_hash: string): string {
  // env-validator guarantees base_url starts with "http://" or "https://"
  const rest = base_url.startsWith("https://")
    ? base_url.slice("https://".length)
    : base_url.slice("http://".length);
  return `webcal://${rest}/feed/${person_hash}.ics`;
}
```

Compute `unknown_codes` by delegating to `src/codes.ts`'s `isKnownCode(raw)`,
which already handles `°`/`*` prefix stripping (single source of truth —
do **not** re-implement the strip-and-check):

```ts
const unknown = new Set<string>();
for (const person of payload.people) {
  for (const day of person.days) {
    for (const code_str of day.codes) {
      if (!isKnownCode(code_str)) unknown.add(code_str);
    }
  }
}
const unknown_codes = Array.from(unknown).sort();
```

The set carries the **raw** `code_str` form (with any `°`/`*` prefix intact)
so the frontend banner shows exactly what the parser found in the PDF. For
each unknown raw `code_str`, append one line per (code, person_hash, date)
triple to `<DATA_DIR>/unknown-codes.log` (see § Logging).

Return `200 OK` with `Content-Type: application/json` and the
`UploadResponse` body.

---

## Identifier hashing (normative)

The server side of the contract from frontend-spec § Identifier hashing.
`normalize()` is **byte-identical** to `web/person-hash.ts`:

```ts
function normalize(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

async function personHash(department: string, name: string): Promise<string> {
  const input = `${department}|${normalize(name)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
```

The cross-validating fixture is **one JSON file** at
`test/fixtures/normalize.json`. Both `web/person-hash.test.ts` and the
server-side `test/normalize-shared.test.ts` import this file and run
their own `normalize()` implementation against every row in it. No
symlink, no copy — one file, two import sites, zero drift by construction.

Fixture content (minimum): the literal pair
`(department: "anesthesia-chuv", name: "Klug, J")` plus four rows
exercising each `normalize()` step in isolation (NFC composition, case,
internal whitespace, trailing punctuation).

If a future change touches `normalize()` in either implementation, the
same change lands in the other in the same PR. The fixture is the gate.

---

## Multi-month merge (normative)

The server preserves events outside the new upload's `date_range` by
**reading the existing `.ics` and splicing kept VEVENT blocks** into the
freshly generated document. The work lives in a new pure helper exported
from `src/ics.ts`:

```ts
export function mergeIcs(
  existing: string | null,
  freshInput: GenerateInput,
  drop_range: { start: string; end: string },
): string;
```

Behavior:

1. Call `generate(freshInput)` → `freshIcs: string`. This produces a
   complete, valid VCALENDAR.
2. If `existing === null`, contains zero `BEGIN:VEVENT`, or **fails the
   integrity check** (no `END:VCALENDAR`, or any `BEGIN:VEVENT` without a
   matching `END:VEVENT`), return `freshIcs` unchanged and log a warning
   `mergeIcs: existing .ics for <person_hash> is malformed — falling back
   to fresh-only`. This handles partial writes that survived a crash
   before the orphan sweep ran, or any hand-edit gone wrong. The
   user-visible cost is that this single re-upload loses preserved
   events from prior months for that person; the next re-upload of any
   prior PDF restores them.
3. Otherwise, split `existing` on the `BEGIN:VEVENT` / `END:VEVENT`
   pair. For each VEVENT block, read its DTSTART line:
   - Timed: `DTSTART;TZID=Europe/Zurich:YYYYMMDDTHHMMSS` → date is
     `YYYY-MM-DD`.
   - All-day: `DTSTART;VALUE=DATE:YYYYMMDD` → date is `YYYY-MM-DD`.
   - Neither shape (unexpected DTSTART form): drop the block and log;
     do **not** throw — the rest of the merge proceeds.
   If the date is in `[drop_range.start, drop_range.end]` inclusive,
   drop the block. Otherwise keep it verbatim, byte-for-byte. **Existing
   `STATUS:CANCELLED` blocks** (tombstones written by pre-2026-05-15
   builds) are preserved by this rule when they fall outside the
   `drop_range` — they round-trip cleanly even though the server no
   longer emits them.
4. Take the new VEVENT blocks out of `freshIcs` the same way.
5. Re-assemble: VCALENDAR header (5 lines) + VTIMEZONE block + (all
   surviving blocks, sorted by DTSTART then by UID — same sort as
   `generate()`) + `END:VCALENDAR`. Use the same CRLF line endings and
   trailing CRLF as `generate()`.

The DTSTAMP on preserved events stays at its old value (it's part of
the kept block bytes). This is correct per RFC 5545 — DTSTAMP is the
property's creation time, not a server-side modification marker.

### Why splice instead of "store parsed days and regenerate"

Each VEVENT's `DESCRIPTION` carries a `View your row:` link to the
`<pdf_sha256>` it was generated from. Regenerating a preserved event
under the new upload's `source.pdf_sha256` would point users at a
row PNG that doesn't exist (the new PDF's `rows/<sha>/` directory
wasn't populated for people who don't appear in the new PDF). Splicing
keeps every event tied to the PDF version it came from, which is what
design-doc success-criterion #9 ("Two events from two different
uploads link to two different `<pdf_sha256>` URLs") requires.

### Test cases for `mergeIcs()`

In `test/ics.test.ts`:

| Test | Assertion |
|---|---|
| `existing is null` | Returns `freshIcs` unchanged |
| `existing has zero VEVENTs` | Returns `freshIcs` unchanged |
| `disjoint ranges` (existing covers March, fresh covers May) | Output contains every VEVENT from both |
| `overlapping ranges` (both cover April; fresh's range drops April) | Old April VEVENTs are dropped; new April VEVENTs replace them |
| `boundary` | Date exactly equal to `drop_range.start` is dropped; date one day before is kept |
| `chronological order` | Output VEVENTs are sorted by DTSTART regardless of input order |
| `byte stability` | Same `freshInput` + same `existing` → byte-identical output (snapshot). For the server-level idempotence claim (`new Date()` per upload), see § Test plan → `test/server.test.ts` case 6, which asserts **semantic** equality only. |
| `tombstone preservation` (regression) | `existing` contains a `STATUS:CANCELLED` VEVENT outside `drop_range` → that VEVENT is preserved verbatim in the output. Locks in round-trip compatibility with pre-2026-05-15 builds that emitted tombstones. |
| `malformed existing — no END:VCALENDAR` | mergeIcs returns `freshIcs` unchanged and logs a warning (§ Multi-month merge step 2). |
| `malformed existing — unbalanced BEGIN/END:VEVENT` | Same fall-back as above. |
| `unexpected DTSTART form on a preserved block` | The bad block is dropped with a log line; the rest of the merge succeeds (no throw). |

---

## Storage layout

Rooted at `PDF2CAL_DATA_DIR` (commonly `/var/lib/pdf2calendar/`):

```
<DATA_DIR>/
  feeds/<person_hash>.ics                 # the calendar feed; nginx serves at /feed/<hash>.ics
  manifest/<person_hash>.json             # per-person manifest (§ Manifest)
  sources/<pdf_sha256>.pdf                # original PDF; NOT publicly served
  rows/<pdf_sha256>/<person_hash>.png     # row image; nginx serves at /source/<sha>/<hash>.png
  unknown-codes.log                       # append-only TSV (§ Logging)
```

Byte estimates per upload (45 colleagues, two-month PDF):

| Tree | Per upload | Notes |
|---|---|---|
| `sources/` | ≤ 5 MB | Skipped on identical re-upload (content-addressed). |
| `rows/<sha>/` | ~50–100 KB × 45 ≈ 3–5 MB | Skipped on identical re-upload. |
| `feeds/` | ~5 KB × 45 ≈ 225 KB | Rewritten per upload. |
| `manifest/` | ~200 B × 45 ≈ 9 KB | Rewritten per upload. |

At 24 uploads/year (worst case: 2 publishes/month), storage growth is
≈ 250 MB/year/department. No automatic pruning in V1.

### Manifest

```ts
type Manifest = {
  name: string;                  // last-seen display name
  role: string;                  // last-seen role
  last_uploaded_at: string;      // ISO 8601 UTC, e.g. "2026-05-16T08:30:00.000Z"
  last_pdf_sha256: string;       // 64 hex
  last_date_range: { start: string; end: string };
};
```

No `pending_tombstones` — the deletion test confirmed they aren't
needed. No `months_seen` — derivable from the `.ics` if a V2 listing
ever wants it. Smaller is easier to keep correct.

**No V1 reader.** Nothing in V1 consumes this file; it exists for the
V2 admin listing endpoint and the V2 "departed colleagues" cleanup sweep
(both already deferred). Carrying it now is cheap (~9 KB per upload, all
writes inside the existing mutex) and strictly smaller than the diff
required to reinstate the storage layout, orphan sweep, and Step 8.4
later. Write failures are non-fatal — see § Step 8.

---

## Concurrency model

Single in-process async mutex over the write phase (Algorithm step 6).
Reads + validation run outside it. At most one upload writes to disk at
a time.

**Why this is enough.** V1 is a ~45-person internal tool. Realistic
upload rate is "a few per week, all by one or two maintainers". The
worst case — two colleagues racing — produces a few seconds of
mutex-induced wait, which the frontend renders as the existing
"Saving to the server…" label. The mutex is single-process, so a
Bun-process crash drops the lock cleanly.

**Atomicity at the file level.** Every output file is written to
`<final-path>.tmp` in the **same directory** as the final path, then
`fs.rename()` to the final name. POSIX `rename(2)` is atomic intra-
filesystem only — never use `/tmp` as the staging area.

**Partial-failure recovery.** If a rename fails mid-loop in Step 8, the
server returns `500`. The completed renames are durable. Re-uploading
the same PDF is **idempotent**: every write target is keyed by
`<pdf_sha256>` or `<person_hash>`, `mergeIcs()` is pure, and the
existing `.ics` on disk after a partial run is already the merged
result for those people — re-merging it with the same `freshInput`
produces the same bytes.

**Startup orphan sweep.** On boot, scan `<DATA_DIR>/feeds/` and
`<DATA_DIR>/manifest/` for `*.tmp` files and `unlink()` them. Log the
count. This cleans up orphans from a crash mid-rename. One pass, no
recursion; cheap.

---

## Failure modes

Every error response has `Content-Type: application/json` and body
`{ error: string, code?: string }`. The frontend's mapping to user copy
lives in `docs/frontend-spec.md` § Failure modes → Upload errors.

| Status | `code` | Trigger |
|---|---|---|
| `400` | `schema` | `payload` JSON missing field, wrong type, regex mismatch, length mismatch |
| `400` | `missing_part` | `payload` or `pdf` part absent; orphan `row_*` part; person missing a `row_*` part |
| `400` | `hash_mismatch` | Re-derived `person_hash` ≠ submitted hash |
| `400` | `hash_collision` | Two persons in `payload.people` re-derive to the same 16-hex prefix (see Step 5) |
| `400` | `pdf_hash_mismatch` | `sha256(pdfBytes)` ≠ `payload.pdf_sha256` |
| `400` | `department_mismatch` | `payload.department` ≠ `PDF2CAL_DEPARTMENT_SLUG` |
| `413` | (none) | Body > `PDF2CAL_MAX_UPLOAD_BYTES` (emitted by `Bun.serve` before the handler runs) |
| `415` | (none) | `Content-Type` not multipart; `pdf` not `application/pdf`; any `row_*` not `image/png` |
| `429` | (none) | Emitted by nginx, never by Bun |
| `500` | `write_failure` | `fs.rename()` or `fs.write()` for the `.ics` failed (disk, permissions, ENOSPC). Manifest write failures are non-fatal and **never** produce this code — see § Step 8.4. |
| `500` | `internal_error` | Any other unexpected throw |

The frontend's 400 user copy splices `error` into "Server rejected the
upload: {error}." — write `error` strings that work in that sentence.

### `/healthz`

`GET /healthz` returns `200` with `application/json` body `{"ok": true}`.
For systemd watchdog and an external uptime probe. No auth. Not
documented in the design doc; small enough to add as a defensible
default.

---

## Threat model

V1 has no authentication on `/api/upload`. The intended deployment is
an **internal hospital tool** on an obscure domain shared via Slack to
~45 colleagues. The threat model below names exactly what that posture
buys and what it doesn't, so a future maintainer doesn't mistake the
domain's obscurity for a security boundary.

**In scope (mitigated by current design):**
- **Path traversal / arbitrary writes.** All on-disk paths are built
  from `person_hash` (`/^[0-9a-f]{16}$/`) or `pdf_sha256`
  (`/^[0-9a-f]{64}$/`), both server-validated regexes. User-supplied
  strings (`name`, `role`, `source_file_name`) never touch the
  filesystem.
- **CRLF / iCal injection** via `source_file_name` or `name`.
  Mitigated by `escapeText()` in `src/ics.ts` (RFC 5545 §3.3.11).
- **DoS via giant uploads.** `Bun.serve({ maxRequestBodySize })` rejects
  oversize bodies before buffering; nginx `client_max_body_size` is the
  first line of defense; `limit_req` caps upload rate per IP.
- **Source-PDF exfiltration.** `<DATA_DIR>/sources/<pdf_sha256>.pdf`
  has no nginx route — only `rows/` (per-person crops) is publicly served.

**Out of scope (URL-obscurity is the only V1 control):**
- **Feed-poisoning.** Anyone who can reach `pdf2calendar.example.com`
  with knowledge of the slug (`PDF2CAL_DEPARTMENT_SLUG`) and one
  colleague's display name (e.g. `"Klug, J"`) can re-derive that
  person's `person_hash` and upload a malicious payload that overwrites
  their feed. The frontend renders the row PNG from a real PDF, but a
  malicious client can submit any PNG bytes. The rate limit caps damage
  rate, not damage.
- **Manifest harvesting.** No `/api/manifest` endpoint in V1.
- **Cross-department leakage.** Each fork sets its own
  `PDF2CAL_DEPARTMENT_SLUG`; collisions across forks are out of scope.

**If the domain is ever shared externally** (linked from public docs,
posted to a public repo's README without redaction, indexed by a search
engine), `/api/upload` must move behind authentication **before** that
exposure happens. The deferred V2 work (`/api/manifest`, auth on
`/api/upload`) is the path forward.

---

## Validation rules

Pre-write self-checks. If any fails the upload is rejected; none ever
fire silently.

1. The multipart contains exactly `2 + N` parts (`payload`, `pdf`, `N`
   row PNGs where `N === payload.people.length`).
2. Every `row_<hash>` part's hash matches exactly one
   `payload.people[i].person_hash`, and every person has a corresponding
   `row_` part (bijection check).
3. `payload.people.length >= 1`.
4. `payload.months.length in [1, 2]`.
5. Recomputed `sha256(pdfBytes) === payload.pdf_sha256`.
6. Re-derived `person_hash === payload.people[i].person_hash` for every
   person.
7. `payload.department === PDF2CAL_DEPARTMENT_SLUG`.
8. Every required `<DATA_DIR>/` subdirectory exists and is writable; the
   server creates them on startup with `mkdir -p` and exits 1 if it
   can't.

---

## Logging

- **Per-request line on stderr**, one per request, journald-friendly:
  `<iso_ts> <level> <method> <path> <status> <duration_ms>ms`.
  Example: `2026-05-16T08:30:01.123Z INFO POST /api/upload 200 412ms`.
- **Unknown codes file**: `<DATA_DIR>/unknown-codes.log`, append-only TSV.
  One line per (code, person_hash, date) triple seen in any upload:
  `<iso_ts>\t<code>\t<person_hash>\t<date>`. The maintainer scans this
  file to know what to add to `src/codes.ts`.
- **No IP logging**, no per-user request log, no analytics. Privacy /
  GDPR posture per design doc. Bun never reads `$remote_addr`-equivalent
  request fields; nginx is configured with a redacted `log_format` (see
  § Deployment → nginx) so the front-door access log also omits IPs,
  referers, and user-agents. The only persisted identifier per upload
  is `person_hash` (a 16-hex prefix), and even that only appears in
  `unknown-codes.log` when an upload contains an unknown code.

---

## Test plan

Bun's built-in test runner is already used by `test/parser.test.ts` and
`test/ics.test.ts` — same harness, no new dev dep.

### Unit tests

| File | Asserts |
|---|---|
| `test/server.test.ts` | Spins up `Bun.serve()` against a fresh tmp `PDF2CAL_DATA_DIR`. Required cases: (1) happy path — 1 person, 2 days → 200, on-disk files exist with expected content. (2) Each 400 class — `schema`, `missing_part` (payload absent, pdf absent, person without row, orphan row), `hash_mismatch`, **`hash_collision`** (two persons normalize to the same hash → reject), `pdf_hash_mismatch`, `department_mismatch`. (3) `413` (Bun rejects body > cap before the handler runs — assert no handler-side state changed). (4) `415` (bad Content-Type, `image/jpeg` row part). (5) Multi-month merge — upload March, then April; final `.ics` contains both months. (6) **Semantically idempotent** re-upload — same payload twice → response equals first; on-disk feed has same VEVENT count + UID set + per-UID byte-equal DTSTART/DTEND/SUMMARY; DTSTAMP and `Uploaded:` line may differ. (7) **Empty-days person** — person whose every `day.codes` is `[]` (or all `X`/`MAL`/`CP`) produces a valid empty-VEVENT VCALENDAR. (8) **Orphan sweep at startup** — plant `feeds/<hash>.ics.tmp` and `manifest/<hash>.json.tmp` before starting the server; assert both are gone after boot. (9) **Manifest-failure isolation** — mock `Bun.write` to fail on manifest paths only; assert response is 200 and the `.ics` is on disk (per § Step 8.4). (10) **Concurrent uploads serialize** — two `fetch()` calls firing simultaneously to two different PDFs for the same person; assert both return 200 and the final `.ics` matches the later-completing upload's data (mutex correctness). (11) **Corrupt existing `.ics`** — plant a truncated `feeds/<hash>.ics` (e.g. only `BEGIN:VCALENDAR\r\n`) and re-upload; assert merge falls back to fresh-only, no throw, response 200, warning logged. (12) **`webcal_url` construction** — covers `http://localhost:3001` (dev) and `https://pdf2calendar.example.com` (prod) base URLs. (13) **`unknown_codes` shape** — raw `code_str` preserved (with `°`/`*` prefix intact), sorted, deduplicated; `unknown-codes.log` gets one line per (code, person_hash, date) triple. (14) **Response order** — `feeds[i]` corresponds to `payload.people[i]` in PDF order. |
| `test/ics.test.ts` | Extended with `mergeIcs()` cases per § Multi-month merge → Test cases, **plus** the tombstone-preservation regression: an `existing` containing a `STATUS:CANCELLED` VEVENT outside `drop_range` is preserved verbatim in the output (pre-2026-05-15 deployments may have tombstones on disk; the server no longer emits them but must round-trip them cleanly). |
| `test/normalize-shared.test.ts` | Imports `test/fixtures/normalize.json`. For each row, asserts the server's `normalize()` produces the expected output. The same fixture is imported by `web/person-hash.test.ts`; the two test files run their own `normalize()` against identical inputs. Any drift between the two implementations fails CI on whichever side regressed. |

The shared fixture lives at `test/fixtures/normalize.json` (one file,
two import sites — see § Identifier hashing). Any future change to
`normalize()` that doesn't touch this fixture, or that fails either
side, fails CI.

### Integration test

Run the live server against `example_data/5_Mars2026_26.03_30.04.2026.pdf`:

1. `bun run dev` (Vite).
2. `PDF2CAL_DATA_DIR=/tmp/p2c PDF2CAL_BASE_URL=http://localhost:3001 PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv bun run src/server.ts`.
3. Drop the PDF in the browser. Verify the response contains 45 feeds,
   that `/tmp/p2c/feeds/<klug_hash>.ics` exists, and that its DESCRIPTION
   lines point to `http://localhost:3001/source/<pdf_sha>/<klug_hash>.png`.
4. Re-drop the same PDF. Verify the response is identical and that
   `feeds/<klug_hash>.ics` is **semantically unchanged**: same VEVENT
   count, same UID set, and for each UID the DTSTART/DTEND/SUMMARY lines
   are byte-equal. DTSTAMP and the `Uploaded:` line in DESCRIPTION will
   differ — that's correct per RFC 5545 §3.8.7.2.

### Manual smoke test

Extend `docs/manual-upload-test.md` with a "Start the server"
pre-step: a 3-line snippet that exports the three required env vars and
runs `bun run src/server.ts`. The remainder of that runbook (drop PDF,
click `[Preview row]`, copy URL, subscribe) becomes the end-to-end
smoke test for the full V1 stack.

The deletion-test runbook (`docs/manual-deletion-test.md`) stays as the
regression gate for the architecture; it does **not** need to be re-run
unless Google's poll behavior visibly changes.

### Non-requirements

No Playwright, no headless-browser test, no load test in V1. The unit
+ integration + manual smoke tests are enough for the V1 surface.

---

## Deployment

### nginx

A skeleton config lives at `deploy/nginx.conf.example` (added with the
implementation). The load-bearing pieces:

```nginx
limit_req_zone $binary_remote_addr zone=p2c_upload:10m rate=10r/m;

# Privacy: redacted access log format — no $remote_addr, no $http_referer,
# no $http_user_agent. nginx's default `combined` log writes all three.
# Override at the http{} or server{} level. See § Logging.
log_format p2c '$time_iso8601 $request_method $request_uri $status $body_bytes_sent';

server {
  server_name pdf2calendar.example.com;
  listen 443 ssl;
  # ... TLS via certbot ...

  access_log /var/log/nginx/pdf2calendar-access.log p2c;
  error_log  /var/log/nginx/pdf2calendar-error.log warn;

  client_max_body_size 10M;

  # Static SPA
  root /var/www/pdf2calendar/dist;
  index index.html;
  location / {
    try_files $uri /index.html;
  }

  # Feed files — Bun never touches the read path
  location /feed/ {
    alias /var/lib/pdf2calendar/feeds/;
    default_type text/calendar;
    charset utf-8;
    add_header Cache-Control "no-cache, must-revalidate";
  }

  # Row PNGs — content-addressed, safe to cache forever
  location /source/ {
    alias /var/lib/pdf2calendar/rows/;
    default_type image/png;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Upload endpoint — rate-limited, proxied to Bun
  location = /api/upload {
    limit_req zone=p2c_upload burst=10 nodelay;
    proxy_pass http://127.0.0.1:3001;
    proxy_request_buffering on;        # buffer the whole body before forwarding
  }

  location = /healthz {
    proxy_pass http://127.0.0.1:3001;
  }
}
```

Notes:
- `no-cache, must-revalidate` on `/feed/` lets ETag-conditional `304`
  responses save bandwidth on Google's polls but never serves stale
  bytes after a re-upload. **Do not set `max-age`** — it would defer
  detection.
- `immutable` on `/source/` is safe because the path includes
  `<pdf_sha256>`; the bytes at any given path never change.
- Rate-limiting caveat (design doc): colleagues behind a hospital NAT
  share an IP. V1 accepts the trade — uploads are rare. If it bites,
  raise `burst=` or move to a cookie-based limit.
- **No IP logging.** nginx's default `combined` access-log format
  writes `$remote_addr`, `$http_referer`, and `$http_user_agent` — all
  three are dropped by the `p2c` `log_format` above. The
  `limit_req_zone` directive still uses `$binary_remote_addr` in memory
  for rate-limiting (never persisted to disk). Per design doc § privacy.
- `sources/<pdf_sha256>.pdf` has no nginx route — only `rows/` (the
  per-person crops) is served via the `/source/` alias. Do **not** add
  an `autoindex` or a `/sources/` location.

### systemd

`deploy/pdf2calendar.service` skeleton:

```ini
[Unit]
Description=pdf2calendar Bun server
After=network.target

[Service]
Type=simple
User=pdf2calendar
WorkingDirectory=/opt/pdf2calendar
Environment=PDF2CAL_PORT=3001
Environment=PDF2CAL_DATA_DIR=/var/lib/pdf2calendar
Environment=PDF2CAL_BASE_URL=https://pdf2calendar.example.com
Environment=PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv
ExecStart=/usr/local/bin/bun run src/server.ts
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Logs go to journald via stdout/stderr. The orphan-sweep runs at startup
inside the Bun process — no separate `ExecStartPre`.

### Deploy procedure

Manual for V1: `git pull && bun install && bun run build && systemctl restart pdf2calendar`.
The frontend's `dist/` is rebuilt; the backend has no build step.
CI/CD is V2.

---

## Out of scope (V1)

- `/api/manifest` admin listing endpoint (V2, behind basic auth)
- `/source/<pdf_sha256>.pdf` (full-PDF view; V2, behind auth)
- In-browser codes editor; per-person code overrides
- Cleanup sweeps for departed colleagues, orphan PDFs, stale rows
- Multi-tenant deployments / department picker on the upload page
- Per-user authentication, OAuth, email
- In-process rate limiting (lives in nginx)
- IP logging, analytics, telemetry, error reporting
- Tombstone tracking (`STATUS:CANCELLED`) — deletion test confirmed unnecessary
- GitHub-Action SSH deploy
- Per-deployment VTIMEZONE override (V2 when a non-Zurich department forks)

If a real request hits any of the above, the spec defers it. The server
returns the standard rejection for the closest matching failure class.

---

## Open questions

1. **`PDF2CAL_BASE_URL` change between uploads.** If the deployment is
   moved to a new domain after the first upload, every preserved VEVENT
   keeps the old `View your row:` URL (it's part of the spliced block).
   New events use the new URL. Acceptable for V1 — domain moves are
   rare — but worth flagging for the V2 manifest cleanup path.
2. **`sources/` and `rows/` retention.** Currently never deleted. A
   `<pdf_sha256>` referenced by zero current `.ics` files (every event
   from that PDF was overwritten in a later upload) is safe to delete.
   Defer the sweep to V2; storage growth is bounded for V1 use.
3. **Listing endpoint placement.** A V2 admin "show me all feeds" UI
   could be served by Bun (`GET /api/manifest`) or by nginx `autoindex`
   on `/manifest/`. Decide when V2 starts; the manifest schema doesn't
   change either way.
4. **Per-IP rate limit collision under hospital NAT.** Likely a non-
   issue at V1 scale, but if maintainer X gets a 429 because maintainer
   Y just uploaded from the same office, we'll need a cookie-based or
   per-token limit. Defer until a real complaint.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 17 findings raised, all folded into the spec on 2026-05-16 (1 P1 resolved → semantic idempotence; 2 critical gaps resolved → corrupt-`.ics` fall-back + `hash_collision` failure mode; manifest kept with non-fatal writes; `GenerateInput.person` narrowed in code) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **UNRESOLVED:** 0
- **CRITICAL GAPS:** 0
- **VERDICT:** ENG REVIEW CLEARED — spec amendments and one code change (`src/ics.ts` type narrowing) landed in the working tree on 2026-05-16. Ready to implement `src/server.ts` per the worktree parallelization plan in the review (mergeIcs + fixture + deploy + spec edits in parallel; server in a dependent lane).
