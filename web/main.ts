// DOM orchestrator — the only file in `web/` that touches `document` /
// browser event listeners. Every other module takes inputs by parameter and
// returns plain values. See docs/v2-spec.md § Frontend changes.

import {
  ParseError,
  type ManifestResponse,
  type ManifestStaffEntry,
  type ParseErrorCode,
  type ParseResult,
  type ParseWarning,
} from "../src/types.ts";
import { parse } from "../src/parser.ts";
// pdfjs worker — set workerSrc once before any getDocument() call so the
// dynamic import inside parse() (and renderRowImages) finds it. The frontend
// spec § Step 0 claims the legacy build runs worker-less in browser; in
// practice pdfjs v4 still spawns a real worker in browsers, so we wire it up
// here. Vite's ?url import emits the worker as a static asset.
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
import {
  buildMultipart,
  MAX_PAYLOAD_BYTES,
  UploadError,
  uploadToServer,
  type UploadPayload,
  type UploadResponse,
  type UploadResponseFeed,
} from "./api.ts";
import {
  INVALID_ADMIN_PASSWORD_COPY,
  renderPasswordModal,
} from "./admin-auth.ts";
import { pdfHash } from "./pdf-hash.ts";
import { personHash } from "./person-hash.ts";
import { plansShareAnyDate } from "./plan-overlap.ts";
import { renderRowImages, type RowJob } from "./row-image.ts";
import {
  canDrop,
  initialState,
  toAuthPrompt,
  toConfirmOverwrite,
  toError,
  toHashing,
  toIdleUpload,
  toLanding,
  toParsing,
  toRenderingRows,
  toSuccess,
  toUploading,
  validateFile,
  type ErrorCause,
  type State,
} from "./state.ts";

// ─── Boot ────────────────────────────────────────────────────────────────

function readDepartment(): string {
  const slug = import.meta.env.VITE_DEPARTMENT_SLUG;
  if (!slug || slug.trim() === "") {
    throw new Error(
      "VITE_DEPARTMENT_SLUG is required. Set it at build time " +
        "(e.g. VITE_DEPARTMENT_SLUG=anesthesia-chuv bun run dev).",
    );
  }
  return slug;
}
const DEPARTMENT: string = readDepartment();
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

const root = document.getElementById("root")!;
let state: State = initialState;
let inlineError: string | null = null;
let labelTimer: ReturnType<typeof setTimeout> | null = null;
let successRedirectTimer: ReturnType<typeof setTimeout> | null = null;
let dragCounter = 0;

// Manifest snapshot captured by the most recent successful /api/manifest
// fetch. Read by renderConfirmOverwrite to compose the "replacing X with Y"
// modal text (spec § Frontend / Upload flow step 4).
// Staleness is acceptable: spec L386–391 calls out that last-writer-wins
// inside the server mutex is fine at hospital scale.
let manifestSnapshot: ManifestResponse | null = null;
let manifestFetchAbort: AbortController | null = null;

// ─── Render ──────────────────────────────────────────────────────────────

function render(): void {
  // Cleanup phase: cancel side effects of the prior render that aren't
  // applicable to this state.
  if (state.stage !== "landing" && manifestFetchAbort) {
    manifestFetchAbort.abort();
    manifestFetchAbort = null;
  }
  if (state.stage !== "success" && successRedirectTimer) {
    clearTimeout(successRedirectTimer);
    successRedirectTimer = null;
  }
  if (openLightboxState) closeLightbox();

  // Clear without removing the #root element itself.
  while (root.firstChild) root.removeChild(root.firstChild);

  switch (state.stage) {
    case "landing":
      root.appendChild(renderLanding());
      break;
    case "auth_prompt":
      root.appendChild(renderAuthPromptScreen(null));
      break;
    case "idle_upload":
      root.appendChild(renderIdleUpload());
      break;
    case "parsing":
    case "rendering_rows":
    case "hashing":
    case "uploading":
      root.appendChild(renderProgress());
      break;
    case "confirm_overwrite":
      root.appendChild(renderConfirmOverwriteScreen(state));
      break;
    case "success":
      root.appendChild(
        renderSuccess(state.result, state.parsed, state.rows, state.fileName),
      );
      break;
    case "error":
      root.appendChild(renderErrorScreen(state.cause));
      break;
  }
}

// ─── Landing ─────────────────────────────────────────────────────────────

function renderLanding(): HTMLElement {
  const screen = el("div", { class: "landing-screen" });

  const header = el("header", { class: "landing-header" });
  const title = el("h1", { class: "landing-title" });
  title.textContent = `${DEPARTMENT} shift calendars`;
  header.appendChild(title);
  const uploadBtn = el("button", {
    class: "btn btn-primary upload-new-btn",
    type: "button",
  }) as HTMLButtonElement;
  uploadBtn.textContent = "Upload new plan";
  uploadBtn.addEventListener("click", () => {
    state = toAuthPrompt(state);
    render();
  });
  header.appendChild(uploadBtn);
  screen.appendChild(header);

  const body = el("div", { class: "landing-body" });
  const skeleton = el("div", { class: "landing-skeleton", role: "status" });
  skeleton.textContent = "Loading…";
  body.appendChild(skeleton);
  screen.appendChild(body);

  // Always refresh — the post-success auto-redirect must see the just-uploaded
  // plan (Plan agent G10).
  if (manifestFetchAbort) manifestFetchAbort.abort();
  manifestFetchAbort = new AbortController();
  void fetchManifest(manifestFetchAbort.signal)
    .then((data) => {
      manifestSnapshot = data;
      if (state.stage !== "landing") return;
      mountLandingBody(body, data);
    })
    .catch((err) => {
      if ((err as Error).name === "AbortError") return;
      if (state.stage !== "landing") return;
      mountLandingError(body);
    });

  return screen;
}

async function fetchManifest(signal: AbortSignal): Promise<ManifestResponse> {
  const res = await fetch(`${API_BASE}/api/manifest`, { signal });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return (await res.json()) as ManifestResponse;
}

function mountLandingBody(body: HTMLElement, data: ManifestResponse): void {
  while (body.firstChild) body.removeChild(body.firstChild);

  if (data.staff.length === 0) {
    const empty = el("div", { class: "landing-empty" });
    const msg = el("p", { class: "landing-empty-msg" });
    msg.textContent = "No plan uploaded yet.";
    empty.appendChild(msg);
    const cta = el("button", {
      class: "btn btn-primary",
      type: "button",
    }) as HTMLButtonElement;
    cta.textContent = "Upload first plan";
    cta.addEventListener("click", () => {
      state = toAuthPrompt(state);
      render();
    });
    empty.appendChild(cta);
    body.appendChild(empty);
    return;
  }

  if (data.latest_plan) {
    const caption = el("p", { class: "latest-plan-caption" });
    caption.textContent = `Latest: ${data.latest_plan.original_filename} — uploaded ${formatTimestamp(data.latest_plan.uploaded_at)}`;
    body.appendChild(caption);
  }

  const groups = groupStaffByRole(data.staff);
  for (const g of groups) {
    body.appendChild(renderStaffListGroup(g));
  }
}

function mountLandingError(body: HTMLElement): void {
  while (body.firstChild) body.removeChild(body.firstChild);
  const errEl = el("div", { class: "landing-error", role: "alert" });
  const p = el("p", {});
  p.textContent = "Couldn't load the staff list.";
  errEl.appendChild(p);
  const retry = el("button", {
    class: "btn btn-primary",
    type: "button",
  }) as HTMLButtonElement;
  retry.textContent = "Retry";
  retry.addEventListener("click", () => render());
  errEl.appendChild(retry);
  body.appendChild(errEl);
}

// ─── Auth prompt (password modal as full screen) ─────────────────────────

function renderAuthPromptScreen(initialError: string | null): HTMLElement {
  return renderPasswordModal({
    onSubmit: (password) => {
      state = toIdleUpload(state, password);
      render();
    },
    onCancel: () => {
      state = toLanding(state);
      render();
    },
    initialError,
  });
}

// ─── Idle upload (drop zone) ─────────────────────────────────────────────

function renderIdleUpload(): HTMLElement {
  const screen = el("div", { class: "center-screen" });
  const label = el("label", { class: "drop-zone", for: "pdf-input" });

  const main = el("div", { class: "drop-zone-main" });
  main.textContent = isMobile()
    ? "Choose your shift PDF"
    : "Drop your shift PDF here";
  label.appendChild(main);

  if (!isMobile()) {
    const sub = el("div", { class: "drop-zone-secondary" });
    sub.textContent = "or click to choose";
    label.appendChild(sub);
  }

  // Visually-hidden file input — what Tab focuses.
  const input = el("input", {
    id: "pdf-input",
    type: "file",
    accept: "application/pdf,.pdf",
    class: "sr-only",
    "aria-label": "Upload a shift PDF",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    inlineError = null;
    const file = input.files?.[0];
    if (file) handleFileSelected(file);
  });
  label.appendChild(input);

  screen.appendChild(label);

  const subLabel = el("div", { class: "sub-label" });
  subLabel.textContent = `Codes for: ${DEPARTMENT}`;
  screen.appendChild(subLabel);

  const cancelRow = el("div", { class: "drop-cancel-row" });
  const cancelBtn = el("button", {
    class: "btn btn-quiet",
    type: "button",
  }) as HTMLButtonElement;
  cancelBtn.textContent = "Back to staff list";
  cancelBtn.addEventListener("click", () => {
    state = toLanding(state);
    render();
  });
  cancelRow.appendChild(cancelBtn);
  screen.appendChild(cancelRow);

  if (inlineError) {
    const errEl = el("div", { class: "inline-error", role: "alert" });
    errEl.textContent = inlineError;
    screen.appendChild(errEl);
  }

  queueMicrotask(() => {
    (document.getElementById("pdf-input") as HTMLInputElement | null)?.focus();
  });

  return screen;
}

// ─── Confirm overwrite modal ─────────────────────────────────────────────

function renderConfirmOverwriteScreen(s: State & { stage: "confirm_overwrite" }): HTMLElement {
  const backdrop = el("div", {
    class: "modal-backdrop",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "confirm-heading",
  });
  const card = el("div", { class: "modal-card" });
  backdrop.appendChild(card);

  const heading = el("h2", { id: "confirm-heading" });
  heading.textContent = "Confirm upload";
  card.appendChild(heading);

  const body = el("p", { class: "modal-body" });
  // The manifest snapshot is fetched at landing render; between landing and
  // confirm-click another admin could have uploaded. Spec L386–391 accepts
  // this last-writer-wins behaviour. The displayed previous-plan info may be
  // stale; the server upload still overwrites whatever the current latest is.
  const incomingMonths = formatMonths(s.parsed.months);
  const incomingName = s.file.name;
  const latest = manifestSnapshot?.latest_plan ?? null;
  if (latest && plansShareAnyDate(s.parsed.months, latest.months)) {
    body.appendChild(document.createTextNode("You are about to replace "));
    body.appendChild(strong(latest.original_filename));
    body.appendChild(
      document.createTextNode(
        ` (${formatMonths(latest.months)}, uploaded ${formatTimestamp(latest.uploaded_at)}) with `,
      ),
    );
    body.appendChild(strong(incomingName));
    body.appendChild(
      document.createTextNode(
        ` (${incomingMonths}). Existing events on overlapping dates will be overwritten.`,
      ),
    );
  } else if (latest) {
    body.appendChild(document.createTextNode("You are about to add "));
    body.appendChild(strong(incomingName));
    body.appendChild(
      document.createTextNode(
        ` (${incomingMonths}). The existing plan `,
      ),
    );
    body.appendChild(strong(latest.original_filename));
    body.appendChild(
      document.createTextNode(
        ` (${formatMonths(latest.months)}, uploaded ${formatTimestamp(latest.uploaded_at)}) covers different dates and will be kept.`,
      ),
    );
  } else {
    body.appendChild(document.createTextNode("You are about to upload "));
    body.appendChild(strong(incomingName));
    body.appendChild(
      document.createTextNode(` (${incomingMonths}) as the first plan.`),
    );
  }
  card.appendChild(body);

  const actions = el("div", { class: "modal-actions" });
  const cancel = el("button", {
    class: "btn btn-quiet",
    type: "button",
  }) as HTMLButtonElement;
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    state = toLanding(state);
    render();
  });
  actions.appendChild(cancel);

  const confirm = el("button", {
    class: "btn btn-primary",
    type: "button",
  }) as HTMLButtonElement;
  confirm.textContent = "Confirm and upload";
  confirm.addEventListener("click", () => {
    void proceedWithUpload(s);
  });
  actions.appendChild(confirm);
  card.appendChild(actions);

  queueMicrotask(() => confirm.focus());
  return backdrop;
}

function strong(text: string): HTMLElement {
  const s = document.createElement("strong");
  s.textContent = text;
  return s;
}

// ─── Progress ────────────────────────────────────────────────────────────

function renderProgress(): HTMLElement {
  const screen = el("div", { class: "center-screen" });
  screen.appendChild(el("div", { class: "spinner", "aria-hidden": "true" }));
  const lbl = el("div", {
    class: "progress-label",
    id: "progress-label",
    role: "status",
    "aria-live": "polite",
  });
  // Initial text is decided per stage by the orchestrator (label-delay rule).
  lbl.textContent = currentProgressLabel();
  screen.appendChild(lbl);
  return screen;
}

function currentProgressLabel(): string {
  switch (state.stage) {
    case "parsing":
      // Empty until 800ms timer fires. The timer mutates the label after.
      return "";
    case "rendering_rows":
      return `Preparing row previews… (0 / ${state.parsed.people.length})`;
    case "hashing":
      return "Almost done…";
    case "uploading":
      return "Saving to the server…";
    default:
      return "";
  }
}

function setProgressLabel(text: string): void {
  const lbl = document.getElementById("progress-label");
  if (lbl) lbl.textContent = text;
}

// ─── Success ─────────────────────────────────────────────────────────────

function renderSuccess(
  result: UploadResponse,
  parsed: ParseResult,
  rows: Map<string, Blob>,
  fileName: string,
): HTMLElement {
  const screen = el("div", { class: "success" });

  const heading = el("h1", { class: "success-heading" });
  heading.textContent = `Found ${result.feeds.length} ${
    result.feeds.length === 1 ? "person" : "people"
  } in this PDF`;
  screen.appendChild(heading);

  const anomalies = parsed.warnings.filter(
    (w) => w.kind === "whitespace_in_code",
  );
  const hasAnomaly = anomalies.length > 0;
  if (hasAnomaly) {
    screen.appendChild(renderParserAnomalyBanner(anomalies));
  }

  const hasUnknownCodes = result.unknown_codes.length > 0;
  if (hasUnknownCodes) {
    screen.appendChild(renderUnknownCodesBanner(result.unknown_codes));
  }

  // Build StaffListItem from response + parsed.
  const items: StaffListItem[] = [];
  const byNameRole = new Map<string, UploadResponseFeed>();
  for (const f of result.feeds) byNameRole.set(`${f.role}|${f.name}`, f);
  for (const person of parsed.people) {
    const feed = byNameRole.get(`${person.role}|${person.name}`);
    if (!feed) continue;
    const opener = { ref: null as HTMLElement | null };
    items.push({
      person_hash: feed.person_hash,
      name: feed.name,
      role: feed.role,
      feed_url: feed.webcal_url,
      onPreview: (btn) => {
        opener.ref = btn;
        const blob = rows.get(feed.person_hash);
        if (blob) openLightboxBlob(blob, feed.name, fileName, btn);
      },
    });
  }
  const groups = groupItemsByRole(items);
  for (const g of groups) {
    screen.appendChild(renderStaffListGroup(g));
  }

  const cta = el("div", { class: "re-upload" });
  const btn = el("button", {
    class: "btn re-upload-btn",
    type: "button",
  }) as HTMLButtonElement;
  btn.textContent = "Back to staff list";
  btn.addEventListener("click", () => {
    state = toLanding(state);
    render();
  });
  cta.appendChild(btn);
  screen.appendChild(cta);

  // Auto-redirect rule (spec § State machine): suppress when the screen has
  // a banner the admin must read.
  const suppress = hasAnomaly || hasUnknownCodes;
  if (!suppress) {
    if (successRedirectTimer) clearTimeout(successRedirectTimer);
    successRedirectTimer = setTimeout(() => {
      successRedirectTimer = null;
      if (state.stage === "success") {
        state = toLanding(state);
        render();
      }
    }, 2000);
  }

  return screen;
}

type WhitespaceWarning = Extract<ParseWarning, { kind: "whitespace_in_code" }>;

function renderParserAnomalyBanner(
  anomalies: WhitespaceWarning[],
): HTMLElement {
  const banner = el("div", {
    class: "banner banner-error",
    role: "alert",
    "aria-labelledby": "anomaly-heading",
  });
  const h2 = el("h2", { id: "anomaly-heading" });
  h2.textContent = "Parsing issue detected";
  banner.appendChild(h2);

  const body = el("div", { class: "banner-body" });
  const plural = anomalies.length === 1 ? "shift" : "shifts";
  body.appendChild(
    document.createTextNode(
      `${anomalies.length} ${plural} couldn't be split correctly and may be missing or wrong in the calendar (`,
    ),
  );
  const sample = anomalies
    .slice(0, 3)
    .map((a) => `${a.name} ${a.date}: ${a.code}`)
    .join("; ");
  const codesEl = el("span", { class: "banner-codes" });
  codesEl.textContent = sample;
  body.appendChild(codesEl);
  body.appendChild(
    document.createTextNode(
      anomalies.length > 3
        ? `; +${anomalies.length - 3} more). Please report this PDF.`
        : "). Please report this PDF.",
    ),
  );
  banner.appendChild(body);

  const dismiss = el("button", {
    class: "banner-dismiss",
    "aria-label": "Dismiss",
    type: "button",
  }) as HTMLButtonElement;
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => banner.remove());
  banner.appendChild(dismiss);

  return banner;
}

function renderUnknownCodesBanner(codes: string[]): HTMLElement {
  const banner = el("div", {
    class: "banner",
    role: "region",
    "aria-labelledby": "banner-heading",
  });
  const h2 = el("h2", { id: "banner-heading" });
  h2.textContent = "Unrecognized codes";
  banner.appendChild(h2);

  const body = el("div", { class: "banner-body" });
  body.appendChild(
    document.createTextNode("These codes weren't recognized and were skipped: "),
  );
  const codesEl = el("span", { class: "banner-codes" });
  codesEl.textContent = codes.join(", ");
  body.appendChild(codesEl);
  body.appendChild(
    document.createTextNode(". Email your admin to add them."),
  );
  banner.appendChild(body);

  const dismiss = el("button", {
    class: "banner-dismiss",
    "aria-label": "Dismiss",
    type: "button",
  }) as HTMLButtonElement;
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => banner.remove());
  banner.appendChild(dismiss);

  return banner;
}

// ─── Shared staff list (landing + success) ───────────────────────────────

type StaffListItem = {
  person_hash: string;
  name: string;
  role: string;
  feed_url: string;
  onPreview: (opener: HTMLElement) => void;
};

type StaffListGroup = { role: string; items: StaffListItem[] };

function groupItemsByRole(items: StaffListItem[]): StaffListGroup[] {
  const groups: StaffListGroup[] = [];
  const idx = new Map<string, number>();
  for (const item of items) {
    let gi = idx.get(item.role);
    if (gi === undefined) {
      gi = groups.length;
      idx.set(item.role, gi);
      groups.push({ role: item.role, items: [] });
    }
    groups[gi]!.items.push(item);
  }
  return groups;
}

function groupStaffByRole(staff: ManifestStaffEntry[]): StaffListGroup[] {
  const items: StaffListItem[] = staff.map((s) => ({
    person_hash: s.person_hash,
    name: s.name,
    role: s.role,
    feed_url: s.feed_url,
    onPreview: (opener) => {
      openLightboxEntries(
        s.entries.map((e) => ({
          url: e.row_url,
          caption: `${monthName(e.months[0]?.month ?? 0)} ${e.months[0]?.year ?? ""} · ${e.original_filename}`,
        })),
        s.name,
        opener,
      );
    },
  }));
  return groupItemsByRole(items);
}

function renderStaffListGroup(group: StaffListGroup): HTMLElement {
  const section = el("section", { class: "role-group" });
  const caption = el("div", { class: "role-caption" });
  caption.textContent = group.role;
  section.appendChild(caption);

  for (const item of group.items) {
    section.appendChild(renderPersonRow(item));
  }
  return section;
}

function renderPersonRow(item: StaffListItem): HTMLElement {
  const row = el("div", { class: "person-row" });

  const nameEl = el("span", { class: "person-name" });
  nameEl.textContent = item.name;
  row.appendChild(nameEl);

  const previewBtn = el("button", {
    class: "btn btn-quiet preview-btn",
    type: "button",
  }) as HTMLButtonElement;
  previewBtn.textContent = "Preview row";
  previewBtn.addEventListener("click", () => item.onPreview(previewBtn));
  row.appendChild(previewBtn);

  const copyBtn = el("button", {
    class: "btn btn-primary copy-btn",
    type: "button",
  }) as HTMLButtonElement;
  copyBtn.textContent = "Copy URL";
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.feed_url);
      copyBtn.textContent = "Copied!";
    } catch {
      copyBtn.textContent = "Copy failed";
    }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyBtn.textContent = "Copy URL";
      copyTimer = null;
    }, 1500);
  });
  row.appendChild(copyBtn);

  const googleLink = el("a", {
    class: "btn-link google-link",
    href: googleCalendarUrl(item.feed_url),
    target: "_blank",
    rel: "noopener noreferrer",
  });
  googleLink.textContent = "Open in Google Calendar";
  row.appendChild(googleLink);

  const fallback = el("div", { class: "row-fallback" });
  fallback.textContent =
    "If the button doesn't work: 1) Copy this URL. 2) In Google Calendar, click '+' → 'From URL' and paste.";
  row.appendChild(fallback);

  return row;
}

function googleCalendarUrl(feedUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`;
}

// ─── Error ───────────────────────────────────────────────────────────────

function renderErrorScreen(cause: ErrorCause): HTMLElement {
  const screen = el("div", { class: "center-screen error-screen" });
  const h1 = el("h1", {});
  h1.textContent = "Something went wrong.";
  screen.appendChild(h1);

  const { detail, action } = errorCauseToCopy(cause);
  const detailEl = el("p", { class: "error-detail" });
  detailEl.textContent = detail;
  screen.appendChild(detailEl);

  if (action) {
    const actionEl = el("p", { class: "error-action" });
    actionEl.textContent = action;
    screen.appendChild(actionEl);
  }

  const btnWrap = el("div", { class: "try-again" });
  const btn = el("button", {
    class: "btn btn-primary",
    type: "button",
  }) as HTMLButtonElement;
  if (cause.kind === "invalid_admin_password") {
    btn.textContent = "Retry password";
    btn.addEventListener("click", () => {
      // toAuthPrompt clears the password (auth_prompt holds no pw).
      state = toAuthPrompt(state);
      render();
    });
  } else {
    btn.textContent = "Back to staff list";
    btn.addEventListener("click", () => {
      state = toLanding(state);
      render();
    });
  }
  btnWrap.appendChild(btn);
  screen.appendChild(btnWrap);
  return screen;
}

function errorCauseToCopy(cause: ErrorCause): {
  detail: string;
  action: string | null;
} {
  switch (cause.kind) {
    case "parse_error":
      return parseErrorCopy(cause.code);
    case "no_people_found":
      return { detail: "No people found in this PDF.", action: "Try again with a different file." };
    case "payload_too_large":
      return {
        detail:
          "Your PDF plus the row previews total more than 10 MB — the server won't accept it.",
        action: "Try again with a smaller PDF.",
      };
    case "http_400":
      return {
        detail: cause.serverMessage
          ? `Server rejected the upload: ${cause.serverMessage}.`
          : "Server rejected the upload.",
        action: "Try again.",
      };
    case "http_413":
      return {
        detail: "Upload too large for the server (max 10 MB total).",
        action: "Try again with a smaller PDF.",
      };
    case "http_415":
      return { detail: "Server rejected the file type.", action: "Try again." };
    case "http_429":
      return {
        detail:
          cause.retryAfter !== undefined
            ? `Too many uploads. Try again in ${cause.retryAfter}s.`
            : "Too many uploads. Try again in a moment.",
        action: "Try again later.",
      };
    case "http_500":
      return {
        detail: "Server error — please try again.",
        action: "If it keeps failing, report it.",
      };
    case "network":
      return {
        detail: "Couldn't reach the server.",
        action: "Check your connection and try again.",
      };
    case "unexpected_content_type":
      return {
        detail: "Server returned an unexpected response.",
        action: "Refresh and try again.",
      };
    case "invalid_admin_password":
      return INVALID_ADMIN_PASSWORD_COPY;
    case "unknown":
      return {
        detail: cause.message
          ? `Something went wrong: ${cause.message}.`
          : "Something went wrong.",
        action: "Refresh and try again.",
      };
  }
}

function parseErrorCopy(code: ParseErrorCode): { detail: string; action: string } {
  switch (code) {
    case "no_text_layer":
      return {
        detail:
          "This PDF doesn't have selectable text — it's an image scan. Ask the schedule maintainer for the original (not a scan).",
        action: "Try again with a different file.",
      };
    case "day_row_not_found":
      return {
        detail:
          "Couldn't find the row of day numbers. The PDF layout may have changed — please report this.",
        action: "Try again.",
      };
    case "too_many_months":
      return {
        detail:
          "This PDF covers more than 2 months. V1 supports up to two months per upload.",
        action: "Try again with a shorter range.",
      };
    case "multiple_tables":
      return {
        detail:
          "This PDF has more than one schedule on a page. V1 supports one table at a time.",
        action: "Try again.",
      };
    case "empty_pdf":
      return { detail: "This PDF appears to be empty.", action: "Try again." };
    case "internal_validation_failed":
      return {
        detail: "Parser self-check failed. This is a bug — please report it.",
        action: "Try again.",
      };
  }
}

// ─── Lightbox ────────────────────────────────────────────────────────────
//
// Two call shapes:
//   Blob mode  — success screen, V1 behavior: one <figure> with the
//                in-memory PNG blob URL.
//   URL mode   — landing screen, V2: one <figure> per entry, stacked
//                vertically + scrollable, lazy-loaded images.
// Shared: focus-trap, Escape, click-backdrop-to-close, restore focus to
// the opener button.

type EntryView = { url: string; caption: string };

let openLightboxState: {
  blobUrls: string[]; // URLs to revoke on close (Blob mode only)
  backdrop: HTMLElement;
  closeBtn: HTMLElement;
  opener: HTMLElement;
  onKey: (e: KeyboardEvent) => void;
} | null = null;

function openLightboxBlob(
  blob: Blob,
  name: string,
  fileName: string | null,
  opener: HTMLElement,
): void {
  const url = URL.createObjectURL(blob);
  openLightboxInternal(
    [
      {
        url,
        caption: `Schedule row for ${name}${fileName ? ` — ${fileName}` : ""}`,
      },
    ],
    `Row preview for ${name}`,
    opener,
    [url],
  );
}

function openLightboxEntries(
  entries: EntryView[],
  name: string,
  opener: HTMLElement,
): void {
  openLightboxInternal(entries, `Row previews for ${name}`, opener, []);
}

function openLightboxInternal(
  entries: EntryView[],
  dialogLabel: string,
  opener: HTMLElement,
  blobUrls: string[],
): void {
  const backdrop = el("div", {
    class: "lightbox-backdrop",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": dialogLabel,
  });

  const stack = el("div", { class: "lightbox-stack" });
  for (const entry of entries) {
    const fig = document.createElement("figure");
    fig.className = "lightbox-fig";
    const img = document.createElement("img");
    img.className = "lightbox-img";
    img.alt = entry.caption;
    img.loading = "lazy";
    img.src = entry.url;
    fig.appendChild(img);
    const caption = document.createElement("figcaption");
    caption.className = "lightbox-caption";
    caption.textContent = entry.caption;
    fig.appendChild(caption);
    stack.appendChild(fig);
  }
  backdrop.appendChild(stack);

  const closeBtn = el("button", {
    class: "lightbox-close",
    type: "button",
    "aria-label": "Close preview",
  }) as HTMLButtonElement;
  closeBtn.textContent = "×";
  backdrop.appendChild(closeBtn);

  const close = () => closeLightbox();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target === stack) close();
  });
  closeBtn.addEventListener("click", close);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    // Simple focus trap: only the close button is focusable inside the dialog.
    if (e.key === "Tab") {
      e.preventDefault();
      closeBtn.focus();
    }
  };
  document.addEventListener("keydown", onKey);

  document.body.appendChild(backdrop);
  closeBtn.focus();

  openLightboxState = { blobUrls, backdrop, closeBtn, opener, onKey };
}

function closeLightbox(): void {
  if (!openLightboxState) return;
  const { blobUrls, backdrop, opener, onKey } = openLightboxState;
  document.removeEventListener("keydown", onKey);
  backdrop.remove();
  for (const url of blobUrls) URL.revokeObjectURL(url);
  openLightboxState = null;
  opener.focus();
}

// ─── Pipeline orchestration ──────────────────────────────────────────────

async function handleFileSelected(file: File): Promise<void> {
  if (!canDrop(state)) return;
  const v = validateFile(file);
  if (!v.ok) {
    inlineError = v.message;
    render();
    return;
  }
  inlineError = null;
  await runPipeline(file);
}

async function runPipeline(file: File): Promise<void> {
  let bytes: Uint8Array | null = null;
  if (labelTimer) clearTimeout(labelTimer);
  labelTimer = null;

  try {
    state = toParsing(state, file);
    render();
    // 800 ms label delay rule.
    labelTimer = setTimeout(() => {
      if (state.stage === "parsing") setProgressLabel("Reading the PDF…");
    }, 800);

    bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parse(bytes, { file_name: file.name });
    if (labelTimer) {
      clearTimeout(labelTimer);
      labelTimer = null;
    }

    // Inflight invariant: shift codes never contain whitespace. Surface the
    // failing PDF in browser logs so the parser regression can be hunted.
    const anomalies = parsed.warnings.filter(
      (w) => w.kind === "whitespace_in_code",
    );
    if (anomalies.length > 0) {
      console.error(
        `[pdf2calendar] parser anomaly: ${anomalies.length} code(s) contain whitespace — likely a multi-shift item the parser failed to split. File: ${file.name}`,
        anomalies,
      );
    }

    // Validation rule 1: at least one person.
    if (parsed.people.length < 1) {
      state = toError(state, { kind: "no_people_found" });
      render();
      return;
    }

    state = toRenderingRows(state, parsed);
    render();
    setProgressLabel(
      `Preparing row previews… (0 / ${parsed.people.length})`,
    );

    // Compute person hashes upfront so renderRowImages can key by hash.
    const hashes = await Promise.all(
      parsed.people.map((p) => personHash(DEPARTMENT, p.name)),
    );

    const jobs: RowJob[] = parsed.people.map((p, i) => ({
      person_hash: hashes[i]!,
      row_band: p.row_band,
    }));

    const total = parsed.people.length;
    const rows = await renderRowImages(
      bytes,
      parsed.header_band,
      jobs,
      async (done) => {
        setProgressLabel(`Preparing row previews… (${done} / ${total})`);
        if (done % 5 === 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      },
    );

    if (rows.size !== parsed.people.length) {
      throw new ParseError("internal_validation_failed", {
        check: "row_count_mismatch",
        reason: `got ${rows.size}, want ${parsed.people.length}`,
      });
    }

    state = toHashing(state, rows);
    render();
    setProgressLabel("Almost done…");

    const pdf_sha256 = await pdfHash(bytes);

    // Free the PDF bytes — FormData (built later) will re-blob from rows
    // and we keep the parsed result in state.
    bytes = null;

    state = toConfirmOverwrite(state, pdf_sha256);
    render();
    // From here the user clicks Confirm → proceedWithUpload, or Cancel → landing.
  } catch (err) {
    if (labelTimer) {
      clearTimeout(labelTimer);
      labelTimer = null;
    }
    state = toError(state, errToCause(err));
    render();
  }
}

async function proceedWithUpload(
  s: State & { stage: "confirm_overwrite" },
): Promise<void> {
  state = toUploading(state);
  render();
  setProgressLabel("Saving to the server…");

  try {
    // Re-read file bytes — we freed them after hashing to keep memory low.
    const bytes = new Uint8Array(await s.file.arrayBuffer());
    const hashes = await Promise.all(
      s.parsed.people.map((p) => personHash(DEPARTMENT, p.name)),
    );
    const payload: UploadPayload = {
      department: DEPARTMENT,
      pdf_sha256: s.pdf_sha256,
      source_file_name: s.file.name,
      original_filename: s.file.name,
      admin_password: s.admin_password,
      date_range: s.parsed.date_range,
      months: s.parsed.months,
      people: s.parsed.people.map((p, i) => ({
        role: p.role,
        name: p.name,
        person_hash: hashes[i]!,
        days: p.days,
      })),
    };
    const { formData, totalBytes } = buildMultipart(
      payload,
      bytes,
      s.file.name,
      s.rows,
    );
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      state = toError(state, { kind: "payload_too_large" });
      render();
      return;
    }
    const result = await uploadToServer(formData, API_BASE);
    state = toSuccess(state, result);
    render();
  } catch (err) {
    state = toError(state, errToCause(err));
    render();
  }
}

function errToCause(err: unknown): ErrorCause {
  if (err instanceof UploadError) return err.errorCause;
  if (err instanceof ParseError) {
    return {
      kind: "parse_error",
      code: err.code,
      ...(err.detail?.check !== undefined ? { detail: err.detail.check } : {}),
    };
  }
  if (err instanceof Error) return { kind: "unknown", message: err.message };
  return { kind: "unknown", message: String(err) };
}

// ─── Drag-drop wiring ────────────────────────────────────────────────────

function setupDragDrop(): void {
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (!canDrop(state)) return;
    dragCounter += 1;
    document.querySelector(".drop-zone")?.classList.add("dragover");
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!canDrop(state)) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (!canDrop(state)) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      document.querySelector(".drop-zone")?.classList.remove("dragover");
    }
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.querySelector(".drop-zone")?.classList.remove("dragover");
    if (!canDrop(state)) return;
    inlineError = null;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    handleFileSelected(file);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isMobile(): boolean {
  return window.matchMedia("(max-width: 640px)").matches;
}

function el(tag: string, attrs: Record<string, string>): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function formatMonths(
  months: Array<{ year: number; month: number; days_covered?: number[] }>,
): string {
  if (months.length === 0) return "";
  if (months.length === 1) {
    const m = months[0]!;
    return `${monthName(m.month)} ${m.year}`;
  }
  return months.map((m) => `${monthName(m.month)} ${m.year}`).join(", ");
}

function monthName(month: number): string {
  return [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][month] ?? `Month ${month}`;
}

function formatTimestamp(iso: string): string {
  // "2026-05-12T14:03:21.000Z" → "2026-05-12 14:03"
  // Use the user's local time so the displayed timestamp matches their wall
  // clock; admin-facing screen only.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Boot ────────────────────────────────────────────────────────────────

setupDragDrop();
render();
