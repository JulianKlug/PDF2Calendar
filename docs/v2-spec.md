# V2 Specification — Admin-gated uploads + landing-page staff index

Status: REVISED after eng review (2026-05-17)
Owner: @klug
Date: 2026-05-17
Related:
- Server spec: `docs/server-spec.md`
- Frontend spec: `docs/frontend-spec.md`
- iCal generator spec: `docs/ics-spec.md`
- Eng review test plan: `~/.gstack/projects/JulianKlug-PDF2Calendar/klug-v2-eng-review-test-plan-20260517-174201.md`

---

## Purpose

V1 shipped 2026-05-17. It serves per-person `.ics` feeds derived from
PDF uploads. V2 closes two gaps that emerged once people started using V1
in anger:

1. **Wrong/outdated PDF.** The upload endpoint is unauthenticated.
   Anyone — by accident or on purpose — can drop a stale or wrong PDF and
   silently overwrite events for everyone whose dates overlap. The
   uploader gets no signal that they just clobbered an existing plan.
2. **Discoverability.** Feed URLs only appear on the post-upload success
   screen. Close the tab and the only record is what individuals copied
   themselves; new joiners have no public index.

V2 adds three things without touching the ICS merge semantics on disk:

- A **permanent landing page** showing every staff member with their
  feed URL and per-month row previews — sourced from server state, not
  from a transient upload result.
- An **admin password gate** in front of the upload flow so casual or
  malicious overwrites are blocked.
- A **pre-upload overwrite confirmation** that names the previous PDF
  (with month coverage) and the incoming PDF, so the admin sees what they
  are about to replace.

> **Threat-model disclaimer.** The admin password is a shared secret with
> no per-actor identity and no audit trail. It defends against casual
> mistakes and unauthenticated stranger uploads. It does **not** attribute
> a malicious upload to a specific actor. Per-actor identity comes
> post-OAuth (TODO.md § Identity / auth).

### Explicitly out of scope

- Real auth (OAuth, email-based) — tracked in `TODO.md` § Identity / auth.
- Changing merge semantics (per-month replace, version pinning, history).
- Multi-tenant or department-picker UI.
- Per-person feed deletion UI.
- Password rotation UI (operator rotates the env var manually).
- Migration of pre-V2 data. V2 assumes a fresh data dir; existing V1
  feeds (if any) continue to be served by nginx unchanged but won't
  appear in `/api/manifest` until the corresponding plan is re-uploaded.
- "What will change" diff at confirm time (TODO.md § Frontend).

---

## Decisions (locked, post-review)

| Question | Decision |
| --- | --- |
| Upload semantics | Unchanged from V1 — ICS merge with per-date overwrite. V2 adds a confirmation gate; it does not change merge behavior. |
| Version label | Original PDF filename + upload timestamp, e.g. `Plan_Mai_2026.pdf (uploaded 2026-05-12 14:03)`. |
| Admin auth | Per-request `admin_password` field in the upload POST, validated server-side against env. No sessions/cookies. |
| Constant-time compare | Hash both inputs with SHA-256, `timingSafeEqual` over the 32-byte digests. No length-padding bookkeeping. |
| CSRF defense | Server requires `X-PDF2Cal-Admin: 1` header on `/api/upload`. Browsers don't send custom headers cross-origin without a CORS preflight; we don't allow that origin in CORS. |
| Auth isolation | All admin-auth code lives in `src/admin-auth.ts` (server) + `web/admin-auth.ts` (frontend). OAuth migration is a clean delete of those modules. |
| Preview rows UX | One button per person → lightbox with all months stacked vertically, each labeled (`May 2026`, `June 2026`, …). `<img loading="lazy">` per figure. |
| Manifest exposure | Public read endpoint, no auth (matches feed exposure). `X-Robots-Tag: noindex, nofollow` response header. `<meta name="robots" content="noindex,nofollow">` in `index.html`. |
| Manifest nginx location | Separate `location = /api/manifest` block. No rate-limit. No `proxy_cache` (Bun's in-process cache suffices at scale). |
| Pre-V2 backfill | None. V2 ships against a fresh data dir. Operator confirms before deploy. |
| `role_by_person` | NOT in plan files. Roles live in per-person manifest (already tracked in V1). |
| Confirm modal | Shows month coverage of both previous and incoming PDFs, not just filenames. |
| Password modal ordering | Before file drop (spec sequence preserved). |
| `unknown_codes` UX | When non-empty on success, suppress the 2 s auto-redirect; require admin to click "Back to staff list" so the banner is read. |
| Secret loading | systemd `Environment=` line (not `EnvironmentFile=`). Trust boundary is "anyone with root on eddy"; the password tolerates that exposure. |
| 401 observability | One `console.error` line per 401, format: `<ISO_TS> WARN admin_password_mismatch from=<x-forwarded-for>`. Goes to journald via systemd. |
| Schema version | All new disk artifacts (`plans/<sha>.json`, extended `manifest/<hash>.json`) include `schema_version: 2`. |
| Write-mutex invariant | Only `withWriteLock` mutates state on disk and bumps the manifest cache counter. Every read path (`/api/manifest`, `/healthz`) is read-only. |

---

## Server changes (`src/server.ts` + new `src/admin-auth.ts`)

### New module — `src/admin-auth.ts`

Owns everything that goes away when OAuth lands:

- `verifyAdminPassword(supplied: string, expected: string): boolean` —
  pre-hash both with SHA-256, then `timingSafeEqual` over the 32-byte
  digests. Both digests are constant-length, no padding.
- `sanitizeOriginalFilename(raw: string): string` — `throw new
  BadRequest("schema", ...)` if `raw` matches `[\x00-\x1f\x7f]` or
  contains `/` or `\`. Otherwise truncate to 200 chars.
- `logAuthFailure(req: Request): void` — single-line stderr log:
  `<ISO_TS> WARN admin_password_mismatch from=<x-forwarded-for-or-unknown>`.
  Requires the nginx upload location to forward the client IP — see
  *nginx changes* below. If the header is absent (e.g. direct hit
  bypassing nginx), logs `from=unknown` — never crashes.
- `requireAdminHeader(req: Request): void` — `throw new BadRequest("csrf",
  "missing X-PDF2Cal-Admin header")` if the header is absent or not `"1"`.

`BadRequest` import comes from `src/server.ts` (existing class). The
handler catches and turns these into 400/401 responses; this module
never touches `Response` directly.

### New env var

- `PDF2CAL_ADMIN_PASSWORD` — required at boot, fail fast if unset (same
  pattern as the other required `PDF2CAL_*` vars). Treat empty string as
  unset.

### Upload payload extension

Add to `UploadPayload`:

- `admin_password: string` — required in validation (server returns 401
  if missing or wrong).
- `original_filename: string` — the browser-supplied `File.name`,
  validated server-side via `sanitizeOriginalFilename`. The browser
  already has this from the drop zone; include it in the JSON part of
  the multipart.

### Upload handler flow

1. **Custom-header check** (very first): `requireAdminHeader(req)`. On
   miss → 400 `{error: "missing X-PDF2Cal-Admin header", code: "csrf"}`.
   This catches form-style CSRF before any other work.
2. Multipart parse (unchanged).
3. **Password check** *before* any hash work: `verifyAdminPassword(payload.admin_password,
   env.adminPassword)`. On mismatch: `logAuthFailure(req)` then
   `401 {error: "invalid_admin_password"}`.
4. All existing validation runs unchanged (schema, PDF SHA256,
   department slug, person-hash bijection, row PNG bijection).
5. **Inside the write mutex** (`src/server.ts:401–478`):
   - Write `plans/<pdf_sha256>.json` (new directory) containing:
     ```json
     {
       "schema_version": 2,
       "pdf_sha256": "...",
       "original_filename": "...",
       "uploaded_at": "2026-05-17T14:03:21.000Z",
       "months": [{ "year": 2026, "month": 5, "days_covered": [1, 2, 3, "...", 31] }, ...],
       "person_hashes": ["...", "..."]
     }
     ```
     Atomic write (temp + rename), same pattern as feeds. Idempotent:
     re-upload of the same sha overwrites cleanly.
   - Extend `manifest/<person_hash>.json`:
     - Add `schema_version: 2`. Keep existing V1 fields for read
       compatibility (V1 readers ignore unknown keys).
     - Maintain `entries[]`:
       ```json
       [{ "pdf_sha256": "...", "original_filename": "...",
          "uploaded_at": "...", "months": [{year, month}] }, ...]
       ```
     - Append-on-upload, dedup by `pdf_sha256`. On re-upload, **replace
       the entry wholesale** (filename, uploaded_at, months[]) rather
       than mutating a subset.
   - Bump the manifest cache version counter (forces the next
     `/api/manifest` to re-scan).
6. Response shape unchanged.

Note: `role_by_person` is **not** in `plans/<sha>.json`. Roles live in
the per-person manifest (the top-level `role: string` already written by
V1) and are returned by `/api/manifest` from there. This avoids the
re-upload staleness bug (if a parser/codes change updates a person's
role, every new upload writes the manifest with the corrected role).

### New endpoint — `GET /api/manifest`

Public read-only listing, served by Bun, proxied through nginx with a
**separate `/api/manifest` location** — no rate-limit, no `proxy_cache`.
The Bun-internal version-counter cache covers the scan-and-join cost.

Response headers:
- `Content-Type: application/json`
- `X-Robots-Tag: noindex, nofollow` (search-engine hint; not an auth boundary)
- `Cache-Control: no-store`

Response body:

```json
{
  "schema_version": 2,
  "department_slug": "sia-chuv",
  "latest_plan": {
    "pdf_sha256": "...",
    "original_filename": "...",
    "uploaded_at": "...",
    "months": [{ "year": 2026, "month": 5, "days_covered": [1, 2, "...", 31] }]
  },
  "plans": [
    { "pdf_sha256": "...", "original_filename": "...",
      "uploaded_at": "...",
      "months": [{ "year": 2026, "month": 5, "days_covered": [1, "..."] }] }
  ],
  "staff": [
    {
      "person_hash": "...",
      "name": "...",
      "role": "...",
      "feed_url": "https://pdf2calendar.julianklug.com/feed/<person_hash>.ics",
      "entries": [
        {
          "pdf_sha256": "...",
          "original_filename": "...",
          "uploaded_at": "...",
          "months": [{ "year": 2026, "month": 5 }],
          "row_url": "https://pdf2calendar.julianklug.com/source/<pdf_sha256>/<person_hash>.png"
        }
      ]
    }
  ]
}
```

`latest_plan` is `null` when no plans exist yet (empty data dir).

> **Row URL path.** The existing nginx alias is `location /source/` →
> `${PDF2CAL_DATA_DIR}/rows/` (`deploy/nginx.conf.example:53`). The path
> name is a V1 historical quirk; row PNGs live at `/source/<sha>/<hash>.png`,
> matching what V1 already embeds in VEVENT descriptions
> (`src/ics.ts:200`). Do NOT introduce a `/rows/` alias.

Implementation lives in a small module (e.g. `src/manifest-cache.ts`)
that owns: scan `manifest/*.json`, scan `plans/*.json`, join, cache state,
version counter, invalidation method. Only `withWriteLock` (in
`src/server.ts`) calls the invalidation method. Every read serves from
the in-memory cache.

**Cold-start behavior.** On server boot the cache is empty. The first
`GET /api/manifest` after boot does a full scan and populates the cache;
subsequent reads serve from memory until a write invalidates. No
background warmup — the first reader pays the scan cost (sub-100ms at
hospital scale).

**Manifest scan tolerance.** A `manifest/<hash>.json` file is included in
the `/api/manifest` response only if it has both `schema_version: 2` and
a non-empty `entries[]`. V1-shaped manifests (no `schema_version`, no
`entries[]`) are silently skipped from the JSON output — their feeds
still serve from nginx unchanged. Corrupt JSON: log a warning, skip the
file, continue the scan. Never crash the read path on a bad file.

**Pre-V2 data note.** V2 assumes a fresh data dir. The deploy runbook is
updated to verify the eddy data dir state before V2 ship. If pre-V2
manifests exist, their feeds continue to be served by nginx (no change
there), but they won't appear in `/api/manifest` until the corresponding
plan is re-uploaded — at which point the upload handler writes the new
`plans/<sha>.json` and extends the manifest with `entries[]`.

---

## Frontend changes (`web/`)

### State machine (`web/state.ts`)

Extend the discriminated union with new states. The admin password is
carried explicitly inside the State variants from `auth_prompt` onward;
it is cleared on every transition to `landing`, `success`, or the
`error[InvalidAdminPassword]` branch — i.e. State is the single source
of truth, matching the existing project invariant.

New states:

- `landing` — shows the staff index. **New initial state** (was `idle`).
- `auth_prompt` — modal asking for the admin password.
- `idle_upload { admin_password }` — drop-zone state (today's `idle`,
  renamed; now carrying the password).
- `confirm_overwrite { admin_password, file, parsed, rows, pdf_sha256 }`
  — modal shown after parse + hash + row render, before the POST.

Existing `parsing`, `rendering_rows`, `hashing`, `uploading`, `success`,
`error` states are extended to carry `admin_password` where they need to
survive into the POST. `success` does **not** carry the password (it's
cleared at `toSuccess`).

Auto-transition rule: `success → landing` after ~2 s, **except** when
the success screen has anything the admin must read:
- `success.result.unknown_codes.length > 0` (unknown codes banner), or
- any `whitespace_in_code` warning in `parsed.warnings` (parser-anomaly
  banner from V1; `web/main.ts:196–201`).

In either case, suppress the timer and show a manual "Back to staff
list" button. The 2 s auto-redirect happens only when the success
screen is purely informational (feeds list + no banners).

Error rule: `error[InvalidAdminPassword]` → "Wrong admin password" + a
Retry button that transitions to `auth_prompt` with the password field
empty (re-typing is required).

No client-side router — the state machine drives rendering.

### Landing page (`renderLanding()`)

- On mount: `GET /api/manifest`. Show a loading skeleton while fetching.
- Network failure on the manifest fetch → render an error state with a
  "Retry" button.
- **Empty state** (no staff): heading "No plan uploaded yet" + a single
  **Upload first plan** button (same auth gate applies).
- **Populated state**:
  - Header: `<DEPARTMENT> shift calendars`.
  - Latest-plan caption: `Latest: Plan_Mai_2026.pdf — uploaded 2026-05-12 14:03`.
  - Top-right: **Upload new plan** button.
  - Role-grouped staff list via the new shared component (see below).

### Shared staff list (`renderStaffList(items)`)

Extracted from current `web/main.ts:342–417` (the V1 success screen).

```ts
type StaffListItem = {
  person_hash: string;
  name: string;
  role: string;
  feed_url: string;
  onPreview: () => void; // caller wires its own preview source
};

function renderStaffList(items: StaffListItem[]): HTMLElement;
```

Both call sites (landing page, success screen) pass their own
`onPreview`. Landing-screen `onPreview` opens the lightbox using the
manifest's `entries[].row_url`. Success-screen `onPreview` opens the
lightbox using the in-memory `Map<person_hash, Blob>` already in the
`success` state. No `mode` flag — the difference lives in the closures.

### Preview-rows lightbox

Extend the existing lightbox (do not rewrite). Two call shapes:

1. **Blob mode** (success screen, V1 behavior): one `<figure>` with the
   in-memory PNG blob URL.
2. **URL mode** (landing screen, new): takes a person's `entries[]` and
   renders one `<figure>` per entry, stacked vertically and scrollable.
   Each `<figure>` contains:
   - `<img src={entry.row_url} loading="lazy">` — content-addressed,
     immutable cache via nginx (`max-age=31536000, immutable`).
   - `<figcaption>` labeled by month, e.g. `May 2026`.

The existing focus-trap, Escape-to-close, and click-backdrop-to-close
behavior is shared between both modes.

**Broken row URL behavior.** If a `row_url` 404s (e.g. the underlying
`rows/<sha>/<hash>.png` was manually deleted on disk), the `<img>` falls
back to the browser's broken-image icon. The lightbox does not crash;
other figures in the stack continue to render. No explicit error
handler — relying on browser-native behavior.

### Upload flow with password + confirmation

1. **Upload new plan** click on landing → enter `auth_prompt`.
2. Password modal: single password field + Submit/Cancel. On submit,
   transition to `idle_upload { admin_password }`. The password is *not*
   validated yet — we save the round-trip for the actual upload POST. A
   wrong password surfaces as a clear error after the file is dropped
   and submitted. Empty-string submission is rejected client-side
   (modal-local validation, no transition).
3. User drops PDF → existing pipeline (`parsing` → `rendering_rows` →
   `hashing`), unchanged. The password is carried through each
   transition.
4. After hashing, before POST: enter `confirm_overwrite`. Modal text:
   - If `latest_plan` exists:
     > You are about to replace **Plan_Mai_2026.pdf** (May 2026, uploaded
     > 2026-05-12 14:03) with **Plan_Mai_2026_v2.pdf** (June 2026).
     > Existing events on overlapping dates will be overwritten.
   - If no previous plan:
     > You are about to upload **Plan_Mai_2026.pdf** (May 2026) as the
     > first plan.
   - Buttons: **Cancel** (returns to `landing`, clears the password) /
     **Confirm and upload**.
   - Months come from `parsed.months[]` (incoming) and
     `landing.latest_plan.months[]` (previous, fetched at landing time;
     stale-by-construction — see invariant note below).
5. On confirm → POST `/api/upload` multipart with `X-PDF2Cal-Admin: 1`
   header, JSON part now including `admin_password` and `original_filename`.
6. On `401 invalid_admin_password` → `error[InvalidAdminPassword]` with
   "Wrong admin password" and a retry button → `auth_prompt` (empty field).
7. On `400 csrf` (missing header) → `error[unknown]` — never expected
   in practice from the SPA; signals a misconfigured client or a
   phishing attempt.

> **Confirm-modal staleness invariant.** The modal text reflects the
> manifest fetched at landing-load time. Between landing render and
> Confirm click, another admin (or another tab) can upload, changing
> `latest_plan`. The displayed previous-PDF info may be wrong; the
> server upload still runs and overwrites the *current* latest plan.
> This is last-writer-wins inside the mutex. Acceptable at hospital
> scale with one admin.

### API client (`web/api.ts` + new `web/admin-auth.ts`)

- `web/admin-auth.ts` owns the password modal render, the auth_prompt
  state shape, and the `InvalidAdminPassword` error mapping. OAuth
  migration deletes this file.
- `web/api.ts`:
  - `buildMultipart()`: include `admin_password` and `original_filename`
    in the JSON part.
  - `uploadToServer()`: add `X-PDF2Cal-Admin: 1` request header. Map
    HTTP `401` → `ErrorCause.InvalidAdminPassword`. Map `400` with
    `code: "csrf"` → `ErrorCause.unknown` (effectively shouldn't
    happen from the SPA, but log to console).

### `index.html` change

Add inside `<head>`:
```html
<meta name="robots" content="noindex,nofollow">
```

This pairs with the `X-Robots-Tag` header on `/api/manifest`. Both are
search-engine hints, not auth boundaries.

---

## Shared types (`src/types.ts`)

New exported types, shared by server + manifest cache + tests:

```ts
export type Plan = {
  schema_version: 2;
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;          // ISO 8601
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  person_hashes: string[];
};

export type ManifestEntry = {
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number }>;
};

export type PersonManifest = {
  schema_version: 2;
  name: string;
  role: string;
  // V1 fields (kept for read compatibility)
  last_uploaded_at: string;
  last_pdf_sha256: string;
  last_date_range: { start: string; end: string };
  // V2 addition
  entries: ManifestEntry[];
};
```

---

## Deploy changes (`deploy/`)

### nginx — new `location` block + X-Forwarded-For on upload

Add the manifest endpoint location. No rate-limit, no `proxy_cache` (Bun
caches in-process). Update the upload location to forward the client IP
so `logAuthFailure` can record the source of 401s — this is a deliberate
exception to the access-log redaction stance (access logs stay redacted
via the `p2c` format; the upload-only X-Forwarded-For exists for security
forensics).

```nginx
# Manifest endpoint — read-only, no rate-limit, no proxy_cache.
location = /api/manifest {
    proxy_pass http://127.0.0.1:3001;
}

# Upload endpoint — keep rate-limit, ADD client-IP forwarding for 401
# logging. (Other proxy_set_header lines if present stay as-is.)
location = /api/upload {
    limit_req zone=p2c_upload burst=10 nodelay;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://127.0.0.1:3001;
    proxy_request_buffering on;
}
```

Privacy note: the existing `p2c` log_format (`deploy/nginx.conf.example:13`)
deliberately omits `$remote_addr` from access logs. The
`proxy_set_header X-Forwarded-For` line above is scoped to `/api/upload`
only — it doesn't leak into the manifest endpoint or the static
locations. The forwarded IP is consumed only by the WARN-level
`admin_password_mismatch` log line in Bun's stderr; legitimate uploads
do not log the IP.

### systemd — new env var

In `deploy/pdf2calendar.service`, append to the existing `Environment=`
lines:

```
Environment=PDF2CAL_ADMIN_PASSWORD=<set-at-deploy-time>
```

Spec choice was to use `Environment=` rather than `EnvironmentFile=` —
trust boundary is "anyone with root on eddy" and the password tolerates
that exposure (see Decisions table).

---

## Critical files

- `src/server.ts` — handler changes, new endpoint, manifest cache wiring,
  env validation. **Does NOT contain the V1→V2 backfill** (deleted from
  scope).
- `src/admin-auth.ts` — NEW; password compare, filename sanitize, 401
  logging, CSRF header check. OAuth migration deletes this file.
- `src/manifest-cache.ts` — NEW; scan + join + version counter +
  invalidation method (only `withWriteLock` calls it).
- `src/types.ts` — NEW types: `Plan`, `ManifestEntry`, `PersonManifest`.
- `src/ics.ts` — unchanged (merge semantics preserved; existing
  `/source/` link at line 200 stays).
- `web/main.ts` — landing render, manifest fetch, modal wiring, lightbox
  extension, `renderStaffList` extraction, success-screen change for
  unknown_codes auto-redirect suppression.
- `web/state.ts` — new states + transitions + password lifecycle in State.
- `web/admin-auth.ts` — NEW; password modal render + auth_prompt logic +
  InvalidAdminPassword error mapping.
- `web/api.ts` — payload + `X-PDF2Cal-Admin` header + error mapping.
- `index.html` — `<meta name="robots" content="noindex,nofollow">`.
- `deploy/pdf2calendar.service` — add `PDF2CAL_ADMIN_PASSWORD` to
  `Environment=` lines.
- `deploy/nginx.conf.example` — add `location = /api/manifest` block
  (no rate-limit, no `proxy_cache`). `/source/` alias stays as-is.
- `CLAUDE.md` § Deploy — add `PDF2CAL_ADMIN_PASSWORD` to the eddy values
  block.
- `README.md` § Deploy — add `PDF2CAL_ADMIN_PASSWORD` to the required
  env list, mention manual rotation, add one-line rollback note ("upload
  the correct PDF; the confirm modal shows the swap"), add pre-deploy
  step "verify eddy data dir is empty / wipe if V1 data must be
  discarded".
- `docs/server-spec.md`, `docs/frontend-spec.md` — incorporate the
  changes once V2 lands (these specs are V1-current; V2-current is here).
- `TODO.md` — cross off the admin-listing-endpoint item (covered by
  `GET /api/manifest`); the OAuth / per-user auth item stays open as
  post-V2. Add new entries: "Confirm-time diff (`POST /api/diff` →
  `{people_changed, shifts_added, shifts_removed, shifts_modified}`)" and
  "Prune `entries[]` past ~50 items per person".

---

## Reused code / utilities

- Atomic write helper (`feeds/`, `manifest/`) — reuse for
  `plans/<sha256>.json`.
- Existing `BadRequest` class in `src/server.ts` — thrown from
  `src/admin-auth.ts` helpers; handler catches and converts to HTTP
  responses.
- Existing write mutex `withWriteLock` (`src/server.ts:164–177`) —
  extends to cover plan write + manifest entries[] + cache invalidation.
- Existing lightbox open/close/focus-trap (`web/main.ts:560–619`) —
  extended to take either a single in-memory blob (V1 success path)
  or an array of URL+caption pairs (V2 landing path).
- Existing role grouping + person-row rendering (`web/main.ts:342–417`)
  — extracted into `renderStaffList(items)`.
- Existing `state.ts` validation (file type, ≤5 MB) — unchanged.
- nginx already aliases `/source/` to `${PDF2CAL_DATA_DIR}/rows/`, so
  `row_url` (which uses the `/source/` path) works without any nginx
  change beyond the new `/api/manifest` location block.

---

## Verification

End-to-end manual test, in the style of
`docs/test-results/manual-upload-test-2026-05-17.md`. Pre-deploy
condition: eddy data dir is empty (operator wipes / starts fresh).

1. **Boot guards.** Start server with `PDF2CAL_ADMIN_PASSWORD` unset →
   server exits with a clear error. Set it to empty string → server
   exits. Set to a real value → server starts.
2. **Empty-state landing.** Open the production URL → empty state
   ("No plan uploaded yet" + "Upload first plan" button).
3. **First upload, full happy path.** Click **Upload first plan** →
   password modal → submit correct password → drop zone → drop PDF →
   pipeline runs → confirm modal says "first plan" with the incoming
   PDF's month range. Confirm → upload succeeds; success screen shows
   feeds; ~2 s later auto-redirects to landing (which now shows the
   populated staff list with the latest-plan caption).
4. **Wrong-password recovery.** Click **Upload new plan** → submit
   wrong password → drop PDF → after submit, error "Wrong admin
   password". Retry → returns to password modal (field empty). Submit
   correct password → proceeds.
5. **Overwrite confirmation.** With an existing latest plan, drop a new
   PDF → confirm modal shows both filenames + month ranges +
   upload dates. **Cancel** → back to landing, no changes on disk,
   password cleared. **Confirm** → upload succeeds; landing auto-
   refreshes; the new plan is now `latest_plan`.
6. **Unknown codes auto-redirect suppression.** Upload a PDF containing
   at least one code not in the codes table → success screen shows the
   unknown-codes banner. Wait > 5 s → does NOT auto-redirect. Click
   "Back to staff list" → returns to landing.
7. **Preview rows.** Click **Preview rows** on a populated landing → lightbox
   opens, images load from `/source/<sha>/<hash>.png`, each labeled by
   month, vertically scrollable. Escape and backdrop-click close.
8. **ICS merge preserved (REGRESSION).** Upload a May plan, then a June
   plan. Subscribe to one person's feed on Apple Calendar; confirm both
   months are visible. Re-upload the May plan unchanged — no duplicate
   events appear (this is the V1 merge invariant; V2 must not regress it).
9. **CSRF defense.** With `curl`, POST `/api/upload` from the command line
   *without* the `X-PDF2Cal-Admin` header → 400 with `code: "csrf"`.
   Add the header → previous handling applies.
10. **Rate-limit on upload only.** Hammer `/api/upload` 30 times in a
    minute with wrong password → nginx 429 kicks in around request 11.
    Hammer `/api/manifest` 100 times in a minute → no 429 (separate
    location, no rate-limit).
11. **Search-engine hints.** `curl -sI https://.../api/manifest | grep
    -i robots` → `noindex, nofollow`. `curl -s https://.../ | grep -i
    robots` → `<meta name="robots" content="noindex,nofollow">` present.
12. **Manifest cache invalidation.** `curl /api/manifest`, upload a new
    plan, `curl /api/manifest` again → new plan reflected.
13. **401 logging.** Submit a wrong-password upload (with the
    `X-PDF2Cal-Admin` header). `journalctl -u pdf2calendar | tail -5` →
    one new `WARN admin_password_mismatch from=<ip>` line, IP populated
    (not `unknown`) because nginx is forwarding it.
14. **V1-manifest tolerance.** Drop a stray V1-shaped
    `manifest/<hash>.json` (no `schema_version`, no `entries[]`) into
    the data dir. `curl /api/manifest` → returns 200 and that person is
    silently absent from `staff[]`. Server log has no error.
15. **`bun test`** passes. New unit tests cover:
    - `admin-auth.verifyAdminPassword`: right, wrong, missing, empty, near-miss
      (single char off).
    - `admin-auth.sanitizeOriginalFilename`: control char, path sep,
      250-char input, normal input.
    - `requireAdminHeader`: missing → 400, present `"1"` → ok, other
      values → 400.
    - `admin-auth.logAuthFailure`: emits one line; format includes ISO
      timestamp, fixed `admin_password_mismatch` token, and
      `from=<value-or-unknown>`.
    - Manifest endpoint shape (golden fixture, populated + empty).
    - Manifest cache invalidation after upload.
    - Manifest scan tolerance: V1-shaped manifest is skipped; corrupt
      JSON is skipped + logged; the rest of the scan still completes.
    - Plan write: new sha → file appears; re-upload of same sha →
      atomic overwrite; `entries[]` replace-wholesale semantics.
    - State machine new transitions, each verified to preserve OR clear
      the password as appropriate:
      - `landing → auth_prompt` (no password yet)
      - `auth_prompt → idle_upload` (preserves password)
      - `auth_prompt → landing` on Cancel (clears password)
      - `confirm_overwrite → uploading` (preserves password)
      - `confirm_overwrite → landing` on Cancel (clears password)
      - `success → landing` auto-redirect (clears password; suppressed
        when `unknown_codes.length > 0` OR any `whitespace_in_code`
        warning is present)
      - `error[InvalidAdminPassword] → auth_prompt` on Retry (clears
        password)
    - Regressions: all 28 existing `test/server.test.ts` tests pass
      unchanged.

Deploy via the eddy runbook (`README.md § Deploy`): confirm data dir is
fresh, `git pull`, `bun install`, `bun run build` with
`VITE_DEPARTMENT_SLUG=sia-chuv`, add `PDF2CAL_ADMIN_PASSWORD` to the
systemd unit's environment, add the new `/api/manifest` location to
nginx, `nginx -t && systemctl reload nginx`, `systemctl restart
pdf2calendar`, hit `/healthz`, then walk the verification steps above
against production.
