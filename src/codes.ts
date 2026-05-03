// V1 codes dictionary for the parser. The parser uses isKnownCode() only
// to populate unknown_codes — it does NOT interpret codes (timed vs all-day,
// shift hours, etc.). That logic lives in the iCal mapper, which will read
// docs/Codes.md and replace this file's responsibility for lookup.
//
// Spec ref: docs/parser-spec.md §"Code dictionary reference" (line 264)
// and Q4 (line 381) — `°` and `*` prefixes are TENTATIVE flags; the base
// code is what gets looked up.

const range = (prefix: string, lo: number, hi: number): string[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => `${prefix}${lo + i}`);

export const V1_CODES = new Set<string>([
  "N13", "Nw13", "N46", "Nw46",
  ...range("L", 1, 6), ...range("Lw", 1, 6),
  ...range("C", 1, 6), ...range("Cw", 1, 6),
  "T", "T2", "X", "V", "CP", "CHV", "SIM",
  "FI", "FE", "MAL", "CAR",
  "°C2", // explicitly listed in spec; exists alongside the prefix-strip rule
]);

const TENTATIVE_PREFIX = /^[°*]/;

export function isKnownCode(raw: string): boolean {
  if (V1_CODES.has(raw)) return true;
  // Strip a single leading °/* prefix and re-check (per spec Q4).
  const stripped = raw.replace(TENTATIVE_PREFIX, "");
  return stripped !== raw && V1_CODES.has(stripped);
}
