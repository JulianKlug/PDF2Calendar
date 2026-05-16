// iCalendar generator. Pure function: same input → same byte-for-byte output.
// Spec: docs/ics-spec.md.

import type { Code } from "./codes.ts";
import type { ParsedDay } from "./types.ts";

export type { Code } from "./codes.ts";

export type GenerateInput = {
  person: { days: ParsedDay[] };
  person_hash: string;
  codes: Record<string, Code>;
  // Default true. When true, codes prefixed with `°` or `*` strip the prefix
  // for lookup and emit STATUS:TENTATIVE.
  emit_tentative_for_prefixes?: boolean;
  source: {
    file_name: string;
    uploaded_at: Date;
    pdf_sha256: string;
    base_url: string;
  };
  tombstones?: Array<{ date: string; seq: number }>;
};

export type IcsErrorCode =
  | "invalid_person_hash"
  | "invalid_pdf_sha256"
  | "invalid_base_url"
  | "invalid_time_format";

export class IcsError extends Error {
  constructor(public code: IcsErrorCode, public detail?: unknown) {
    super(`${code}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "IcsError";
  }
}

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const TENTATIVE_PREFIX = /^[°*]/;

const VTIMEZONE_BLOCK = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Zurich",
  "X-LIC-LOCATION:Europe/Zurich",
  "BEGIN:STANDARD",
  "DTSTART:19961027T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19810329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

type InternalEvent = {
  uid: string;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  summary: string;
  sort_key: string;
  dtstart_line: string;
  dtend_line: string;
};

const encoder = new TextEncoder();

function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function ymdCompact(date: string): string {
  return date.slice(0, 4) + date.slice(5, 7) + date.slice(8, 10);
}

function hms(t: string): string {
  return t.slice(0, 2) + t.slice(3, 5) + "00";
}

function nextDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return (
    d.getUTCFullYear() +
    "-" +
    pad2(d.getUTCMonth() + 1) +
    "-" +
    pad2(d.getUTCDate())
  );
}

function dtstampUtc(d: Date): string {
  return (
    d.getUTCFullYear() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "T" +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z"
  );
}

function uploadedHuman(d: Date): string {
  return (
    d.getUTCFullYear() +
    "-" +
    pad2(d.getUTCMonth() + 1) +
    "-" +
    pad2(d.getUTCDate()) +
    " " +
    pad2(d.getUTCHours()) +
    ":" +
    pad2(d.getUTCMinutes())
  );
}

// RFC 5545 §3.3.11: backslash first, then `;` `,`; real LF → literal `\n`;
// real CR is dropped.
function escapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") out += "\\\\";
    else if (ch === ";") out += "\\;";
    else if (ch === ",") out += "\\,";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") continue;
    else out += ch;
  }
  return out;
}

// RFC 5545 §3.1: lines > 75 octets are folded with CRLF + single space.
// The continuation space counts toward the next line's 75-octet limit, so
// continuation payload caps at 74 bytes. Walks codepoints (Array.from)
// rather than UTF-16 chars so surrogate pairs cannot be split.
function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const cps = Array.from(line);
  const pieces: string[] = [];
  let buf = "";
  let bufBytes = 0;
  let isFirst = true;
  for (const cp of cps) {
    const cpBytes = encoder.encode(cp).length;
    const limit = isFirst ? 75 : 74;
    if (bufBytes + cpBytes > limit) {
      pieces.push(buf);
      buf = cp;
      bufBytes = cpBytes;
      isFirst = false;
    } else {
      buf += cp;
      bufBytes += cpBytes;
    }
  }
  if (buf) pieces.push(buf);
  return pieces[0] + pieces.slice(1).map((p) => "\r\n " + p).join("");
}

export function generate(input: GenerateInput): string {
  const { person, person_hash, codes, source, tombstones = [] } = input;
  const emitTentative = input.emit_tentative_for_prefixes !== false;

  if (!HEX_16.test(person_hash)) {
    throw new IcsError("invalid_person_hash", { person_hash });
  }
  if (!HEX_64.test(source.pdf_sha256)) {
    throw new IcsError("invalid_pdf_sha256", { pdf_sha256: source.pdf_sha256 });
  }
  if (!/^https?:\/\//.test(source.base_url) || source.base_url.endsWith("/")) {
    throw new IcsError("invalid_base_url", { base_url: source.base_url });
  }
  for (const [key, code] of Object.entries(codes)) {
    if (code.kind === "timed") {
      if (!TIME_RE.test(code.start) || !TIME_RE.test(code.end)) {
        throw new IcsError("invalid_time_format", {
          code: key,
          start: code.start,
          end: code.end,
        });
      }
    }
  }

  const dtstamp = dtstampUtc(source.uploaded_at);
  const uploaded = uploadedHuman(source.uploaded_at);
  const descriptionRaw =
    `Source: ${source.file_name}\n` +
    `Uploaded: ${uploaded} UTC\n` +
    `View your row: ${source.base_url}/source/${source.pdf_sha256}/${person_hash}.png`;
  const descriptionEscaped = escapeText(descriptionRaw);

  const events: InternalEvent[] = [];

  for (const day of person.days) {
    if (day.codes.length === 0) continue;
    for (let seq = 0; seq < day.codes.length; seq++) {
      const codeStr = day.codes[seq]!;
      let tentative = false;
      let lookupKey = codeStr;
      if (emitTentative && TENTATIVE_PREFIX.test(codeStr)) {
        tentative = true;
        lookupKey = codeStr.slice(1);
      }
      let code: Code | undefined = codes[lookupKey];
      if (!code) {
        code = { kind: "allday", title: "Unknown: " + codeStr };
        tentative = true;
      }
      if (code.kind === "skip") continue;

      const uidDay = ymdCompact(day.date);
      const uid = `${person_hash}-${uidDay}-${seq}@pdf2calendar`;
      const status = tentative ? "TENTATIVE" : "CONFIRMED";
      const summary = escapeText(code.title);

      if (code.kind === "allday") {
        const endDate = nextDay(day.date);
        events.push({
          uid,
          status,
          summary,
          sort_key: ymdCompact(day.date),
          dtstart_line: `DTSTART;VALUE=DATE:${ymdCompact(day.date)}`,
          dtend_line: `DTEND;VALUE=DATE:${ymdCompact(endDate)}`,
        });
      } else {
        const startCompact = ymdCompact(day.date) + "T" + hms(code.start);
        const sameDay = code.end > code.start;
        const endDate = sameDay ? day.date : nextDay(day.date);
        const endCompact = ymdCompact(endDate) + "T" + hms(code.end);
        events.push({
          uid,
          status,
          summary,
          sort_key: startCompact,
          dtstart_line: `DTSTART;TZID=Europe/Zurich:${startCompact}`,
          dtend_line: `DTEND;TZID=Europe/Zurich:${endCompact}`,
        });
      }
    }
  }

  for (const t of tombstones) {
    const uidDay = ymdCompact(t.date);
    const uid = `${person_hash}-${uidDay}-${t.seq}@pdf2calendar`;
    const endDate = nextDay(t.date);
    events.push({
      uid,
      status: "CANCELLED",
      summary: "(cancelled)",
      sort_key: ymdCompact(t.date),
      dtstart_line: `DTSTART;VALUE=DATE:${ymdCompact(t.date)}`,
      dtend_line: `DTEND;VALUE=DATE:${ymdCompact(endDate)}`,
    });
  }

  events.sort((a, b) => {
    if (a.sort_key < b.sort_key) return -1;
    if (a.sort_key > b.sort_key) return 1;
    if (a.uid < b.uid) return -1;
    if (a.uid > b.uid) return 1;
    return 0;
  });

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//pdf2calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...VTIMEZONE_BLOCK,
  ];

  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${dtstamp}`,
      ev.dtstart_line,
      ev.dtend_line,
      `SUMMARY:${ev.summary}`,
      `DESCRIPTION:${descriptionEscaped}`,
      `STATUS:${ev.status}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return lines.map(fold).join("\r\n") + "\r\n";
}

// Multi-month merge: splice VEVENTs from `existing` that fall OUTSIDE
// `drop_range` into the freshly generated VCALENDAR. See docs/server-spec.md
// § Multi-month merge.
//
// `drop_range` is the new upload's `date_range`: VEVENTs from `existing`
// whose DTSTART falls within it are dropped (the fresh upload supersedes
// them); VEVENTs outside it are preserved verbatim, including any legacy
// `STATUS:CANCELLED` tombstones from pre-2026-05-15 builds.
//
// Malformed `existing` (missing END:VCALENDAR, unbalanced BEGIN/END:VEVENT)
// is non-fatal: the function logs a warning and returns `freshIcs` unchanged.
// A single VEVENT block with an unrecognized DTSTART form is dropped (with
// a log line) and the rest of the merge proceeds.
export function mergeIcs(
  existing: string | null,
  freshInput: GenerateInput,
  drop_range: { start: string; end: string },
): string {
  const freshIcs = generate(freshInput);

  if (existing === null || existing === "") return freshIcs;

  const lines = existing.split("\r\n");
  const beginCount = lines.reduce((n, l) => (l === "BEGIN:VEVENT" ? n + 1 : n), 0);
  const endCount = lines.reduce((n, l) => (l === "END:VEVENT" ? n + 1 : n), 0);

  if (beginCount === 0) return freshIcs;

  if (!existing.includes("END:VCALENDAR") || beginCount !== endCount) {
    console.warn(
      `mergeIcs: existing .ics for ${freshInput.person_hash} is malformed — falling back to fresh-only`,
    );
    return freshIcs;
  }

  const existingBlocks = extractVeventBlocks(existing);
  const kept: Array<{ block: string; sortKey: string; uid: string }> = [];
  for (const block of existingBlocks) {
    const meta = extractDtstartMeta(block);
    if (meta === null) {
      console.warn(
        `mergeIcs: dropping block with unexpected DTSTART for ${freshInput.person_hash}`,
      );
      continue;
    }
    if (meta.date >= drop_range.start && meta.date <= drop_range.end) continue;
    kept.push({ block, sortKey: meta.sortKey, uid: extractUid(block) });
  }

  const freshBlocks = extractVeventBlocks(freshIcs);
  const fresh: Array<{ block: string; sortKey: string; uid: string }> = [];
  for (const block of freshBlocks) {
    const meta = extractDtstartMeta(block);
    // generate() output always has a well-formed DTSTART; the `!` is safe.
    fresh.push({ block, sortKey: meta!.sortKey, uid: extractUid(block) });
  }

  const merged = [...kept, ...fresh].sort((a, b) => {
    if (a.sortKey < b.sortKey) return -1;
    if (a.sortKey > b.sortKey) return 1;
    if (a.uid < b.uid) return -1;
    if (a.uid > b.uid) return 1;
    return 0;
  });

  // Reuse freshIcs's header (BEGIN:VCALENDAR through END:VTIMEZONE) to keep
  // the preamble byte-exact with generate().
  const endVCalIdx = freshIcs.lastIndexOf("END:VCALENDAR\r\n");
  let preamble = freshIcs.slice(0, endVCalIdx);
  const firstVeventIdx = preamble.indexOf("BEGIN:VEVENT");
  if (firstVeventIdx >= 0) preamble = preamble.slice(0, firstVeventIdx);

  if (merged.length === 0) return preamble + "END:VCALENDAR\r\n";
  return (
    preamble +
    merged.map((m) => m.block).join("\r\n") +
    "\r\n" +
    "END:VCALENDAR\r\n"
  );
}

function extractVeventBlocks(ics: string): string[] {
  const blocks: string[] = [];
  const lines = ics.split("\r\n");
  let buf: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      buf = [line];
    } else if (line === "END:VEVENT" && buf !== null) {
      buf.push(line);
      blocks.push(buf.join("\r\n"));
      buf = null;
    } else if (buf !== null) {
      buf.push(line);
    }
  }
  return blocks;
}

const DTSTART_TIMED_RE = /^DTSTART;TZID=Europe\/Zurich:(\d{8})(T\d{6})$/;
const DTSTART_ALLDAY_RE = /^DTSTART;VALUE=DATE:(\d{8})$/;

function extractDtstartMeta(block: string): { date: string; sortKey: string } | null {
  for (const line of block.split("\r\n")) {
    if (!line.startsWith("DTSTART")) continue;
    const t = line.match(DTSTART_TIMED_RE);
    if (t) {
      const ymd = t[1]!;
      return {
        date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        sortKey: ymd + t[2]!,
      };
    }
    const a = line.match(DTSTART_ALLDAY_RE);
    if (a) {
      const ymd = a[1]!;
      return {
        date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        sortKey: ymd,
      };
    }
    return null;
  }
  return null;
}

function extractUid(block: string): string {
  const m = block.match(/\r\nUID:([^\r\n]+)/);
  return m ? m[1]! : "";
}
