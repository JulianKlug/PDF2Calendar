// Parser for hospital shift-schedule PDFs. See docs/parser-spec.md.
//
// Public surface:
//   parse(pdf, opts?)        — convenience: load via pdfjs-dist + parsePages
//   parsePages(pages, opts?) — testable core; takes already-extracted text items
//
// The two are split so tests can feed canned fixtures without spinning up
// pdfjs in `bun test`. Browser/Node callers hit parse(); env-specific glue
// (e.g. GlobalWorkerOptions.workerSrc in browser) belongs at the call site.

import {
  ParseError,
  type PageDims,
  type ParseResult,
  type ParsedDay,
  type ParsedMonth,
  type ParsedPerson,
  type ParseWarning,
  type RawPage,
  type RawTextItem,
  type YBand,
} from "./types.ts";
import { isKnownCode } from "./codes.ts";

// Roles seen in production. Extend here when a new role appears.
const KNOWN_ROLES = new Set(["cdc", "ma"]);

// ─── Public entry: parse(pdf) ──────────────────────────────────────────────

export type ParseOptions = {
  file_name?: string | null;
  department?: string | null;
};

export async function parse(
  pdf: Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const pages = await loadPages(pdf);
  return parsePages(pages, opts);
}

async function loadPages(pdf: Uint8Array): Promise<RawPage[]> {
  // Legacy ESM build works in both Node/Bun (no worker needed) and browser.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Copy the buffer: pdfjs transfers it (detaches the original) on the first
  // postMessage, which would mutate the caller's input and break re-use.
  const doc = await getDocument({
    data: pdf.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  if (doc.numPages === 0) throw new ParseError("empty_pdf");

  const out: RawPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: RawTextItem[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it?.str !== "string") continue;
      items.push({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: it.height,
      });
    }
    out.push({ page: p, width: vp.width, height: vp.height, items });
  }
  await doc.cleanup();
  return out;
}

// ─── Testable core: parsePages(pages) ──────────────────────────────────────

export function parsePages(
  pages: RawPage[],
  opts: ParseOptions = {},
): ParseResult {
  if (pages.length === 0) throw new ParseError("empty_pdf");
  const allItems = pages.flatMap((p) =>
    p.items.map((it) => ({ ...it, page: p.page })),
  );
  if (allItems.length === 0) throw new ParseError("no_text_layer");

  // Step 1: per-page day-number row.
  // Step 2: per-page month bands.
  // Step 3: per-page weekday-letters row (sanity).
  // Step 3.5: assign each column a full date.
  // We process page-by-page, then concat columns and bands.

  let columns: Column[] = [];
  let headerBand: YBand | null = null;
  const warnings: ParseWarning[] = [];
  const allPageRows: PageRow[] = [];

  for (const page of pages) {
    if (page.items.length === 0) continue;

    const dayRow = findDayRow(page);                 // Step 1
    const monthBands = findMonthBands(page, dayRow); // Step 2
    const weekdayRowY = findWeekdayRowY(page, dayRow); // Step 3 (sanity, optional)

    // Step 3.5: column → date
    const pageColumns = assignDates(page, dayRow, monthBands, warnings);
    columns.push(...pageColumns);

    // First page sets the header_band; multi-page V1 uses page-1 bounds only
    // (renderer crops one canonical header).
    if (!headerBand) {
      const monthRowTop = monthBands.length > 0
        ? Math.max(...monthBands.map((b) => b.y_top))
        : dayRow.y_top;
      const headerBottom = weekdayRowY != null
        ? weekdayRowY.y_bottom
        : dayRow.y_bottom;
      headerBand = {
        page: page.page,
        y_top: monthRowTop,
        y_bottom: headerBottom,
      };
    }

    // Steps 4 + 5: person rows and per-cell extraction (per page).
    const pageRows = findPersonRows(page, dayRow, weekdayRowY, pageColumns, warnings);
    allPageRows.push(...pageRows);
  }

  if (!headerBand) throw new ParseError("day_row_not_found");

  // Distinct months across all pages
  const distinctMonths = new Set(columns.map((c) => `${c.year}-${c.month}`));
  if (distinctMonths.size > 2) throw new ParseError("too_many_months");

  // Build months[] grouped by (year, month)
  const monthsMap = new Map<string, ParsedMonth>();
  for (const c of columns) {
    const key = `${c.year}-${c.month}`;
    let m = monthsMap.get(key);
    if (!m) {
      m = { year: c.year, month: c.month, days_covered: [] };
      monthsMap.set(key, m);
    }
    if (!m.days_covered.includes(c.day)) m.days_covered.push(c.day);
  }
  const months: ParsedMonth[] = [...monthsMap.values()]
    .sort((a, b) => a.year - b.year || a.month - b.month);
  for (const m of months) m.days_covered.sort((a, b) => a - b);

  // date_range from first/last column (already in page+column order)
  const sortedDates = columns
    .map(columnDate)
    .sort();
  const date_range = { start: sortedDates[0]!, end: sortedDates.at(-1)! };

  const page_dims: PageDims[] = pages.map((p) => ({
    page: p.page,
    width: p.width,
    height: p.height,
  }));

  // Step 6: merge per-page rows into people, collect unknown codes.
  const people = mergePeople(allPageRows, columns, warnings);
  const unknown_codes = collectUnknownCodes(people);

  const result: ParseResult = {
    source: {
      file_name: opts.file_name ?? null,
      page_count: pages.length,
      parsed_at: new Date().toISOString(),
      page_dims,
    },
    department: opts.department ?? null,
    date_range,
    header_band: headerBand,
    months,
    people,
    unknown_codes,
    warnings,
  };

  validate(result, columns);
  return result;
}

// ─── Step 1: day-number row ────────────────────────────────────────────────

type DayToken = {
  day: number;
  x_center: number;
  x_right: number;  // day-number right edge — column is right-anchored to this
  y: number;
  height: number;
};

type DayRow = {
  page: number;
  y_top: number;
  y_bottom: number;
  tokens: DayToken[]; // sorted by x_center asc
};

function findDayRow(page: RawPage): DayRow {
  // Bucket by y (±2 pts → same row).
  const buckets = bucketByY(page.items, 2);
  // Day-like = pure 1- or 2-digit integer in [1, 31].
  const isDayLike = (s: string) => {
    const t = s.trim();
    if (!/^\d{1,2}$/.test(t)) return false;
    const n = +t;
    return n >= 1 && n <= 31;
  };
  // Score each bucket. Threshold (≥20) filters noise; spec calls anything
  // above this a day-number row, and >1 such row = multiple_tables (spec
  // line 289). Sort by count desc, then by y desc as a final tiebreak.
  const scored = buckets
    .map((b) => ({ b, count: b.items.filter((it) => isDayLike(it.str)).length }))
    .sort((a, b) => b.count - a.count || b.b.y - a.b.y);

  const qualified = scored.filter((s) => s.count >= 20);
  if (qualified.length === 0) {
    throw new ParseError("day_row_not_found", { page: page.page });
  }
  if (qualified.length > 1) {
    throw new ParseError("multiple_tables", { page: page.page });
  }

  const row = qualified[0]!.b;
  const tokens: DayToken[] = row.items
    .filter((it) => isDayLike(it.str))
    .map((it) => ({
      day: +it.str.trim(),
      x_center: it.x + it.width / 2,
      x_right: it.x + it.width,
      y: it.y,
      height: it.height,
    }))
    .sort((a, b) => a.x_center - b.x_center);

  return {
    page: page.page,
    y_top: row.y + maxHeight(row.items),
    y_bottom: row.y,
    tokens,
  };
}

// ─── Step 2: month bands ───────────────────────────────────────────────────

type MonthBand = {
  page: number;
  year: number;
  month: number;
  x_start: number;
  x_end: number;
  y_top: number;
  y_bottom: number;
};

const FRENCH_MONTHS: Record<string, number> = {
  JANVIER: 1, FEVRIER: 2, FÉVRIER: 2, MARS: 3, AVRIL: 4, MAI: 5, JUIN: 6,
  JUILLET: 7, AOUT: 8, AOÛT: 8, SEPTEMBRE: 9, OCTOBRE: 10, NOVEMBRE: 11,
  DECEMBRE: 12, DÉCEMBRE: 12,
};

const MONTH_BAND_RE = /^([A-ZÉÈÀÂÊÎÔÛÄËÏÖÜÇ]+)\s+(\d{4})$/i;

function findMonthBands(page: RawPage, dayRow: DayRow): MonthBand[] {
  // Look in the row immediately above the day row. Use a generous y window
  // (anything above dayRow.y_top, within ~3 line-heights).
  const candidates = page.items.filter((it) => {
    if (it.y <= dayRow.y_top) return false;
    if (it.y - dayRow.y_top > 50) return false; // keep tight
    const m = it.str.trim().match(MONTH_BAND_RE);
    if (!m) return false;
    return m[1]!.toUpperCase() in FRENCH_MONTHS;
  });

  if (candidates.length === 0) return [];

  // Pick the y-row with the most matches (within ±2 of the topmost match).
  const rowAnchorY = Math.min(...candidates.map((c) => c.y));
  const inRow = candidates.filter((c) => Math.abs(c.y - rowAnchorY) <= 4);

  const sorted = inRow.sort((a, b) => a.x - b.x);
  const bands: MonthBand[] = sorted.map((it, i) => {
    const m = it.str.trim().match(MONTH_BAND_RE)!;
    const month = FRENCH_MONTHS[m[1]!.toUpperCase()]!;
    const year = +m[2]!;
    const x_start = it.x;
    const x_end = i + 1 < sorted.length ? sorted[i + 1]!.x : Infinity;
    return {
      page: page.page,
      year, month, x_start, x_end,
      y_top: it.y + it.height,
      y_bottom: it.y,
    };
  });
  return bands;
}

// ─── Step 3: weekday-letters row (sanity) ──────────────────────────────────

const FRENCH_WEEKDAYS = new Set(["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]);

function findWeekdayRowY(page: RawPage, dayRow: DayRow): YBand | null {
  // Row immediately below the day row.
  const candidates = page.items.filter((it) => {
    if (it.y >= dayRow.y_bottom) return false;
    if (dayRow.y_bottom - it.y > 30) return false;
    return FRENCH_WEEKDAYS.has(it.str.trim().toLowerCase());
  });
  if (candidates.length === 0) return null;
  const yAnchor = Math.max(...candidates.map((c) => c.y));
  const inRow = candidates.filter((c) => Math.abs(c.y - yAnchor) <= 4);
  return {
    page: page.page,
    y_top: yAnchor + maxHeight(inRow),
    y_bottom: yAnchor,
  };
}

// ─── Step 3.5: assign date to each column ──────────────────────────────────

type Column = {
  page: number;
  index: number;        // index within page
  x_center: number;     // day-number text center (kept for outer-bound checks)
  x_right: number;      // day-number right edge — drives true column center
  day: number;
  month: number;
  year: number;
};

function assignDates(
  page: RawPage,
  dayRow: DayRow,
  bands: MonthBand[],
  warnings: ParseWarning[],
): Column[] {
  const useFallback = bands.length === 0;
  if (useFallback) {
    warnings.push({
      kind: "month_band_inference",
      reason: `no month bands found on page ${page.page}; using day-reset fallback`,
    });
  }

  const columns: Column[] = [];

  if (!useFallback) {
    for (let i = 0; i < dayRow.tokens.length; i++) {
      const tok = dayRow.tokens[i]!;
      const band = bands.find((b) => tok.x_center >= b.x_start && tok.x_center < b.x_end);
      if (!band) {
        // Should not happen with last-band-extends-to-+∞ rule; defensive.
        throw new ParseError("internal_validation_failed", {
          page: page.page,
          check: `column ${i} (day ${tok.day}, x=${tok.x_center}) matched no month band`,
        });
      }
      columns.push({
        page: page.page, index: i,
        x_center: tok.x_center, x_right: tok.x_right, day: tok.day,
        month: band.month, year: band.year,
      });
    }
    return columns;
  }

  // Fallback: walk day numbers, detect resets, find first month from any
  // MMMM YYYY token in the page; assume current year if absent.
  let firstMonth: { year: number; month: number } | null = null;
  for (const it of page.items) {
    const m = it.str.trim().match(MONTH_BAND_RE);
    if (m && m[1]!.toUpperCase() in FRENCH_MONTHS) {
      firstMonth = {
        year: +m[2]!,
        month: FRENCH_MONTHS[m[1]!.toUpperCase()]!,
      };
      break;
    }
  }
  if (!firstMonth) {
    const y = new Date().getUTCFullYear();
    warnings.push({ kind: "header_missing_year", assumed_year: y });
    firstMonth = { year: y, month: 1 };
  }

  let { year, month } = firstMonth;
  let prevDay = 0;
  for (let i = 0; i < dayRow.tokens.length; i++) {
    const tok = dayRow.tokens[i]!;
    if (tok.day < prevDay) {
      month++;
      if (month > 12) { month = 1; year++; }
    }
    prevDay = tok.day;
    columns.push({
      page: page.page, index: i,
      x_center: tok.x_center, x_right: tok.x_right, day: tok.day, month, year,
    });
  }
  return columns;
}

// ─── Step 4: person rows ───────────────────────────────────────────────────

type PageRow = {
  page: number;
  role: string;
  name: string;
  row_band: YBand;
  // codes per column on this page (length === pageColumns.length)
  cells: string[][];
};

// Spec §Step 4: French name convention "Lastname, F" or "Lastname, F.".
// PDF sometimes emits "Klug , J" (extra space before the comma); the inner
// `[\p{L}\-' ]+` includes a space so the regex still matches. normalizeName()
// fixes the resulting whitespace so the spec spot-check `name === "Klug, J"`
// passes.
const NAME_RE = /^[A-ZÉÈÀÂÊÎÔÛÄËÏÖÜÇ][\p{L}\-' ]+,\s?[A-Z]\.?$/u;

function normalizeName(raw: string): string {
  // Collapse internal whitespace runs and remove space immediately before
  // the comma. "Klug , J" → "Klug, J".
  return raw.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

function findPersonRows(
  page: RawPage,
  dayRow: DayRow,
  weekdayRow: YBand | null,
  pageColumns: Column[],
  warnings: ParseWarning[],
): PageRow[] {
  // Items below the weekday row (or below day row if no weekday row).
  const lowerBoundY = weekdayRow?.y_bottom ?? dayRow.y_bottom;
  const items = page.items.filter((it) => {
    if (it.y >= lowerBoundY) return false;
    return it.str.trim().length > 0; // drop whitespace-only fragments early
  });
  if (items.length === 0) return [];

  const buckets = bucketByY(items, 2);
  const colWidth = medianColWidth(pageColumns);

  const rows: PageRow[] = [];
  for (const b of buckets) {
    const nameItem = b.items.find((it) => NAME_RE.test(it.str.trim()));
    if (!nameItem) {
      // Likely footer / legend / signature line. Only warn if the bucket
      // looks structurally like a row (has items inside the column band).
      const looksStructured = b.items.some((it) => {
        const xc = it.x + it.width / 2;
        const first = pageColumns[0]!.x_center;
        const last = pageColumns.at(-1)!.x_center;
        return xc >= first - colWidth && xc <= last + colWidth;
      });
      if (looksStructured && b.items.length >= 3) {
        warnings.push({
          kind: "unrecognized_role_header",
          text: b.items.map((it) => it.str.trim()).filter(Boolean).join(" ").slice(0, 80),
          row: rows.length,
        });
      }
      continue;
    }

    // Role: any item in the row whose trimmed lowercased str is a known role.
    const roleItem = b.items.find((it) => KNOWN_ROLES.has(it.str.trim().toLowerCase()));
    const role = roleItem ? roleItem.str.trim().toLowerCase() : "";
    const name = normalizeName(nameItem.str);

    // Cells: everything except the name + role tokens.
    const exclude = new Set<RawTextItem>();
    exclude.add(nameItem);
    if (roleItem) exclude.add(roleItem);
    const cellItems = b.items.filter((it) => !exclude.has(it));
    const cells = extractCells(cellItems, pageColumns, colWidth);

    rows.push({
      page: page.page,
      role,
      name,
      row_band: bandFromBucket(b, page.page),
      cells,
    });
  }
  return rows;
}

// ─── Step 5: cell extraction ───────────────────────────────────────────────

function medianColWidth(columns: Column[]): number {
  if (columns.length < 2) return 16; // sensible default; never hit on real PDFs
  // Use right-edge diffs: day numbers are right-anchored within columns, so
  // x_right is a stable per-column landmark. x_center diffs vary at 1-/2-digit
  // day transitions because narrower numerals pull the geometric center inward.
  const diffs: number[] = [];
  for (let i = 1; i < columns.length; i++) {
    diffs.push(columns[i]!.x_right - columns[i - 1]!.x_right);
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)]!;
}

function extractCells(
  items: RawTextItem[],
  columns: Column[],
  colWidth: number,
): string[][] {
  // The column is right-anchored to the day-number's right edge (x_right);
  // its true center is `x_right - colWidth/2`. Using the day-number's text
  // center (x_center) instead biases the column center rightward by half a
  // digit-width, which pushes narrower codes (e.g. "L2", "C2", single-letter
  // codes) into the *previous* column.
  const half = colWidth / 2;
  const cells: string[][] = columns.map(() => []);
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  for (const it of sorted) {
    const xc = it.x + it.width / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < columns.length; i++) {
      const center = columns[i]!.x_right - half;
      const dist = Math.abs(xc - center);
      if (dist <= half && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const trimmed = it.str.trim();
      if (trimmed) cells[bestIdx]!.push(trimmed);
    }
  }
  return cells;
}

function bandFromBucket(b: Bucket, page: number): YBand {
  return {
    page,
    y_top: b.y + maxHeight(b.items),
    y_bottom: b.y,
  };
}

// ─── Step 6: merge per-page rows into people, collect unknowns ─────────────

function mergePeople(
  pageRows: PageRow[],
  columns: Column[],
  warnings: ParseWarning[],
): ParsedPerson[] {
  // Group by name; preserve first-seen order.
  const byName = new Map<string, PageRow[]>();
  const order: string[] = [];
  for (const r of pageRows) {
    if (!byName.has(r.name)) {
      byName.set(r.name, []);
      order.push(r.name);
    }
    byName.get(r.name)!.push(r);
  }

  // duplicate_name: same name appears 2+ times on the same page (spec
  // §Step 6 — "may be different people, let user disambiguate"). We still
  // merge structurally so the output validates; the warning surfaces it.
  for (const [name, rows] of byName) {
    const pageCounts = new Map<number, number[]>();
    rows.forEach((r, i) => {
      if (!pageCounts.has(r.page)) pageCounts.set(r.page, []);
      pageCounts.get(r.page)!.push(i);
    });
    for (const indices of pageCounts.values()) {
      if (indices.length > 1) {
        warnings.push({ kind: "duplicate_name", name, rows: indices });
      }
    }
  }

  const pagesInOrder = [...new Set(columns.map((c) => c.page))].sort((a, b) => a - b);

  return order.map((name) => {
    const rows = byName.get(name)!;
    rows.sort((a, b) => a.page - b.page);
    const role = rows.find((r) => r.role)?.role ?? "";
    const days: ParsedDay[] = [];
    for (const pageNum of pagesInOrder) {
      const pageColumns = columns.filter((c) => c.page === pageNum);
      const row = rows.find((r) => r.page === pageNum);
      for (let i = 0; i < pageColumns.length; i++) {
        days.push({
          date: columnDate(pageColumns[i]!),
          codes: row?.cells[i] ?? [],
        });
      }
    }
    if (days.length !== columns.length) {
      // Pad/truncate per spec §Step 6.
      warnings.push({
        kind: "row_length_mismatch",
        name,
        expected: columns.length,
        got: days.length,
      });
      while (days.length < columns.length) {
        days.push({ date: columnDate(columns[days.length]!), codes: [] });
      }
      days.length = columns.length;
    }
    return {
      role,
      name,
      days,
      // V1: row_band is the first occurrence. Renderer needs one canonical
      // band; revisit when a real multi-page PDF surfaces.
      row_band: rows[0]!.row_band,
    };
  });
}

function collectUnknownCodes(people: ParsedPerson[]): string[] {
  const set = new Set<string>();
  for (const p of people) {
    for (const d of p.days) {
      for (const c of d.codes) {
        if (!isKnownCode(c)) set.add(c);
      }
    }
  }
  return [...set].sort();
}

// ─── Validation (spec §"Validation rules") ─────────────────────────────────

function validate(r: ParseResult, columns: Column[]) {
  if (r.date_range.end < r.date_range.start) {
    throw new ParseError("internal_validation_failed", { check: "date_range" });
  }
  // months sorted by (year, month)
  for (let i = 1; i < r.months.length; i++) {
    const a = r.months[i - 1]!, b = r.months[i]!;
    if (a.year > b.year || (a.year === b.year && a.month > b.month)) {
      throw new ParseError("internal_validation_failed", { check: "months_sorted" });
    }
  }
  // unknown_codes sorted + dedup
  for (let i = 1; i < r.unknown_codes.length; i++) {
    if (r.unknown_codes[i - 1]! >= r.unknown_codes[i]!) {
      throw new ParseError("internal_validation_failed", { check: "unknown_codes_order" });
    }
  }
  // people row length
  for (const p of r.people) {
    if (p.days.length !== columns.length) {
      throw new ParseError("internal_validation_failed", {
        check: `person ${p.name} days.length=${p.days.length} expected ${columns.length}`,
      });
    }
    for (let i = 0; i < p.days.length; i++) {
      if (p.days[i]!.date !== columnDate(columns[i]!)) {
        throw new ParseError("internal_validation_failed", {
          check: `person ${p.name} day ${i} date mismatch`,
        });
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type Bucket = { y: number; items: RawTextItem[] };

function bucketByY(items: RawTextItem[], tolerance: number): Bucket[] {
  // Sort by y descending so first bucket is the top of the page.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const buckets: Bucket[] = [];
  for (const it of sorted) {
    const b = buckets.find((bb) => Math.abs(bb.y - it.y) <= tolerance);
    if (b) b.items.push(it);
    else buckets.push({ y: it.y, items: [it] });
  }
  return buckets;
}

function maxHeight(items: RawTextItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.height), 0);
}

function columnDate(c: Column): string {
  return `${c.year.toString().padStart(4, "0")}-${pad2(c.month)}-${pad2(c.day)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
