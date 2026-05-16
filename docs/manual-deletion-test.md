# Manual Deletion Test

Status: **PASSED 2026-05-15** — both Google + Apple deleted cleanly. See
[`docs/test-results/manual-deletion-test-2026-05-15.md`](test-results/manual-deletion-test-2026-05-15.md)
for the recorded run. Architecture gate cleared; server build unblocked.
Runbook retained for regression use if Google's poll behavior changes.

Owner: @klug
Time budget: 30 min hands-on + ≤24 h waiting on Google's poll

---

## What you're testing

> When a previously-published shift is removed from a re-published `.ics`
> file at the same URL, do Google Calendar and Apple Calendar **delete**
> the event from the user's calendar?

This is the load-bearing assumption behind the whole "subscribe by URL"
design. If it fails, every event needs an explicit `STATUS:CANCELLED`
tombstone for one or more publish cycles, and the server must track which
UIDs to tombstone in the per-person manifest. That's a meaningfully bigger
build.

---

## Decision tree (read first, so you know what each outcome means)

| Outcome | What it means | What to do |
|---|---|---|
| **Both Google + Apple delete cleanly** | Architecture works as written. | Proceed to build the server. |
| **Apple deletes, Google ignores** | Subscribe-by-URL works for clients that respect the diff, but Google needs explicit tombstones. | Switch the iCal generator to **always** emit `STATUS:CANCELLED` for events that disappeared in the previous publish. Update design doc. Track tombstones in `manifest/<person_hash>.json`. Then build the server. |
| **Both ignore** | Subscribe-by-URL doesn't work at all for our use case. | Bigger rethink. Probably need OAuth + Google Calendar API for direct event mutation. Stop, escalate to design discussion. |
| **Apple ignores, Google deletes** | Surprising — Apple is normally the polite one. Sanity-check the test setup before treating this as real. | Re-run with a different shift removed, verify Apple's refresh cadence. |

---

## Prereqs

- [ ] Parser passes its tests (`bun test`)
- [ ] `src/ics.ts` is implemented and snapshot-tested
- [ ] Your Google account (the one whose calendar you'll subscribe with)
- [ ] An iPhone or iPad with Apple Calendar (you'll force-refresh this side)
- [ ] An HTTPS endpoint you control where you can place a file at a stable
      URL. Options:
  - Your VPS with nginx already running (cleanest)
  - `python3 -m http.server` on your VPS, behind nginx as a temporary
    location block
  - Any static-file host you can update in place (Netlify, Cloudflare Pages,
    GitHub Pages branch). HTTPS is required for some clients.

---

## Phase 0 — Pick the test fixture

You need a real shift you can identify in your own calendar. From the
Mars-Avril 2026 PDF, your row is `Klug, J` (role: `ma`).

Pick **one** shift to delete in v2. Good candidates are unambiguously
yours and not adjacent to other events:

- A `Nw13` (night shift starting 20:00, ending 08:00 next day)
- A `C3` or similar day shift
- An `L4` long shift

Avoid: `X`, `V`, multi-code cells, the very first and very last day of the
range (boundary edge cases muddle the result).

**Write down your pick:** _e.g., `Nw13 on 2026-04-19`_

---

## Phase 1 — Build v1 and v2 .ics files

Save this as `scripts/deletion-test-build.ts`:

```ts
// Generates two .ics files for the deletion test.
// Run: bun scripts/deletion-test-build.ts <date-to-delete>
// Example: bun scripts/deletion-test-build.ts 2026-04-19

import { readFile, writeFile } from "node:fs/promises";
import { parse } from "../src/parser";
import { generate } from "../src/ics";
import { codes } from "../src/codes";
import { createHash } from "node:crypto";

const PDF_PATH = "example_data/5_Mars2026_26.03_30.04.2026.pdf";
const PERSON_NAME = "Klug, J";
const DEPARTMENT_SLUG = "anesthesia-test";
const BASE_URL = "https://example.com";   // placeholder; not exercised in this test
const TARGET_DATE = process.argv[2];      // YYYY-MM-DD

if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
  console.error("Usage: bun scripts/deletion-test-build.ts YYYY-MM-DD");
  process.exit(1);
}

const sha256 = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

const normalize = (s: string) =>
  s.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");

const pdfBytes = new Uint8Array(await readFile(PDF_PATH));
const pdfHash = sha256(pdfBytes);
const personHash = sha256(`${DEPARTMENT_SLUG}|${normalize(PERSON_NAME)}`).slice(0, 16);

const result = await parse(pdfBytes);
const person = result.people.find(p => p.name === PERSON_NAME);
if (!person) throw new Error(`Person not found: ${PERSON_NAME}`);

const sourceMeta = {
  file_name: PDF_PATH.split("/").pop()!,
  uploaded_at: new Date("2026-05-03T12:00:00Z"),  // fixed for v1
  pdf_sha256: pdfHash,
  base_url: BASE_URL,
};

// v1 — full schedule
const v1 = generate({ person, person_hash: personHash, codes, source: sourceMeta, emit_tentative_for_prefixes: true });
await writeFile("/tmp/klug-v1.ics", v1);

// v2 — same schedule, target date emptied
const personV2 = {
  ...person,
  days: person.days.map(d => d.date === TARGET_DATE ? { ...d, codes: [] } : d),
};
const sourceMetaV2 = { ...sourceMeta, uploaded_at: new Date("2026-05-04T12:00:00Z") };
const v2 = generate({ person: personV2, person_hash: personHash, codes, source: sourceMetaV2, emit_tentative_for_prefixes: true });
await writeFile("/tmp/klug-v2.ics", v2);

const v1Events = (v1.match(/BEGIN:VEVENT/g) || []).length;
const v2Events = (v2.match(/BEGIN:VEVENT/g) || []).length;

console.log(`v1: /tmp/klug-v1.ics  (${v1Events} events)`);
console.log(`v2: /tmp/klug-v2.ics  (${v2Events} events)`);
console.log(`Removed shift on ${TARGET_DATE}`);
console.log(`Difference: ${v1Events - v2Events} event(s)`);
console.log(`Person hash (for sanity): ${personHash}`);
```

Run it with the date you picked:

```bash
bun scripts/deletion-test-build.ts 2026-04-19
```

**Sanity checks:**

- [ ] `v1Events - v2Events === 1` (exactly one event removed; if more, your
      target date had a multi-code cell — pick a different date)
- [ ] `diff /tmp/klug-v1.ics /tmp/klug-v2.ics` shows: one VEVENT block
      missing, plus a DTSTAMP delta on remaining events (expected — the
      `uploaded_at` differs)
- [ ] Both files end with `END:VCALENDAR` followed by CRLF

---

## Phase 2 — Host v1 at a stable URL

Pick **one** hosting strategy. The URL must be:
- HTTPS (Apple requires it; Google strongly prefers it)
- Stable across the test (you'll overwrite the file at the same URL for v2)
- Returning `Content-Type: text/calendar; charset=utf-8`

### Option A — VPS with nginx (recommended)

```nginx
location = /test-deletion/klug.ics {
  alias /var/www/test-deletion/klug.ics;
  default_type text/calendar;
  charset utf-8;
  add_header Cache-Control "no-cache, must-revalidate";
}
```

```bash
sudo mkdir -p /var/www/test-deletion
sudo cp /tmp/klug-v1.ics /var/www/test-deletion/klug.ics
sudo nginx -t && sudo systemctl reload nginx
```

URL: `https://your-domain.example/test-deletion/klug.ics`

### Option B — `python3 -m http.server` on your VPS

```bash
cp /tmp/klug-v1.ics /tmp/test-deletion/klug.ics
cd /tmp/test-deletion
python3 -m http.server 8443 --bind 127.0.0.1
```

Reverse-proxy through nginx with the same `Content-Type` header.

### Verify

```bash
curl -I https://your-domain.example/test-deletion/klug.ics
# Expect: 200, Content-Type: text/calendar
curl https://your-domain.example/test-deletion/klug.ics | head -20
# Expect: BEGIN:VCALENDAR ... VTIMEZONE ... etc
```

- [ ] URL returns the .ics over HTTPS
- [ ] `Content-Type: text/calendar`
- [ ] First line is `BEGIN:VCALENDAR\r\n`

---

## Phase 3 — Subscribe in Google Calendar

1. Open <https://calendar.google.com>
2. Left sidebar → **Other calendars** → **+** → **From URL**
3. Paste the URL from Phase 2
4. Click **Add calendar**
5. Wait a few seconds, then check the left sidebar — a new entry appears
   (named after the URL or "pdf2calendar").

- [ ] Calendar appears in the sidebar
- [ ] Your March/April 2026 shifts are visible on the calendar grid
- [ ] Click your test-target event (the one you'll delete in v2). Confirm
      the title, date, and start/end times match the PDF.
- [ ] **Note the time** you completed this step. Google's first poll
      typically happens within minutes; subsequent polls every 8–24 h.

---

## Phase 4 — Subscribe in Apple Calendar (iPhone)

1. iPhone → **Settings** → **Calendar** → **Accounts** → **Add Account** → **Other** → **Add Subscribed Calendar**
2. Server: paste the URL from Phase 2
3. Tap **Next**, then **Save**
4. Open the **Calendar** app, scroll to April 2026

- [ ] Subscribed calendar shows up under "Subscribed"
- [ ] Your shifts are visible
- [ ] Tap your test-target event. Confirm title, date, and times.
- [ ] Set the refresh interval: **Settings** → **Calendar** → **Accounts** →
      **[your subscription]** → **Refresh** → **Every 5 Minutes**.
      (Apple defaults to "Every Week" which is useless for testing.)

---

## Phase 5 — Wait for v1 to settle

Don't proceed until both calendars show v1 events accurately. Skipping
this step turns a clean deletion test into "I don't know what happened to
which version" noise.

- [ ] Google: target event visible, no duplicates, no missing days
- [ ] Apple: target event visible, no duplicates, no missing days

---

## Phase 6 — Replace v1 with v2 at the same URL

```bash
sudo cp /tmp/klug-v2.ics /var/www/test-deletion/klug.ics
# Verify the file is the smaller one
wc -c /var/www/test-deletion/klug.ics /tmp/klug-v1.ics /tmp/klug-v2.ics
```

- [ ] File replaced
- [ ] Filesystem timestamp updated (`ls -la`)
- [ ] `curl https://your-domain.example/test-deletion/klug.ics | grep -c BEGIN:VEVENT` returns the v2 count (one less than v1)
- [ ] **Note the time** you completed this step. This is `T0`.

---

## Phase 7 — Force re-poll on each client

### Apple (fast path — minutes)

iPhone Calendar app → swipe down on the month view to pull-to-refresh.
Then wait up to 5 minutes (the interval you set in Phase 4). If you don't
trust the pull-to-refresh, toggle the subscribed calendar off and on in
**Settings** → **Calendar** → **Accounts** → **[subscription]**.

### Google (slow path — sometimes hours)

Google does not expose a "refresh now" button for subscribed-by-URL
calendars. There are two reliable speed-ups:

**Option A (recommended): unsubscribe and resubscribe.**
- Sidebar → hover the calendar → settings → **Unsubscribe**
- Repeat Phase 3 with the same URL.
- This **does not** test in-place poll behavior — it tests
  fetch-on-subscribe behavior. They're usually the same, but flag this
  in your notes.

**Option B (cleaner test, slow): wait.**
Leave the test running and check at the 1 h, 4 h, 12 h, and 24 h marks.
This is the only way to know what real users will experience.

If you have time, do **B** for the rigorous answer. If you need a quick
"probably works" signal, **A** is fine for V1.

---

## Phase 8 — Observe

For each client, the result is one of three states:

| State | Description |
|---|---|
| **DELETED** | Event is gone from the calendar. Tapping the previous date shows nothing for that shift. |
| **STALE** | Event is still visible. The other shifts in v2 may have updated DTSTAMP, but the deleted event persists. |
| **DUPLICATED** | Event is visible, possibly multiple times. (Rare; usually a UID stability bug, not a deletion bug.) |

Check both clients separately:

- [ ] Google Calendar — state: ☐ DELETED  ☐ STALE  ☐ DUPLICATED
- [ ] Apple Calendar — state: ☐ DELETED  ☐ STALE  ☐ DUPLICATED

For each STALE result, also check the surrounding shifts — if they updated
their times or descriptions in v2, that confirms the client *is* polling
and merging, just not deleting. That's the failure mode the tombstone
fallback fixes.

---

## Phase 9 — Record results

Append to `docs/test-results/manual-deletion-test-{date}.md`:

```markdown
# Manual deletion test — {YYYY-MM-DD}

- Tester: @klug
- Target shift removed: {Nw13 on 2026-04-19}
- v1 event count: {N}
- v2 event count: {N-1}
- v1 published at: {ISO time}
- v2 published at: {ISO time} (T0)
- URL: {url}

## Google Calendar
- Subscribed at: {ISO time}
- Re-poll method: {wait | unsubscribe-resubscribe}
- Time to observe: {minutes/hours}
- Result: {DELETED | STALE | DUPLICATED}
- Notes: {anything weird}

## Apple Calendar
- Subscribed at: {ISO time}
- Refresh interval: 5 minutes
- Time to observe: {minutes}
- Result: {DELETED | STALE | DUPLICATED}
- Notes: {anything weird}

## Decision
{One of:
  - Both deleted → architecture as written. Proceed to server build.
  - Google STALE → switch to STATUS:CANCELLED tombstone fallback. Update design doc. Then build server.
  - Both STALE → escalate. Subscribe-by-URL is not viable; consider OAuth + Calendar API.
}
```

Commit the result file. Future-you (or a future contributor) will need to
know what was tested, when, and what was decided.

---

## Cleanup

Once the result is recorded:

- [ ] Unsubscribe from both calendars (Google + Apple)
- [ ] Remove `/var/www/test-deletion/klug.ics`
- [ ] Remove the nginx location block, reload nginx
- [ ] Delete `/tmp/klug-v1.ics`, `/tmp/klug-v2.ics`
- [ ] Keep `scripts/deletion-test-build.ts` in the repo — it's useful for
      regression testing if Google ever changes behavior

---

## Common pitfalls

- **Cache headers wrong.** If your nginx config caches the .ics, the new
  version may not be fetched. Set `Cache-Control: no-cache, must-revalidate`
  for the test endpoint.
- **HTTP, not HTTPS.** Apple silently refuses `http://` subscriptions on
  recent iOS versions. Always use HTTPS.
- **Wrong Content-Type.** Some clients accept `application/octet-stream`,
  others don't. Always serve `text/calendar`.
- **Wall-clock vs. timezone confusion.** If your shift appears at the wrong
  hour, that's a `VTIMEZONE` / `TZID` bug, not a deletion bug. Fix it
  before running this test, otherwise you'll second-guess the test result.
- **DTSTAMP stale.** Some clients use DTSTAMP for tie-breaking. v2 must
  have a later DTSTAMP than v1, or the client may discard v2. The test
  script handles this (different `uploaded_at`).
- **UID instability.** If your `person_hash` or normalize() changes
  between v1 and v2, every UID changes, every event "disappears and
  re-appears" — looks like deletion works, but for the wrong reason.
  The test script uses a fixed person hash.
