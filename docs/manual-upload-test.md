# Manual Upload Test

Status: RUNBOOK
Owner: @klug
Time budget: 30–45 min hands-on (steps 5–7 require the backend to exist)

This is the end-to-end smoke test for the browser-side pipeline described in
`docs/frontend-spec.md`. It covers: parse → render rows → hash → POST →
result list → preview → copy → subscribe.

Steps 1–4 and 8–10 can be exercised today against a frontend-only dev server.
Steps 5–7 wait on the server-side `/api/upload` endpoint and a real
`webcal://` host.

---

## What you're testing

> Does the full pipeline produce a correct per-person `webcal://` URL for a
> known fixture, and does that URL — when handed to Google Calendar — render
> the right shifts in the user's own calendar?

Failure of any phase below means the spec is wrong, the implementation is
wrong, or both. Record what you saw and which phase failed.

---

## Prereqs

- [ ] `bun test` is green on `main`
- [ ] You have a `VITE_DEPARTMENT_SLUG` value matching the deployment whose
      codes table you want to use (e.g. `anesthesia-chuv`)
- [ ] You have a `VITE_API_BASE_URL` pointing at a running backend, OR you
      accept that steps 5–7 will hit the `network` error screen
- [ ] You can access the page on both a desktop browser and a phone (or
      narrow-viewport DevTools ≤ 640 px)
- [ ] A Google account on which you don't mind subscribing/unsubscribing to a
      test calendar
- [ ] (Optional) An iPhone/iPad for the Apple Calendar leg

---

## Phase 0 — Start the backend

The server lives at `src/server.ts`; run it in a second terminal before
Phase 1 so the upload phases (5–7) have somewhere to POST. Three env
vars are required (see `docs/server-spec.md` § Configuration):

```bash
PDF2CAL_DATA_DIR=/tmp/p2c \
PDF2CAL_BASE_URL=http://localhost:3001 \
PDF2CAL_DEPARTMENT_SLUG=anesthesia-chuv \
bun run start
```

- [ ] Server prints `pdf2calendar listening on :3001 (data=/tmp/p2c, base=…, dept=anesthesia-chuv)`
- [ ] `curl -s http://localhost:3001/healthz` returns `{"ok":true}`
- [ ] `PDF2CAL_DEPARTMENT_SLUG` matches the `VITE_DEPARTMENT_SLUG` used in
      Phase 1 — drift breaks every `person_hash` and every upload returns
      `400 hash_mismatch`.

Leave the server running for the rest of the runbook. Stop with Ctrl-C.

---

## Phase 1 — Dev server boots and the drop zone is what you expect

- [ ] `VITE_DEPARTMENT_SLUG=anesthesia-chuv bun run dev`
- [ ] Open the printed URL in a desktop browser
- [ ] You see one dashed-border drop target, centered, biased toward the
      optical center
- [ ] Sub-label below reads `Codes for: anesthesia-chuv`
- [ ] No header, footer, or nav chrome on the page
- [ ] Tab once — focus ring appears on the drop zone, exactly one focus stop

If the build refuses to start without `VITE_DEPARTMENT_SLUG`, the error
message names the variable. (Try `bun run build` with no env to confirm.)

---

## Phase 2 — Happy-path drop with the primary fixture

- [ ] Drag-drop `example_data/5_Mars2026_26.03_30.04.2026.pdf` onto the page
- [ ] During parse / render: spinner appears; `"Reading the PDF…"` shows up
      ~800 ms in, then `"Preparing row previews… (N / total)"` counts up
- [ ] Result page lists ~45 people grouped by role
- [ ] Role captions appear in PDF order
- [ ] `Klug, J` appears under `ma`

If the parse takes > 2 s, log it — performance budget regression.

---

## Phase 3 — Preview row (the trust anchor)

- [ ] Click `[Preview row]` on your own row
- [ ] A lightbox opens showing the PDF's header strip stacked above your row
- [ ] The image is readable; the row really does belong to you
- [ ] Click outside the image — lightbox closes
- [ ] Open again, press `Esc` — closes
- [ ] Open again, click `[×]` — closes
- [ ] Focus returns to the `[Preview row]` button each time
- [ ] Open/close 10× in a row — no memory bloat in DevTools' Memory panel

The PNG should be the trust anchor. If a colleague would not recognize it as
their row, the renderer is wrong.

---

## Phase 4 — Copy URL feedback

- [ ] Click `[Copy URL]` on your row
- [ ] Label swaps to `Copied!` immediately
- [ ] Paste into a scratch field — confirm the `webcal://` URL is on the
      clipboard verbatim
- [ ] Label reverts to `Copy URL` ~1.5 s later
- [ ] Click again twice fast — each click re-arms the 1500 ms timer; no flicker

---

## Phase 5 — Open in Google Calendar (requires backend + real webcal host)

- [ ] Click `[Open in Google Calendar]` on your own row
- [ ] Google's "Subscribe by URL" prompt shows the right URL
- [ ] Confirm; the calendar appears in your sidebar with the right name
- [ ] Wait for Google's first poll (can be < 1 min)
- [ ] Spot-check 3 shifts against the PDF — date, time, code title

If the deep link is broken (`?cid=` issue), the fallback copy below the
button covers the user. Verify the fallback text is visible on hover (desktop)
or always (mobile).

---

## Phase 6 — Unknown codes banner

- [ ] Drop a PDF known to contain a code outside the V1 dictionary
- [ ] A yellow banner with `Unrecognized codes` heading appears above the
      result list
- [ ] The codes are listed inline, comma-separated, in monospace
- [ ] Click `×` — banner disappears
- [ ] Re-upload the same PDF — banner reappears (no localStorage in V1)

---

## Phase 7 — Two-month PDF

- [ ] Drop `example_data/5_Mars2026_26.03_30.04.2026.pdf` (already covers
      March 23 → April 30)
- [ ] Result list still shows people grouped by role
- [ ] In Google Calendar (if subscribed), shifts span both months without gaps

---

## Phase 8 — Failure modes (each must look right)

Drop each of the following and confirm the user-visible copy:

- [ ] A non-PDF file (e.g. `README.md`) → inline red error
      `Please drop a PDF file.` under the drop zone; drop zone still visible
- [ ] A 20 MB PDF → inline red error `PDF too large (max 5 MB).`
- [ ] (Synthesize) lower `MAX_PAYLOAD_BYTES` in `web/api.ts` to e.g. 1024,
      drop a normal PDF → full-screen error
      `Your PDF plus the row previews total more than 10 MB…`. Revert the
      change.
- [ ] Kill the backend (or set `VITE_API_BASE_URL=http://127.0.0.1:1`) and
      drop a PDF → full-screen `Couldn't reach the server.` with
      `[Try again]` button. Click — returns to the drop zone with focus on
      the file input.

Each error path returns to `idle` on `[Try again]`. No stale state in the
DOM, no lingering object-URLs.

---

## Phase 9 — Mobile / narrow viewport

- [ ] Narrow DevTools to ≤ 640 px (or open on a real phone)
- [ ] Drop-zone main copy reads `Choose your shift PDF`
- [ ] Result rows reflow to two lines per row
  - Line 1: name + `[Preview row]`
  - Line 2: `[Copy URL]` + `Open in Google Calendar`
- [ ] Fallback copy is always visible (not hidden behind hover)
- [ ] Lightbox fills the screen; close button stays pinned to the top-right
- [ ] Pinch-zoom works inside the lightbox

---

## Phase 10 — Keyboard-only pass

- [ ] Reload the dev server, drop the primary fixture
- [ ] From the result page, Tab through every interactive element
- [ ] Visual order matches Tab order:
      banner dismiss (if present) → row 1 Preview → row 1 Copy →
      row 1 Google → row 2 … → Re-upload
- [ ] Focus ring visible on every focusable element
- [ ] Enter activates buttons; Space too
- [ ] Open a lightbox via Enter on `[Preview row]`; Esc closes it; focus
      returns to that same `[Preview row]` button

---

## Record results

Append to `docs/test-results/manual-upload-test-{YYYY-MM-DD}.md`:

```markdown
# Manual upload test — {YYYY-MM-DD}

- Tester: @klug
- Build: {git sha or vite version}
- Department slug: anesthesia-chuv
- API base: {URL or "none (frontend-only run)"}

## Phase results
- Phase 1 boot: PASS / FAIL — notes
- Phase 2 happy path: PASS / FAIL — notes
- Phase 3 preview: PASS / FAIL — notes
- Phase 4 copy: PASS / FAIL — notes
- Phase 5 Google subscribe: PASS / FAIL / SKIPPED (no backend) — notes
- Phase 6 unknown codes: PASS / FAIL — notes
- Phase 7 two-month: PASS / FAIL — notes
- Phase 8 errors: PASS / FAIL — notes
- Phase 9 mobile: PASS / FAIL — notes
- Phase 10 keyboard: PASS / FAIL — notes

## Decision
{One of:
  - All pass → ship-ready.
  - Phase 5 failed → escalate to design discussion; subscribe-by-URL broken.
  - Other phases failed → file regressions, list which.
}
```

Commit the result file so future-you knows what was tested and when.

---

## Common pitfalls

- **`bun run build` succeeds with an empty slug.** The `vite.config.ts`
  plugin only fires under `apply: "build"`. If you skipped it (or ran
  `vite build` from a parent shell that hadn't unset the env), the build
  bakes in an empty string. The dev server is a separate path and also
  validates at module load.
- **Lightbox closes on every Tab.** The focus trap in `web/main.ts`
  pre-emptively `preventDefault()`s `Tab` to keep focus on the close
  button. That is intentional — the dialog has exactly one focusable
  element. Don't add more.
- **`Open in Google Calendar` opens a generic Google page.** The deep link
  has broken historically. Show the user the fallback copy under the
  button — it's the spec-required answer.
