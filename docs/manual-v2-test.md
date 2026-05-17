# Manual V2 Verification

Status: RUNBOOK
Owner: @klug
Time budget: 45–60 min (Phases 1–6 local, Phases 7–11 against production)

End-to-end smoke for V2 (admin-gated uploads, landing-page staff index,
overwrite confirmation). Pairs with `docs/v2-spec.md` § Verification —
each phase below maps to one numbered spec step, plus the V1 ICS merge
regression check (Phase 8).

V1's `docs/manual-upload-test.md` still covers the parse → render → POST
pipeline. This runbook only exercises what V2 added or changed.

---

## What you're testing

> Does the admin gate stop anonymous uploads without breaking the V1
> ICS merge contract? Does the landing page show every staff member
> with a working feed URL and per-month previews? Does the confirm
> modal name what's about to be replaced?

Failure of any phase means the spec, the implementation, or both are
wrong. Record what you saw, capture screenshots / curl output, and
file a regression before deploy.

---

## Prereqs

- [ ] `bun test` is green on the V2 branch (186+ pass / 1 skip / 0 fail)
- [ ] `VITE_DEPARTMENT_SLUG=sia-chuv bun run build` succeeds
- [ ] You have a real shift PDF in `example_data/` (Phases 3–6 need it)
- [ ] A second PDF in `example_data/` that covers a different month
      (Phase 5 + Phase 8 need it; same person on both)
- [ ] A third PDF containing at least one code outside the V1 codes
      table (Phase 6 needs it; the parser-emitted `unknown_codes` is
      what suppresses the auto-redirect)
- [ ] Decide a test admin password (anything non-empty) — use the same
      value for local + prod, written down somewhere outside this file
- [ ] Shell access to eddy for Phases 9–13 (`ssh eddy` + sudo)
- [ ] An Apple device or Google Calendar account for Phase 8

---

## Phase 0 — Pre-deploy data dir state

V2 assumes a fresh `PDF2CAL_DATA_DIR`. On eddy:

```sh
ssh eddy
sudo ls /var/lib/pdf2calendar/manifest/ | head
```

- [ ] Either the dir is empty, OR you've decided to wipe (V1 feeds
      keep serving from nginx but will be silently absent from
      `/api/manifest` until re-uploaded)
- [ ] If wiping, run the cutover block from `README.md § Pre-V2 → V2
      cutover`:

```sh
sudo systemctl stop pdf2calendar
sudo rm -rf /var/lib/pdf2calendar/{feeds,manifest,sources,rows,plans}
sudo systemctl start pdf2calendar
```

- [ ] Operator (you) signed off on the wipe decision

---

## Phase 1 — Local boot guards

Per spec § Verification step 1. Three sub-checks on the dev server,
all using `bun run start` from a clean shell.

```sh
# 1a. Unset → fail-fast
PDF2CAL_DATA_DIR=/tmp/p2c-v2 \
PDF2CAL_BASE_URL=http://localhost:3001 \
PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv \
bun run start
```

- [ ] Server exits immediately with
      `PDF2CAL_ADMIN_PASSWORD is required (empty string counts as unset)`

```sh
# 1b. Empty string → fail-fast
PDF2CAL_DATA_DIR=/tmp/p2c-v2 \
PDF2CAL_BASE_URL=http://localhost:3001 \
PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv \
PDF2CAL_ADMIN_PASSWORD="" \
bun run start
```

- [ ] Same error; non-zero exit

```sh
# 1c. Real value → boots
PDF2CAL_DATA_DIR=/tmp/p2c-v2 \
PDF2CAL_BASE_URL=http://localhost:3001 \
PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv \
PDF2CAL_ADMIN_PASSWORD=test-password \
bun run start
```

- [ ] `pdf2calendar listening on :3001 (data=…, base=…, dept=anesthesia-chuv)`
- [ ] `curl -s localhost:3001/healthz` returns `{"ok":true}`

Leave the server (1c) running for Phases 2–8. Pair it with the dev
SPA:

```sh
VITE_DEPARTMENT_SLUG=anesthesia-chuv \
VITE_API_BASE_URL=http://localhost:3001 \
bun run dev
```

---

## Phase 2 — Empty-state landing (spec step 2)

- [ ] Open the dev SPA URL (Vite prints it; e.g. `http://localhost:5173`)
- [ ] Page header: `anesthesia-chuv shift calendars`
- [ ] Body shows `No plan uploaded yet.` + `[Upload first plan]` button
- [ ] No staff list, no latest-plan caption
- [ ] DevTools Network tab shows one `GET /api/manifest` returning
      `{schema_version: 2, latest_plan: null, plans: [], staff: []}`
- [ ] Response headers include `X-Robots-Tag: noindex, nofollow` and
      `Cache-Control: no-store`

---

## Phase 3 — First upload, full happy path (spec step 3)

- [ ] Click `[Upload first plan]` → password modal appears, input
      focused, type=`password`
- [ ] Submit empty → inline error `Please enter the admin password.`,
      no transition
- [ ] Type the Phase 1c password → drop zone (`Drop your shift PDF here`)
- [ ] Drop a real PDF → progress spinner with the V1 labels
- [ ] After hashing: confirm modal appears with
      `You are about to upload {filename} ({Month Year}) as the first
      plan.`
- [ ] Click `[Confirm and upload]` → success screen shows the role-
      grouped feed list
- [ ] ~2 s later: page transitions to the landing page automatically
- [ ] Landing now shows `Latest: {filename} — uploaded {YYYY-MM-DD HH:MM}`
      and the role-grouped staff list, each row with a working
      `[Copy URL]` and `[Open in Google Calendar]`

---

## Phase 4 — Wrong-password recovery (spec step 4)

- [ ] From the populated landing, click `[Upload new plan]` → password
      modal
- [ ] Type a deliberately wrong password → drop zone
- [ ] Drop the same PDF as Phase 3 → after upload the screen shows
      `Wrong admin password.` + `Re-enter the password and try again.`
      + a `[Retry password]` button
- [ ] Click `[Retry password]` → returns to the password modal with
      the field empty (re-typing required per spec § State machine)
- [ ] Type the correct password → drop zone → drop the PDF → confirm
      modal → success

---

## Phase 5 — Overwrite confirmation (spec step 5)

Pre: at least one prior successful upload (Phase 3 or 4).

- [ ] Click `[Upload new plan]` → password → drop the **second** PDF
      (different filename, different month)
- [ ] Confirm modal now reads:
      `You are about to replace {previous filename} ({Month Year},
      uploaded {ts}) with {new filename} ({Month Year}). Existing
      events on overlapping dates will be overwritten.`
- [ ] Click `[Cancel]` → returns to landing; `Latest:` caption
      unchanged; on-disk feeds unchanged (`ls /tmp/p2c-v2/plans/`
      shows only the Phase 3 plan file)
- [ ] Repeat the click → confirm modal → click `[Confirm and upload]`
      → success → auto-redirect → landing now shows the new plan as
      `Latest:`

---

## Phase 6 — Unknown-codes auto-redirect suppression (spec step 6)

- [ ] Click `[Upload new plan]` → password → drop a PDF containing at
      least one code outside the V1 dictionary
- [ ] Success screen shows the yellow `Unrecognized codes` banner
      listing the offending codes
- [ ] Wait > 5 s → page does **not** auto-redirect; success screen
      stays put
- [ ] Click `[Back to staff list]` → landing
- [ ] Also: if the parser emits a `whitespace_in_code` warning (rare;
      means the parser failed to split a multi-shift cell), the same
      suppression rule applies — the red `Parsing issue detected`
      banner stops the timer

---

## Phase 7 — Preview rows lightbox (URL mode, spec step 7)

- [ ] On the populated landing, pick any person and click `[Preview row]`
- [ ] Lightbox opens with a vertical stack of `<figure>` elements —
      one per uploaded plan that person appears in
- [ ] Each `<figcaption>` reads e.g. `May 2026 · Plan_Mai_2026.pdf`
- [ ] Images load from `http://localhost:3001/source/<sha>/<hash>.png`
      (DevTools Network) and use `loading="lazy"`
- [ ] Scroll inside the lightbox — figures stack vertically
- [ ] Press `Esc` → lightbox closes, focus returns to `[Preview row]`
- [ ] Re-open → click backdrop → closes
- [ ] (Optional) Manually delete one row PNG on disk
      (`rm /tmp/p2c-v2/rows/<sha>/<hash>.png`), re-open lightbox →
      the affected figure shows the browser broken-image icon; other
      figures still render (per spec L347–350)

---

## Phase 8 — ICS merge regression (V1 invariant preserved)

Spec § Verification step 8. **This is the load-bearing regression check.**

- [ ] From the success of Phase 5 (April plan, then May plan), subscribe
      one person's `webcal://` URL on Apple Calendar **or** open it via
      Google Calendar's "From URL"
- [ ] Confirm both April and May shifts render
- [ ] In the SPA, re-upload the **May** plan unchanged
- [ ] Refresh the calendar (Apple: pull-down; Google: wait a poll cycle)
- [ ] **No duplicate events** appear — the V1 per-date overwrite is
      intact. If duplicates appear, STOP: V2 has broken the V1 merge
      contract and must not deploy.

---

## Phase 9 — CSRF defense via curl (spec step 9)

Run on eddy (or any host that can reach the dev server). Replace
`HOST` with `localhost:3001` (local) or `pdf2calendar.julianklug.com`
(prod).

```sh
# Without the header → 400 csrf
curl -i -X POST \
  -F 'payload={"x":1};type=application/json' \
  -F 'pdf=@/dev/null;type=application/pdf' \
  "https://HOST/api/upload"
```

- [ ] HTTP 400; response body contains `"code":"csrf"`

```sh
# With the header, but everything else still wrong → 400 schema (no csrf)
curl -i -X POST \
  -H 'X-PDF2Cal-Admin: 1' \
  -F 'payload={"x":1};type=application/json' \
  -F 'pdf=@/dev/null;type=application/pdf' \
  "https://HOST/api/upload"
```

- [ ] HTTP 400; body code is `schema` (not `csrf`) — CSRF gate passed,
      schema validator caught the missing fields

---

## Phase 10 — Rate-limit isolation (spec step 10)

Hit `/api/upload` 30× in a minute with wrong password. nginx's
`p2c_upload` zone (`deploy/nginx.conf.example` line 8) caps at
`10r/m` with burst=10.

```sh
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST -H 'X-PDF2Cal-Admin: 1' \
    -F 'payload={};type=application/json' \
    "https://HOST/api/upload"
done | sort | uniq -c
```

- [ ] Around request 11+ the status flips to `429` (nginx) — count
      both `400` and `429` lines

Then hammer `/api/manifest` 100× in a minute:

```sh
for i in $(seq 1 100); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    "https://HOST/api/manifest"
done | sort | uniq -c
```

- [ ] 100× `200`; no `429` (separate `location = /api/manifest` block,
      no rate-limit)

---

## Phase 11 — Search-engine hints (spec step 11)

```sh
curl -sI "https://HOST/api/manifest" | grep -i robots
```

- [ ] Output contains `X-Robots-Tag: noindex, nofollow`

```sh
curl -s "https://HOST/" | grep -i 'name="robots"'
```

- [ ] Output contains
      `<meta name="robots" content="noindex,nofollow" />`

These are search-engine hints, not auth boundaries — but they should
be present.

---

## Phase 12 — Manifest cache invalidation (spec step 12)

```sh
# Before
curl -s "https://HOST/api/manifest" | jq '.latest_plan.pdf_sha256 // null'
```

- [ ] Note the value

Upload a new plan via the SPA (Phase 5-style). Then:

```sh
# After
curl -s "https://HOST/api/manifest" | jq '.latest_plan.pdf_sha256 // null'
```

- [ ] Value changed — the in-process cache was invalidated at the end
      of the write mutex

---

## Phase 13 — 401 logging in journald (spec step 13)

After a wrong-password upload from the SPA (Phase 4 produces one), on
eddy:

```sh
sudo journalctl -u pdf2calendar -n 20 --no-pager | grep -i admin_password_mismatch
```

- [ ] One line per failed attempt with shape
      `{ISO_TS} WARN admin_password_mismatch from={ip}`
- [ ] `{ip}` is the **real client IP**, not `unknown` — that confirms
      nginx is forwarding `X-Forwarded-For` on `/api/upload` per the
      updated `deploy/nginx.conf.example`

If you see `from=unknown` from a request that came through nginx, the
nginx config wasn't reloaded after deploy — `sudo nginx -t &&
sudo systemctl reload nginx`.

---

## Phase 14 — V1-manifest tolerance (spec step 14)

Stop the dev server. Plant a V1-shaped manifest:

```sh
echo '{
  "name": "Legacy, V",
  "role": "ma",
  "last_uploaded_at": "2026-04-01T10:00:00.000Z",
  "last_pdf_sha256": "old",
  "last_date_range": {"start": "2026-04-01", "end": "2026-04-30"}
}' > /tmp/p2c-v2/manifest/0000000000000001.json
```

Restart the server. Then:

```sh
curl -s "http://localhost:3001/api/manifest" | jq '.staff | map(.person_hash)'
```

- [ ] `0000000000000001` is **not** in `staff[]` — V1-shaped manifests
      are silently skipped per spec L240–244
- [ ] No error / warning in the server log; the rest of the scan
      completed

---

## Phase 15 — `bun test`

- [ ] `bun test` is green (186+ pass / 1 skip / 0 fail)

This is the per-commit gate; you ran it during Prereqs but re-run it
on the deploy SHA to make sure nothing rotted in transit.

---

## Record results

Append to `docs/test-results/manual-v2-test-{YYYY-MM-DD}.md`:

```markdown
# Manual V2 verification — {YYYY-MM-DD}

- Tester: @klug
- Runbook: `docs/manual-v2-test.md`
- Target: `https://pdf2calendar.julianklug.com` (eddy, systemd + nginx)
- Build: V2 branch at SHA {sha}
- Department slug: sia-chuv
- Admin password: {documented out-of-band; not in this file}

## Phase results

- Phase 0 data dir state: PASS / WIPED — notes
- Phase 1 boot guards (1a unset / 1b empty / 1c real): PASS / FAIL — notes
- Phase 2 empty-state landing: PASS / FAIL — notes
- Phase 3 first upload happy path: PASS / FAIL — notes
- Phase 4 wrong-password recovery: PASS / FAIL — notes
- Phase 5 overwrite confirmation: PASS / FAIL — notes
- Phase 6 unknown-codes auto-redirect suppression: PASS / FAIL — notes
- Phase 7 preview rows lightbox: PASS / FAIL — notes
- Phase 8 ICS merge regression: PASS / FAIL — notes  ⚠ load-bearing
- Phase 9 CSRF defense (curl): PASS / FAIL — notes
- Phase 10 rate-limit isolation: PASS / FAIL — notes
- Phase 11 search-engine hints: PASS / FAIL — notes
- Phase 12 manifest cache invalidation: PASS / FAIL — notes
- Phase 13 401 logging (journald): PASS / FAIL — notes
- Phase 14 V1-manifest tolerance: PASS / FAIL — notes
- Phase 15 bun test: PASS / FAIL — {pass count} / {fail count}

## Decision

{One of:
  - All pass → V2 user-facing rollout: complete.
  - Phase 8 failed → STOP, do not deploy: V1 merge contract regressed.
  - Other phases failed → file regressions, list which.
}
```

Commit the result file so future-you knows what shipped and when.

---

## Common pitfalls

- **`from=unknown` in journald.** nginx wasn't reloaded after the
  `proxy_set_header X-Forwarded-For` line was added to `/api/upload`.
  `sudo nginx -t && sudo systemctl reload nginx`.

- **`/api/manifest` shows V1 people as "missing".** Expected by design
  — V1 manifests don't have `schema_version: 2` or `entries[]`.
  They'll reappear on the next upload for each person. Either accept
  this, or wipe the data dir before deploy (Phase 0).

- **Confirm modal says "first plan" on the second upload.** The
  landing page hasn't re-fetched `/api/manifest` between success and
  the next upload. The auto-redirect path explicitly re-fetches —
  check the Network tab. If this regresses, it's the bug Plan agent
  G10 called out and Phase 12 should have caught.

- **Lightbox URL-mode shows broken images.** The `/source/` nginx
  alias is mapped to `${PDF2CAL_DATA_DIR}/rows/` (V1 historical
  quirk, spec L220–225). Check that the alias is intact and the
  rows/ directory has the expected `<sha>/<hash>.png` files.

- **Rate-limit fires on `/api/manifest`.** The two locations need to
  be **separate `location = /api/upload` and `location = /api/manifest`
  blocks** in nginx. A single regex location with `limit_req` rate-
  limits both, which fails Phase 10.
