# pdf2calendar

Drop a hospital shift PDF, get per-person `webcal://` URLs you can subscribe to
in Google or Apple Calendar.

Static SPA + a server-side `/api/upload` handler that writes `.ics` files. The
frontend handles parse → render row PNGs → hash → POST. Everything heavy
runs in the browser; the backend just persists and serves the feeds.

## Quick start

Prereqs: [Bun](https://bun.com) ≥ 1.1.

```sh
bun install
VITE_DEPARTMENT_SLUG=anesthesia-chuv bun run dev
```

Open the printed URL (defaults to `http://localhost:5173/`).

`VITE_DEPARTMENT_SLUG` is **required** — it's hashed into every `person_hash`
and baked into the bundle. The build fails loud if it's unset; copy
`.env.example` to `.env.local` if you want to skip the `VAR=` prefix.

The backend isn't built yet, so the upload step lands on
`Couldn't reach the server`. Everything up to that point (parse, render,
preview-row lightbox) works in-browser. See `docs/manual-upload-test.md`.

## Scripts

| Command | Notes |
|---|---|
| `bun run dev` | Vite dev server. Requires `VITE_DEPARTMENT_SLUG`. |
| `bun run build` | Production build → `dist/`. Same env requirement. |
| `bun run preview` | Serve the `dist/` build locally. |
| `bun test` | Bun test runner: `test/*.test.ts` + `web/*.test.ts`. |
| `bun run probe` | Parser feasibility probe on the example PDFs. |
| `bunx tsc --noEmit` | Type check. |

## Layout

```
src/        # parser, codes table, .ics generator — Bun/Node, no DOM
web/        # browser frontend (Vite root). Only main.ts touches the DOM.
scripts/    # one-off dev helpers (probe, dump-ics, debug)
test/       # bun:test suite for src/
docs/       # specs and runbooks
example_data/ # PDF fixtures (gitignored)
```

## Docs

- `docs/parser-spec.md` — parser contract
- `docs/ics-spec.md` — `.ics` generator contract
- `docs/frontend-spec.md` — browser-side pipeline (this codebase)
- `docs/server-spec.md` — backend server contract
- `docs/manual-deletion-test.md` — load-bearing architecture gate
- `docs/manual-upload-test.md` — frontend smoke test
- `docs/Codes.md` — source of truth for the codes table
