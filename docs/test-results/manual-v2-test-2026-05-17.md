# Manual V2 verification — 2026-05-17

- Tester: @klug (driven by Claude Opus 4.7 in autonomous mode)
- Runbook: `docs/manual-v2-test.md`
- Target: `https://pdf2calendar.julianklug.com` (eddy, systemd + nginx)
- Build: V2 branch at SHA `bb95c62` (hotfix on top of `43a8388`)
- Department slug: `sia-chuv`
- Admin password: documented out-of-band; 20 chars, set via systemd `Environment=`
- Data dir: wiped before run (cutover from V1)

## Phase results

- **Phase 0 data dir state**: WIPED — `sudo rm -rf /var/lib/pdf2calendar/{feeds,manifest,sources,rows,plans}` before deploy.
- **Phase 1 boot guards (1a unset / 1b empty / 1c real)**: PASS — local Bun on :3011. 1a + 1b both exited with `PDF2CAL_ADMIN_PASSWORD is required (empty string counts as unset)` and non-zero exit; 1c logged `pdf2calendar listening on :3011 (data=/tmp/p2c-v2, base=http://localhost:3011, dept=anesthesia-chuv)`; `/healthz` returned `{"ok":true}`.
- **Phase 2 empty-state landing**: PASS — `sia-chuv shift calendars` header, "No plan uploaded yet." + "Upload first plan" CTA, `/api/manifest` returned `schema_version:2, latest_plan:null, plans:[], staff:[]`, response headers `Cache-Control: no-store` + `X-Robots-Tag: noindex, nofollow`. Polish flag: the persistent "Upload new plan" header button is redundant with the empty-state "Upload first plan" CTA — consider hiding the header button in empty state.
- **Phase 3 first upload happy path**: PASS-WITH-CAVEAT — uploaded `5_Mars2026_26.03_30.04.2026.pdf` with the correct password; confirm modal read "...as the first plan." with `(March 2026, April 2026)` (two-month span correctly emitted); success screen showed "Found 41 people in this PDF" + role-grouped feed list. Auto-redirect was suppressed because the PDF also triggered Phase 6 (unknown codes `Cw13, D, FI2, T4`) — we could not exercise the no-banner auto-redirect happy path with the available test corpus. After `[Back to staff list]` the landing showed the populated state correctly. **Required hotfix `bb95c62`** — see Defects below.
- **Phase 4 wrong-password recovery**: PASS — POST `/api/upload` returned 401 with the deliberately wrong password; error screen showed "Wrong admin password. Re-enter the password and try again." + `[Retry password]`; Retry returned to the password modal with an empty input.
- **Phase 5 overwrite confirmation**: PASS — uploaded `1_mai_21.04.2026.pdf` after Phase 3. Confirm modal text exactly: `"You are about to replace 5_Mars2026_26.03_30.04.2026.pdf (March 2026, April 2026, uploaded 2026-05-17 22:26) with 1_mai_21.04.2026.pdf (May 2026). Existing events on overlapping dates will be overwritten."` Cancel preserved disk state (`plans/` still contained only the March SHA) and the "Latest:" caption. Confirm-and-upload swapped the latest to May, manifest now lists 2 plans, 61 staff.
- **Phase 6 unknown-codes auto-redirect suppression**: PASS — yellow "Unrecognized codes" banner listed `Cw13, D, FI2, T4` (March) and `FE2` (May); URL stayed on the success screen after a 6-second wait, no auto-redirect.
- **Phase 7 preview rows lightbox**: PASS — opening preview for Abellan, C (appears in both plans) rendered a `<div class="lightbox-backdrop" role="dialog" aria-modal="true" aria-label="Row previews for Abellan, C">` with two stacked `<figure>` elements; captions `"March 2026 · 5_Mars2026..."` and `"May 2026 · 1_mai..."`, `<img loading="lazy">`, image URLs at `/source/<sha>/<hash>.png` returned 200 with valid PNG bytes (40761B, 38179B). Escape closed it; backdrop click closed it. Optional broken-image fallback not exercised.
- **Phase 8 ICS merge regression (load-bearing)**: PASS — Abellan's `.ics` feed had **35** VEVENTs before re-uploading May, **35** after; diff showed only DTSTAMP + uploaded-timestamp string changes (no new UIDs, no duplicates). V1 per-date overwrite invariant intact.
- **Phase 9 CSRF defense**: PASS — 9a (no header) → HTTP 400 body `{"error":"missing X-PDF2Cal-Admin header","code":"csrf"}`; 9b (with header + `/dev/null` PDF) → HTTP 415 `"pdf part has Content-Type , expected application/pdf"`. CSRF gate passed in 9b; schema validator caught the bogus body. Minor deviation: runbook expected 400 `schema`, server returned 415 `unsupported-media-type`. Intent preserved.
- **Phase 10 rate-limit isolation**: PASS-WITH-CAVEAT — 30× POST `/api/upload` with `X-PDF2Cal-Admin: 1` returned 11× 400 (within burst) then 19× **503**, not 429. nginx's `limit_req` default is 503; the runbook expected 429. Functional rate-limit works; recommend adding `limit_req_status 429;` to `deploy/nginx.conf.example` (and prod nginx) for the IETF-standard code. 100× GET `/api/manifest` all returned 200, fully isolated.
- **Phase 11 search-engine hints**: PASS — `curl -I /api/manifest` returned `X-Robots-Tag: noindex, nofollow`; `curl /` contained `<meta name="robots" content="noindex,nofollow" />`.
- **Phase 12 manifest cache invalidation**: PASS — `latest_plan.pdf_sha256` changed from `7bf44c2a…` (March) to `c730a195…` (May) immediately after the May upload; in-process cache was invalidated correctly.
- **Phase 13 401 logging (journald)**: PASS — `2026-05-17T20:37:05.409Z WARN admin_password_mismatch from=192.168.191.162`. Real client IP forwarded; `X-Forwarded-For` on `/api/upload` is wired in nginx.
- **Phase 14 V1-manifest tolerance**: PASS — planted `0000000000000001.json` with V1 shape; after restart, `/api/manifest.staff[]` did not contain that hash and the staff count stayed at 61. No warning emitted. Cleanup restored prior state; `/healthz` ok.
- **Phase 15 bun test**: PASS — `186 pass / 1 skip / 0 fail` on hotfix SHA `bb95c62`.

## Defects discovered

1. **(blocking, fixed)** `web/main.ts:216` invoked `renderStaffRoleGroup(g)`, but the function is actually named `renderStaffListGroup` (lines 486, 649). On any populated manifest the ReferenceError rejected the fetch promise and `mountLandingError` ran, so the landing always showed "Couldn't load the staff list. Retry" instead of the staff list — for any non-empty deployment. The empty-state codepath happened to avoid the call, which is why `bun test` and Phase 2 missed it. Fixed in commit `bb95c62`. Test gap to fix separately: there is no `bun test` coverage of `mountLandingBody` with a non-empty `staff[]`.
2. **(polish, nginx template)** Rate-limit returns HTTP 503 instead of 429. Add `limit_req_status 429;` near the `limit_req_zone` line in `deploy/nginx.conf.example` and in `/etc/nginx/sites-available/pdf2calendar` on eddy.
3. **(polish, web/main.ts)** Persistent "Upload new plan" button in the landing header renders even in empty state, alongside the "Upload first plan" CTA. Consider hiding the header button when `data.staff.length === 0`.
4. **(polish, server)** `/api/upload` returns HTTP 415 on bad PDF Content-Type without a `code` field. Runbook expected `code:"schema"`. Either add `code` to the 415 body, or document 415 as the expected status for media-type mismatches.
5. **(test/dev, vite.config.ts)** Vite proxy key `"/api"` matches `/api.ts` and forwards it to the backend, which 404s. Hit when running `bun run dev` from a clone that also has a backend on port 3001. Use a more specific match (e.g. regex `^/api/`) to avoid the collision. Only affects dev mode; production nginx routes are unaffected.

## Decision

**V2 user-facing rollout: complete pending defects 2–5 (all polish-grade).** The blocking defect (#1) is already fixed on `v2` at `bb95c62` and deployed live to `https://pdf2calendar.julianklug.com`. Phase 8 (the load-bearing V1 merge regression check) passed, so V2 is safe to keep live.

Recommended follow-ups before declaring V2 "done":

- Add a `bun test` case for `mountLandingBody` with a non-empty `staff[]` to catch the class of bug behind defect #1.
- Apply defects #2, #3, #5 in a small polish PR; #4 is a doc-or-code choice.
- Re-run Phases 3 + 6 with a PDF that has **no** unknown codes to exercise the auto-redirect happy path that this run could not.
