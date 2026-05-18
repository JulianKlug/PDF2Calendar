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
