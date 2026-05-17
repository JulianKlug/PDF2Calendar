# Manual upload test — 2026-05-17

- Tester: @klug
- Runbook: `docs/manual-upload-test.md`
- Target: `https://pdf2calendar.julianklug.com` (prod, eddy, systemd + nginx)
- Build: `main` at the time of test (includes parser fix `ba548d9`, `.mjs`
  MIME fix `2d0b0c2`, deploy runbook `f0f57a6` / `a36c8db`)
- Department slug: `sia-chuv` (matches `VITE_DEPARTMENT_SLUG` baked into
  the SPA at build time and `PDF2CAL_DEPARTMENT_SLUG` on the server)

## Result

**PASS.** End-to-end pipeline confirmed against production:
parse → render rows → POST `/api/upload` → result list → preview row →
copy `webcal://` URL → subscribe in Google Calendar → events render
with correct DTSTART/DTEND/SUMMARY for the subscribed person.

This closes the remaining V1 gating item flagged in
`server-integration-test-2026-05-16.md` § Decision ("Manual subscribe
leg … against a real `https://` deployment").

## Decision

**V1 user-facing rollout: complete.** The system is live and verified
end-to-end. Subsequent work is V2 scope (admin listing endpoint, auth on
admin paths, departed-colleagues cleanup, CI/CD, per-deployment
VTIMEZONE) — see `docs/server-spec.md` § Out of scope.
