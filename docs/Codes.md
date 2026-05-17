# Codes

Source of truth for `src/codes.ts`. When you edit this file, update
`src/codes.ts` to match.

## Family — short day shift (`C` / `Cw`)

- Weekday (`C1`–`C6`): 07:15 – 17:30 (`Horaire court`)
- Weekend / public holiday (`Cw1`–`Cw6`): 08:00 – 17:30
- Single-digit suffix is the unit number (1–6).
- Two-digit suffix is a unit range (`X` to `Y`): `C34` covers units 3–4;
  `Cw46` covers units 4–6; `Cw56` covers units 5–6. Hours are unchanged.

## Family — long day shift (`L` / `Lw`)

- Weekday (`L1`–`L6`): 07:15 – 20:30 (`Horaire long`)
- Weekend / public holiday (`Lw1`–`Lw6`): 08:00 – 20:30
- Single-digit suffix is the unit number (1–6).
- Two-digit suffix is a unit range (`X` to `Y`): `L34` covers units 3–4;
  `Lw12` covers 1–2, `Lw13` covers 1–3, `Lw46` covers 4–6, `Lw56` covers
  5–6. Hours are unchanged.

## Family — night shift (`N` / `Nw`)

- Weekday (`N13`, `N46`): 20:00 – 08:15 next day
- Weekend / public holiday (`Nw13`, `Nw46`): 20:00 – 08:30 next day
- Suffix is the unit range. `13` = units 1–3; `46` = units 4–6.

## Other timed shifts

- `T` (also written as T1 in conversation): 09:00 – 19:00
- `T2`: 07:15 – 17:30
- `T5`: 07:30 – 17:30
- `LT` — Long T shift: 09:00 – 21:00
- `P` — Piquet (on-call): 08:00 today → 08:00 next day (24 h)
- `E` — Journée échocardiographie: 09:00 – 17:30
- `DTC` — Journée de doppler transcrânien: 09:00 – 17:30
- `SIM` — Simulation: 07:30 – 17:30

## All-day events

- `V` — Vacation
- `V1` — Vacation (variant; same as `V`)
- `V2` — Vacation (variant; same as `V`)
- `SC` — Soins Continus DC
- `FI` — Formation interne
- `FE` — Formation externe
- `CHV` — TODO: clarify full meaning
- `CAR` — TODO: clarify full meaning

## Skip codes (no calendar event)

These mean "no shift visible on the calendar". The day produces no event.

- `X` — Off
- `MAL` — Maladie (sick)
- `CP` — Congé payé (paid leave)

## Tentative-shift prefixes

- `°`, `*`, and `#` mark a shift as "to be confirmed". The base code is
  looked up after stripping the prefix; the resulting calendar event uses
  `STATUS:TENTATIVE`. Example: `°C2`, `*C2`, and `#C2` are all tentative
  `C2` shifts, **not** separate codes.
