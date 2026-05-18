// Pure helper: returns true iff the two month-coverage arrays share at least
// one calendar day. Used by the confirm-overwrite modal to decide whether to
// warn about overwriting existing events or to phrase the upload as additive.
//
// Day-set keys are `${year}-${month}-${day}`. The hyphen separators make
// (2026, 1, 11) and (2026, 11, 1) produce distinct strings ("2026-1-11" vs
// "2026-11-1"), so no zero-padding is needed.

export function plansShareAnyDate(
  a: Array<{ year: number; month: number; days_covered: number[] }>,
  b: Array<{ year: number; month: number; days_covered: number[] }>,
): boolean {
  const aSet = new Set<string>();
  for (const m of a) {
    for (const d of m.days_covered) aSet.add(`${m.year}-${m.month}-${d}`);
  }
  for (const m of b) {
    for (const d of m.days_covered) {
      if (aSet.has(`${m.year}-${m.month}-${d}`)) return true;
    }
  }
  return false;
}

// Returns the subset of `plans` whose date coverage overlaps `incoming`, in
// the same order as the input. The confirm-overwrite modal feeds the server's
// `manifestSnapshot.plans[]` here (already sorted by uploaded_at desc), so
// the first hit is the most-recently-uploaded overlapping plan.
//
// Why this exists: checking only `latest_plan` misses overlaps with older
// non-latest plans, and mergeIcs (src/ics.ts) drops events in the incoming
// date range regardless of which prior plan wrote them. Re-uploading the May
// plan after an October plan was the latest used to falsely show "covers
// different dates and will be kept".
export function findOverlappingPlans<
  T extends {
    months: Array<{ year: number; month: number; days_covered: number[] }>;
  },
>(
  incoming: Array<{ year: number; month: number; days_covered: number[] }>,
  plans: readonly T[],
): T[] {
  return plans.filter((p) => plansShareAnyDate(incoming, p.months));
}
