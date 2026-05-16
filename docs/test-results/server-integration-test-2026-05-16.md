# Server integration test — 2026-05-16

- Tester: @klug
- Spec: `docs/server-spec.md` § Test plan → Integration test
- Build: V1 server on `main`, `src/server.ts` + `mergeIcs()` in `src/ics.ts`
- PDF dropped: `example_data/5_Mars2026_26.03_30.04.2026.pdf` (two-month: 2026-03-23 → 2026-04-30)
- Department slug: `SIA`
- Backend env: `PDF2CAL_DATA_DIR=/tmp/p2c`, `PDF2CAL_BASE_URL=http://localhost:5173`
- Frontend: `bun run dev` with Vite dev proxy `/api → http://localhost:3001` (added in `vite.config.ts` for this run)

## Pipeline result

- Backend log line on first drop: `POST /api/upload 200 NNNms`
- Feeds on disk: **41** (one `.ics` per colleague in the PDF)
- Manifests on disk: 41 — `Klug, J` resolved to person_hash `08d144aa15f7c35b` (SIA-keyed; differs from the anesthesia-chuv test vector `79897ea12fbe8e91` as expected)
- Source PDF persisted under `sources/<pdf_sha256>.pdf`
- Row PNGs populated under `rows/<pdf_sha256>/` (41 files)
- Klug's `.ics`: 23 VEVENTs, valid VCALENDAR with embedded `Europe/Zurich` VTIMEZONE, well-formed UIDs `08d144aa15f7c35b-YYYYMMDD-seq@pdf2calendar`
- `DESCRIPTION` lines correctly carry `View your row: http://localhost:5173/source/<pdf_sha256>/08d144aa15f7c35b.png` (deferred /source serving — works only with nginx in prod)

## Semantic idempotence

Re-dropped the same PDF a second time. `diff before.ics after.ics`:

- `UID`, `DTSTART`, `DTEND`, `SUMMARY` for all 23 events: **byte-identical**
- `DTSTAMP` and the `Uploaded:` line in `DESCRIPTION`: differ (refreshed to the second upload's timestamp)
- Per RFC 5545 §3.8.7.2: `DTSTAMP` is the property-creation time, not an event-modification marker. Calendar clients see same UID + same DTSTART → no user-visible change.

Confirms spec § Step 8: *"Re-running the same upload is semantically idempotent: every write is keyed by `<pdf_sha256>` / `<person_hash>`, and `mergeIcs()` produces the same set of VEVENTs (same UIDs, same DTSTART/DTEND/SUMMARY) for the same input."*

## Unit test suite

`bun test`: **119 pass, 1 skip, 0 fail** across 9 files. Includes:

- 11 new `mergeIcs()` cases in `test/ics.test.ts` (null/empty/disjoint/overlap/boundary/sort/byte-stability/tombstone-preservation/two malformed/unexpected DTSTART)
- 28 server cases in `test/server.test.ts` (happy path, every 400/413/415 class incl. `hash_collision`, multi-month merge, semantic idempotence, empty-days person, orphan sweep, manifest-failure isolation, concurrency, corrupt existing `.ics`, webcal URL construction, unknown-codes, response order, `/healthz`)
- 10 shared `normalize()` cases across `test/normalize-shared.test.ts` and `web/person-hash.test.ts` (one fixture, two import sites — cross-implementation gate per spec § Identifier hashing)

## Decision

**V1 integration test: PASS. Server is implementation-complete.**

Remaining work before user-facing rollout:
- Manual subscribe leg (Phase 5 of `docs/manual-upload-test.md`) — drop the webcal URL into Google + Apple Calendar against a real `https://` deployment and confirm events render.
- Stand up prod deployment per `deploy/nginx.conf.example` + `deploy/pdf2calendar.service`.

## Caveats

- The `View your row:` URL in DESCRIPTION points at `http://localhost:5173/source/...` for this dev run. That path returns 404 in dev (Vite has no `/source/` route and Bun never serves files per spec). It works in prod only when nginx is configured per `deploy/nginx.conf.example`. Not part of the integration test, but worth flagging when the manual subscribe leg runs.
- Vite dev proxy (`server.proxy["/api"]`) was added to `vite.config.ts` to bridge `:5173 → :3001` in dev. Production uses nginx; the proxy is dev-only.
- One-shift environment quirk: setting `PDF2CAL_DEPARTMENT_SLUG` and `PDF2CAL_BASE_URL` etc. on separate lines in bash does *not* export them; use `\`-chained one-liner or `export` per shell. The server's env check catches this loudly (`PDF2CAL_DATA_DIR is required → exit 1`).
