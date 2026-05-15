// DOM orchestrator — the only file in `web/` that touches `document` /
// browser event listeners. Every other module takes inputs by parameter and
// returns plain values. See docs/frontend-spec.md.

import {
  ParseError,
  type ParseErrorCode,
  type ParseResult,
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
import { pdfHash } from "./pdf-hash.ts";
import { personHash } from "./person-hash.ts";
import { renderRowImages, type RowJob } from "./row-image.ts";
import {
  canDrop,
  initialState,
  reset,
  toError,
  toHashing,
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
let dragCounter = 0;

// ─── Render ──────────────────────────────────────────────────────────────

function render(): void {
  // Clear without removing the #root element itself.
  while (root.firstChild) root.removeChild(root.firstChild);

  switch (state.stage) {
    case "idle":
      root.appendChild(renderIdle());
      break;
    case "parsing":
    case "rendering_rows":
    case "hashing":
    case "uploading":
      root.appendChild(renderProgress());
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

function renderIdle(): HTMLElement {
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

  if (inlineError) {
    const errEl = el("div", { class: "inline-error", role: "alert" });
    errEl.textContent = inlineError;
    screen.appendChild(errEl);
  }

  // Restore focus to the input on every fresh idle render — used after reset.
  queueMicrotask(() => {
    (document.getElementById("pdf-input") as HTMLInputElement | null)?.focus();
  });

  return screen;
}

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

  if (result.unknown_codes.length > 0) {
    screen.appendChild(renderUnknownCodesBanner(result.unknown_codes));
  }

  const groups = groupFeedsByRole(parsed, result.feeds);
  for (const g of groups) {
    screen.appendChild(renderRoleGroup(g, rows, fileName));
  }

  const reupload = el("div", { class: "re-upload" });
  const btn = el("button", {
    class: "btn re-upload-btn",
    type: "button",
  }) as HTMLButtonElement;
  btn.textContent = "Re-upload PDF";
  btn.addEventListener("click", () => doReset());
  reupload.appendChild(btn);
  screen.appendChild(reupload);

  return screen;
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

type RoleGroup = {
  role: string;
  rows: Array<{ name: string; feed: UploadResponseFeed }>;
};

function groupFeedsByRole(
  parsed: ParseResult,
  feeds: UploadResponseFeed[],
): RoleGroup[] {
  // crypto.subtle is async, so re-deriving person_hash here would force the
  // whole render path async. Match by (role, name) instead — stable for
  // non-duplicate names; duplicate names are a parser-emitted warning and
  // collide deterministically.
  const byNameRole = new Map<string, UploadResponseFeed>();
  for (const f of feeds) byNameRole.set(`${f.role}|${f.name}`, f);

  const groups: RoleGroup[] = [];
  const groupIdx = new Map<string, number>();
  for (const person of parsed.people) {
    const feed = byNameRole.get(`${person.role}|${person.name}`);
    if (!feed) continue;
    let gi = groupIdx.get(person.role);
    if (gi === undefined) {
      gi = groups.length;
      groupIdx.set(person.role, gi);
      groups.push({ role: person.role, rows: [] });
    }
    groups[gi]!.rows.push({ name: person.name, feed });
  }
  return groups;
}

function renderRoleGroup(
  group: RoleGroup,
  rows: Map<string, Blob>,
  fileName: string | null,
): HTMLElement {
  const section = el("section", { class: "role-group" });
  const caption = el("div", { class: "role-caption" });
  caption.textContent = group.role;
  section.appendChild(caption);

  for (const r of group.rows) {
    section.appendChild(renderPersonRow(r.name, r.feed, rows, fileName));
  }
  return section;
}

function renderPersonRow(
  name: string,
  feed: UploadResponseFeed,
  rows: Map<string, Blob>,
  fileName: string | null,
): HTMLElement {
  const row = el("div", { class: "person-row" });

  const nameEl = el("span", { class: "person-name" });
  nameEl.textContent = name;
  row.appendChild(nameEl);

  const previewBtn = el("button", {
    class: "btn btn-quiet preview-btn",
    type: "button",
  }) as HTMLButtonElement;
  previewBtn.textContent = "Preview row";
  previewBtn.addEventListener("click", () => {
    const blob = rows.get(feed.person_hash);
    if (blob) openLightbox(blob, name, fileName, previewBtn);
  });
  row.appendChild(previewBtn);

  const copyBtn = el("button", {
    class: "btn btn-primary copy-btn",
    type: "button",
  }) as HTMLButtonElement;
  copyBtn.textContent = "Copy URL";
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(feed.webcal_url);
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
    href: googleCalendarUrl(feed.webcal_url),
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

function googleCalendarUrl(webcalUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`;
}

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
  btn.textContent = "Try again";
  btn.addEventListener("click", () => doReset());
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

let openLightboxState: {
  url: string;
  backdrop: HTMLElement;
  closeBtn: HTMLElement;
  opener: HTMLElement;
  onKey: (e: KeyboardEvent) => void;
} | null = null;

function openLightbox(
  blob: Blob,
  name: string,
  fileName: string | null,
  opener: HTMLElement,
): void {
  const url = URL.createObjectURL(blob);

  const backdrop = el("div", {
    class: "lightbox-backdrop",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": `Row preview for ${name}`,
  });
  const img = el("img", {
    class: "lightbox-img",
    src: url,
    alt: `Schedule row for ${name}${fileName ? ` from ${fileName}` : ""}`,
  });
  backdrop.appendChild(img);

  const closeBtn = el("button", {
    class: "lightbox-close",
    type: "button",
    "aria-label": "Close preview",
  }) as HTMLButtonElement;
  closeBtn.textContent = "×";
  backdrop.appendChild(closeBtn);

  const close = () => closeLightbox();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
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

  openLightboxState = { url, backdrop, closeBtn, opener, onKey };
}

function closeLightbox(): void {
  if (!openLightboxState) return;
  const { url, backdrop, opener, onKey } = openLightboxState;
  document.removeEventListener("keydown", onKey);
  backdrop.remove();
  URL.revokeObjectURL(url);
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
        // Yield rule: let the spinner + counter paint.
        if (done % 5 === 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      },
    );

    // Validation rule 2: one blob per person.
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

    state = toUploading(state, pdf_sha256);
    render();
    setProgressLabel("Saving to the server…");

    const payload: UploadPayload = {
      department: DEPARTMENT,
      pdf_sha256,
      source_file_name: file.name,
      date_range: parsed.date_range,
      months: parsed.months,
      people: parsed.people.map((p, i) => ({
        role: p.role,
        name: p.name,
        person_hash: hashes[i]!,
        days: p.days,
      })),
    };

    const { formData, totalBytes } = buildMultipart(
      payload,
      bytes,
      file.name,
      rows,
    );

    // Validation rule 3 (size): pre-flight 9.5 MB.
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      state = toError(state, { kind: "payload_too_large" });
      render();
      return;
    }

    // Free the PDF bytes — FormData has captured the blob view.
    bytes = null;

    const result = await uploadToServer(formData, API_BASE);

    state = toSuccess(state, result);
    render();
  } catch (err) {
    if (labelTimer) {
      clearTimeout(labelTimer);
      labelTimer = null;
    }
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

function doReset(): void {
  if (openLightboxState) closeLightbox();
  state = reset(state);
  inlineError = null;
  render();
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

// ─── Boot ────────────────────────────────────────────────────────────────

setupDragDrop();
render();
