# pdf2calendar

A web-based tool that converts a PDF shift/calendar file into per-person calendar
events that can be downloaded as `.ics` or synced to Google Calendar. Open source,
internal tool.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke context-save
- Code quality, health check → invoke health

## Deploy Configuration (configured by /setup-deploy)

- Platform: systemd on host `eddy` (Ubuntu, nginx 1.26, no Docker)
- Production URL: https://pdf2calendar.julianklug.com
- Deploy workflow: manual `git pull` + `systemctl restart` on eddy
- Deploy status command: `systemctl status pdf2calendar`
- Merge method: squash
- Project type: web app (Bun backend + static SPA)
- Post-deploy health check: `https://pdf2calendar.julianklug.com/healthz`

Full runbook in **README.md § Deploy**. Eddy-specific values to substitute when copying templates:

- `PDF2CAL_BASE_URL=https://pdf2calendar.julianklug.com`
- `PDF2CAL_DEPARTMENT_SLUG=sia-chuv` (must match the `VITE_DEPARTMENT_SLUG` the SPA was built with)
- `PDF2CAL_ADMIN_PASSWORD=<set-at-deploy-time>` (V2; required at boot, empty string counts as unset; rotated by editing the systemd `Environment=` line and restarting the unit)
- nginx `server_name pdf2calendar.julianklug.com www.pdf2calendar.julianklug.com;`
- repo URL: `https://github.com/JulianKlug/PDF2Calendar.git`
- Other eddy services occupy ports 2080–2222; port 3001 is free for Bun.

Recommended hardening to append under `[Service]` in `pdf2calendar.service`:
```
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pdf2calendar
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
```

### Custom deploy hooks
- Pre-merge: `bun test` (CI not yet wired)
- Deploy trigger: manual `git pull && systemctl restart pdf2calendar` on eddy
- Deploy status: `systemctl status pdf2calendar`
- Health check: `https://pdf2calendar.julianklug.com/healthz`
