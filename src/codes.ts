// V1 codes dictionary. Source of truth for shift definitions: docs/Codes.md.
// When you edit Codes.md, update this file to match.
//
// Each known code maps to one of:
//   - timed:  produces a calendar event with a specific start/end time.
//             If `end <= start`, the shift crosses midnight (the iCal
//             generator advances DTEND to the next day).
//   - allday: produces an all-day calendar event.
//   - skip:   produces no event. Used for "no shift" markers (X), sick
//             days (MAL), and paid leave (CP) — these days don't get a
//             calendar entry at all.
//
// Unknown codes (not in this table) are still parsed and surfaced in
// ParseResult.unknown_codes; the iCal generator emits them as all-day
// "Unknown: X" placeholders so they show up in the calendar with a
// "fix me" signal.
//
// The °/* prefix marks a shift as "to be confirmed". The parser preserves
// the raw string; the iCal generator strips the prefix to look up the
// base code, then marks the resulting event STATUS:TENTATIVE.

export type Code =
  | { kind: "timed"; title: string; start: string; end: string }
  | { kind: "allday"; title: string }
  | { kind: "skip" };

const dayShift = (unit: string, weekend: boolean): Code => ({
  kind: "timed",
  title: `Day shift, unit ${unit}${weekend ? " (weekend)" : ""}`,
  start: weekend ? "08:00" : "07:15",
  end: "17:30",
});

const longShift = (unit: string, weekend: boolean): Code => ({
  kind: "timed",
  title: `Long shift, unit ${unit}${weekend ? " (weekend)" : ""}`,
  start: weekend ? "08:00" : "07:15",
  end: "20:30",
});

const nightShift = (units: string, weekend: boolean): Code => ({
  kind: "timed",
  title: `Night shift, units ${units}${weekend ? " (weekend)" : ""}`,
  start: "20:00",
  end: weekend ? "08:30" : "08:15",
});

export const codes: Record<string, Code> = {
  // C — short day shift
  C1: dayShift("1", false),  C2: dayShift("2", false),  C3: dayShift("3", false),
  C4: dayShift("4", false),  C5: dayShift("5", false),  C6: dayShift("6", false),
  Cw1: dayShift("1", true),  Cw2: dayShift("2", true),  Cw3: dayShift("3", true),
  Cw4: dayShift("4", true),  Cw5: dayShift("5", true),  Cw6: dayShift("6", true),

  // L — long shift
  L1: longShift("1", false), L2: longShift("2", false), L3: longShift("3", false),
  L4: longShift("4", false), L5: longShift("5", false), L6: longShift("6", false),
  Lw1: longShift("1", true), Lw2: longShift("2", true), Lw3: longShift("3", true),
  Lw4: longShift("4", true), Lw5: longShift("5", true), Lw6: longShift("6", true),

  // N — night shift (crosses midnight)
  N13: nightShift("1-3", false),
  N46: nightShift("4-6", false),
  Nw13: nightShift("1-3", true),
  Nw46: nightShift("4-6", true),

  // T — duty / on-call. T is shorthand for T1; T2 has different hours.
  T:  { kind: "timed", title: "T1 shift", start: "09:00", end: "19:00" },
  T2: { kind: "timed", title: "T2 shift", start: "07:15", end: "17:30" },

  // P — Piquet (24-hour on-call, crosses midnight)
  P: { kind: "timed", title: "Piquet (on-call)", start: "08:00", end: "08:00" },

  // E — Echocardiography day
  E: { kind: "timed", title: "Echocardiography", start: "09:00", end: "17:30" },

  // DTC — Transcranial doppler day
  DTC: { kind: "timed", title: "Transcranial doppler", start: "09:00", end: "17:30" },

  // SIM — Simulation training
  SIM: { kind: "timed", title: "Simulation", start: "07:30", end: "17:30" },

  // All-day events
  V: { kind: "allday", title: "Vacation" },
  SC: { kind: "allday", title: "Soins Continus DC" },
  FI: { kind: "allday", title: "Formation interne" },
  FE: { kind: "allday", title: "Formation externe" },
  CHV: { kind: "allday", title: "CHV" },
  CAR: { kind: "allday", title: "CAR" },

  // Skip — no event emitted
  X: { kind: "skip" },
  MAL: { kind: "skip" },
  CP: { kind: "skip" },
};

export const V1_CODES = new Set(Object.keys(codes));

const TENTATIVE_PREFIX = /^[°*]/;

export function isKnownCode(raw: string): boolean {
  if (V1_CODES.has(raw)) return true;
  // Strip a single leading °/* tentative-flag prefix and re-check.
  const stripped = raw.replace(TENTATIVE_PREFIX, "");
  return stripped !== raw && V1_CODES.has(stripped);
}
