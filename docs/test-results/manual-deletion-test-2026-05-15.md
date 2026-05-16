# Manual deletion test — 2026-05-15

- Tester: @klug
- Target shift removed: T1 shift on 2026-04-13 (09:00–19:00 Europe/Zurich) — isolated single-code day for `Klug, J`
- v1 event count: 23
- v2 event count: 22
- v1 published at: 2026-05-15T20:52:42Z (file Last-Modified on nginx)
- v2 published at: 2026-05-15T21:41:05Z (T0)
- URL: https://julianklug.com/test-deletion/klug.ics
- Removed UID: `3c8f0e00ee509799-20260413-0@pdf2calendar`
- Person hash: `3c8f0e00ee509799`
- PDF: `example_data/5_Mars2026_26.03_30.04.2026.pdf`

## Google Calendar
- Subscribed at: 2026-05-15T~21:38Z
- Re-poll method: wait (natural poll cycle, no unsubscribe/resubscribe)
- Time to observe: ≤8h 39m (observed DELETED at 2026-05-16T06:20:16Z; Google's actual poll moment unknown, somewhere between T0 and observation)
- Result: **DELETED**
- Notes: No tombstone (`STATUS:CANCELLED`) was emitted in v2 — the event simply disappeared from the file. Google removed it on its next natural poll. This validates the "subscribe by URL, plain diff" path for Google.

## Apple Calendar
- Subscribed at: 2026-05-15T~21:38Z (iPhone)
- Refresh interval: 5 minutes
- Time to observe: ~2m44s after T0 (force-refreshed via pull-to-refresh)
- Result: **DELETED**
- Notes: Clean deletion within one refresh cycle.

## Decision

**Both deleted → architecture as written. Proceed to server build.**

No `STATUS:CANCELLED` tombstone fallback is required. The per-person manifest does not need to track tombstone UIDs across publish cycles. The iCal generator can keep its current behavior: rebuild the .ics from scratch on each publish, with shifts present iff they're present in the latest PDF.

Caveats to revisit if Google's behavior changes:
- This test used a single-code, isolated date. Multi-code days or boundary days may behave differently — re-run the test if we see deletion bugs in production.
- Google's poll cadence is unspecified; observed upper bound here was ~9h. Users may see stale events for up to a day after a re-publish. Acceptable for V1.
- The test exercised natural in-place poll behavior, not fetch-on-subscribe. They are usually the same; if a user reports a stale event that persists after re-publish, ask them to unsubscribe/resubscribe before treating it as a generator bug.
