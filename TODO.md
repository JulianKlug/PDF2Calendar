# TODO — V2 / deferred work

V1 shipped 2026-05-17. V2 followed 2026-05-17 (admin-gated uploads,
landing-page staff index, overwrite confirmation — see
`docs/v2-spec.md`). Everything below is *deferred* — nothing here
blocks production use. Brackets after each item point at the source
spec where the item is described in fuller form.

## Server / API

- [x] `GET /api/manifest` admin listing endpoint *(shipped in V2 — now public,
      gated only on the upload write path; see `docs/v2-spec.md`)*
- [ ] `GET /source/<pdf_sha256>.pdf` full-PDF view, behind auth
      (`docs/server-spec.md`:834)
- [ ] Cleanup sweep: drop `sources/<sha>.pdf` + `rows/<sha>/` once no
      `.ics` references the sha (`docs/server-spec.md`:857–860)
- [ ] Cleanup sweep: departed-colleagues / orphan `.ics` removal
      (`docs/server-spec.md`:836, 856)
- [ ] Decide whether the admin listing UI is served by Bun
      (`/api/manifest`) or by nginx `autoindex` on `/manifest/`
      (`docs/server-spec.md`:861–863)
- [ ] Cookie- or token-based rate limit if hospital-NAT collisions
      surface in practice (`docs/server-spec.md`:865–868)
- [ ] Prune `entries[]` past ~50 items per person from
      `manifest/<hash>.json` if/when long-running departments hit it
      (V2 review — `docs/v2-spec.md` § Performance)

## Frontend

- [ ] Highlight-your-own-row — pick mechanism: `?me=<person_hash>` query
      param vs. first-visit prompt (`docs/frontend-spec.md`:1002)
- [ ] Move pdfjs to a Web Worker if parse times bite
      (`docs/frontend-spec.md`:290, 886)
- [ ] In-browser codes editor / per-person code overrides
      (`docs/parser-spec.md`:282; `docs/server-spec.md`:835)
- [ ] Sort order within a role group — PDF order (current) vs. alphabetical
      (`docs/frontend-spec.md`:1017)
- [ ] Second re-upload button (sticky / near unknown-codes banner)
      (`docs/frontend-spec.md`:1013)
- [ ] Caption baked into row PNG (name + date range)
      (`docs/frontend-spec.md`:1008)
- [ ] Lightbox: fit-to-viewport + tap-to-zoom interaction
      (`docs/frontend-spec.md`:1021)
- [ ] Confirm-time diff at upload — `POST /api/diff` returning
      `{people_changed, shifts_added, shifts_removed, shifts_modified}`,
      displayed in the V2 confirm modal so the admin sees the real
      magnitude of the change before clicking Confirm
      (V2 review — `docs/v2-spec.md` § Explicitly out of scope)

## iCal generator

- [ ] Per-deployment VTIMEZONE override — parameterize via `tzid` input
      + lookup table for Europe/Zurich, Berlin, Paris, …
      (`docs/ics-spec.md`:353–356; `docs/server-spec.md`:843)
- [ ] PRODID version suffix if/when we sign + verify `.ics`
      (`docs/ics-spec.md`:347–348)

## Codes dictionary

- [ ] Clarify the full meaning of `CHV` and `CAR`
      (`docs/Codes.md`:40–41 — currently `TODO: clarify full meaning`)

## Deploy

- [ ] CI/CD pipeline (`docs/server-spec.md`:827)
- [ ] GitHub-Action SSH deploy (`docs/server-spec.md`:842)
- [ ] Multi-tenant deployments / department picker on the upload page
      (`docs/server-spec.md`:837)

## Identity / auth

- [x] Admin password gate on `/api/upload` *(shipped in V2 —
      env-hardcoded `PDF2CAL_ADMIN_PASSWORD`; see `docs/v2-spec.md`)*
- [ ] Per-user authentication, OAuth, email — post-V2
      (`docs/server-spec.md`:838); supersedes the admin password gate
      (when this lands, delete `src/admin-auth.ts` and `web/admin-auth.ts`)

## Explicitly NOT planned

For the record — these are listed as out-of-scope in the V1 specs and
should not creep back in without an explicit decision:

- In-process rate limiting (lives in nginx) — `docs/server-spec.md`:839
- IP logging, analytics, telemetry, error reporting — `docs/server-spec.md`:840
- `STATUS:CANCELLED` tombstone tracking — `docs/server-spec.md`:841
  (manual deletion test 2026-05-15 confirmed plain re-publish is enough)
