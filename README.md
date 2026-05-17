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
and baked into the bundle. For dev (`bun run dev`), copy `.env.example` to
`.env.local` if you want to skip the `VAR=` prefix. For builds (`bun run
build`), pass it on the command line — `vite.config.ts` reads `process.env`
directly, so `.env*` files don't apply there.

For end-to-end uploads, start the backend in a second terminal — see
Phase 0 of `docs/manual-upload-test.md`. With only the frontend running,
the upload step lands on `Couldn't reach the server`; everything up to
that point (parse, render, preview-row lightbox) works in-browser.

## Scripts

| Command | Notes |
|---|---|
| `bun run dev` | Vite dev server. Requires `VITE_DEPARTMENT_SLUG`. |
| `bun run build` | Production build → `dist/`. Same env requirement. |
| `bun run preview` | Serve the `dist/` build locally. |
| `bun run start` | Run the backend (`src/server.ts`). See `docs/server-spec.md` for required env. |
| `bun test` | Bun test runner: `test/*.test.ts` + `web/*.test.ts`. |
| `bun run probe` | Parser feasibility probe on the example PDFs. |
| `bunx tsc --noEmit` | Type check. |

## Layout

```
src/        # parser, codes table, .ics generator, Bun server — no DOM
web/        # browser frontend (Vite root). Only main.ts touches the DOM.
scripts/    # one-off dev helpers (probe, dump-ics, debug)
test/       # bun:test suite for src/ + server
deploy/     # nginx + systemd templates for V1 deploys
docs/       # specs and runbooks
example_data/ # PDF fixtures (gitignored)
```

## Deploy

Targets a systemd host with nginx out front. nginx serves the SPA, `.ics`
feeds, and row PNGs directly from disk; Bun handles only `/api/upload` and
`/healthz` (see `docs/server-spec.md`). Templates in `deploy/`.

### Required environment

- `PDF2CAL_DATA_DIR` — where feeds, manifests, plans, sources, and rows live.
- `PDF2CAL_BASE_URL` — public URL with no trailing slash; powers webcal:// and `feed_url` / `row_url` in `/api/manifest`.
- `PDF2CAL_DEPARTMENT_SLUG` — must match the SPA's build-time `VITE_DEPARTMENT_SLUG` exactly. Drift breaks every `person_hash`.
- `PDF2CAL_ADMIN_PASSWORD` *(V2)* — shared admin secret gating `/api/upload`. Required at boot; empty string counts as unset and the server exits. Rotate by editing the systemd `Environment=` line and `systemctl daemon-reload && systemctl restart pdf2calendar`. **The password is loaded directly via `Environment=` so anyone with root on the box can read it — that is the accepted V2 trust boundary.**
- `PDF2CAL_MAX_UPLOAD_BYTES` (optional, default 10M) — must match nginx's `client_max_body_size`.

### One-time setup (root, on the host)

```sh
# 1. user + dirs
useradd --system --home /opt/pdf2calendar --shell /usr/sbin/nologin pdf2calendar
install -d -o pdf2calendar -g pdf2calendar /opt/pdf2calendar /var/lib/pdf2calendar
install -d -o www-data    -g www-data    /var/www/pdf2calendar

# 2. bun + repo
curl -fsSL https://bun.sh/install | bash    # then: cp ~/.bun/bin/bun /usr/local/bin/bun
sudo -u pdf2calendar git clone <repo-url> /opt/pdf2calendar

# 3. DNS A-record → host, then TLS
certbot --nginx -d pdf2calendar.example.com

# 4. nginx — set server_name + uncomment ssl_certificate* lines
cp /opt/pdf2calendar/deploy/nginx.conf.example /etc/nginx/sites-available/pdf2calendar
ln -s /etc/nginx/sites-available/pdf2calendar /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 5. systemd — set PDF2CAL_BASE_URL + PDF2CAL_DEPARTMENT_SLUG + PDF2CAL_ADMIN_PASSWORD
cp /opt/pdf2calendar/deploy/pdf2calendar.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pdf2calendar

# 6. first build
cd /opt/pdf2calendar
sudo -u pdf2calendar bash -c 'echo VITE_DEPARTMENT_SLUG=<slug> > .env.production && bun install && bun run build'
rsync -a --delete dist/ /var/www/pdf2calendar/dist/ && chown -R www-data:www-data /var/www/pdf2calendar

curl -sf https://pdf2calendar.example.com/healthz && echo OK
```

`PDF2CAL_DEPARTMENT_SLUG` (server) and `VITE_DEPARTMENT_SLUG` (build) **must
match exactly** — drift breaks every `person_hash`. nginx's
`client_max_body_size`, Bun's `maxRequestBodySize`, and
`PDF2CAL_MAX_UPLOAD_BYTES` must also match (default 10M).

### Pre-V2 → V2 cutover

V2 assumes a fresh `PDF2CAL_DATA_DIR`. V1-shaped manifests on disk
keep serving from nginx (no change to `/feed/`) but are silently
absent from `/api/manifest` until the corresponding plan is
re-uploaded. Before the V2 deploy:

```sh
# Confirm the data dir state. Either it's empty, or you accept that any
# V1 feeds will look "missing" on the landing page until re-upload.
sudo ls /var/lib/pdf2calendar/manifest/ | head
# To start fresh:
sudo systemctl stop pdf2calendar
sudo rm -rf /var/lib/pdf2calendar/{feeds,manifest,sources,rows,plans}
sudo systemctl start pdf2calendar
```

### Update

```sh
cd /opt/pdf2calendar
sudo -u pdf2calendar bash -c 'git pull && bun install --frozen-lockfile && VITE_DEPARTMENT_SLUG=<slug> bun run build'
sudo rsync -a --delete dist/ /var/www/pdf2calendar/dist/
sudo systemctl restart pdf2calendar
systemctl status pdf2calendar --no-pager
curl -fsS https://<host>/healthz
```

`<slug>` must match `PDF2CAL_DEPARTMENT_SLUG` in the systemd unit — drift
breaks every `person_hash` and every upload 400s. The build reads
`process.env` directly, so a `.env.production` file alone won't satisfy it.

### Rolling back a bad PDF

The fastest fix for a wrong upload is to re-upload the right PDF —
the confirm modal explicitly shows the swap (previous filename + month
+ upload time → incoming) so the admin sees what they are replacing.
No CLI rollback step required; the V1 ICS merge invariant (per-date
overwrite from the latest plan) handles the rest.

To roll back the binary itself: `git checkout <prev-sha>` in place of
`git pull`, then rebuild + restart.

## Docs

- `docs/parser-spec.md` — parser contract
- `docs/ics-spec.md` — `.ics` generator contract
- `docs/frontend-spec.md` — browser-side pipeline (this codebase)
- `docs/server-spec.md` — backend server contract
- `docs/manual-deletion-test.md` — load-bearing architecture gate
- `docs/manual-upload-test.md` — frontend smoke test
- `docs/Codes.md` — source of truth for the codes table
