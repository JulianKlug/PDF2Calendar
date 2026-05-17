// pdf2calendar V1 server. See docs/server-spec.md.
//
// One Bun process: receives multipart uploads at POST /api/upload, validates
// every claim, persists per-person .ics + manifest + row PNG + source PDF
// under PDF2CAL_DATA_DIR, and returns webcal:// URLs. nginx serves the .ics
// and the row PNGs as static files; Bun is never in the read path.

import type {
  UploadPayload,
  UploadResponse,
  UploadResponseFeed,
} from "../web/api.ts";
import { isKnownCode, codes as V1_CODES_TABLE } from "./codes.ts";
import { mergeIcs, type GenerateInput } from "./ics.ts";
import { ManifestCache } from "./manifest-cache.ts";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

// ─── env ──────────────────────────────────────────────────────────────────

export type Env = {
  port: number;
  dataDir: string;
  baseUrl: string;
  departmentSlug: string;
  maxUploadBytes: number;
};

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const dataDir = source.PDF2CAL_DATA_DIR;
  if (!dataDir) die("PDF2CAL_DATA_DIR is required");

  const baseUrl = source.PDF2CAL_BASE_URL;
  if (!baseUrl) die("PDF2CAL_BASE_URL is required");
  if (!/^https?:\/\//.test(baseUrl)) die("PDF2CAL_BASE_URL must start with http:// or https://");
  if (baseUrl.endsWith("/")) die("PDF2CAL_BASE_URL must not have a trailing slash");

  const departmentSlug = source.PDF2CAL_DEPARTMENT_SLUG;
  if (!departmentSlug) die("PDF2CAL_DEPARTMENT_SLUG is required");

  const port = source.PDF2CAL_PORT ? Number(source.PDF2CAL_PORT) : 3001;
  if (!Number.isFinite(port) || port <= 0) die(`PDF2CAL_PORT invalid: ${source.PDF2CAL_PORT}`);

  const maxUploadBytes = source.PDF2CAL_MAX_UPLOAD_BYTES
    ? Number(source.PDF2CAL_MAX_UPLOAD_BYTES)
    : 10 * 1024 * 1024;
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) {
    die(`PDF2CAL_MAX_UPLOAD_BYTES invalid: ${source.PDF2CAL_MAX_UPLOAD_BYTES}`);
  }

  return { port, dataDir: dataDir!, baseUrl: baseUrl!, departmentSlug: departmentSlug!, maxUploadBytes };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ─── filesystem layout ────────────────────────────────────────────────────

function dirs(env: Env) {
  return {
    feeds: join(env.dataDir, "feeds"),
    manifest: join(env.dataDir, "manifest"),
    sources: join(env.dataDir, "sources"),
    rows: join(env.dataDir, "rows"),
    plans: join(env.dataDir, "plans"),
    unknownLog: join(env.dataDir, "unknown-codes.log"),
  };
}

export async function bootstrap(env: Env): Promise<void> {
  const d = dirs(env);
  for (const p of [d.feeds, d.manifest, d.sources, d.rows, d.plans]) {
    try {
      await mkdir(p, { recursive: true });
    } catch (e) {
      die(`cannot create ${p}: ${(e as Error).message}`);
    }
  }
}

export async function orphanSweep(env: Env): Promise<number> {
  const d = dirs(env);
  let count = 0;
  for (const root of [d.feeds, d.manifest]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".tmp")) continue;
      try {
        await unlink(join(root, name));
        count++;
      } catch {
        // ignore — a parallel sweep might have raced us
      }
    }
  }
  if (count > 0) console.error(`orphan sweep: removed ${count} .tmp file(s)`);
  return count;
}

// ─── normalize + personHash (byte-identical to web/person-hash.ts) ────────

export function normalize(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

export async function personHash(department: string, name: string): Promise<string> {
  const input = `${department}|${normalize(name)}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast: TS's DOM lib narrows BufferSource to ArrayBufferView<ArrayBuffer>
  // but Uint8Array<ArrayBufferLike> is runtime-compatible. Same trick as
  // web/api.ts and web/pdf-hash.ts.
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toWebcalUrl(baseUrl: string, personHash: string): string {
  const rest = baseUrl.startsWith("https://")
    ? baseUrl.slice("https://".length)
    : baseUrl.slice("http://".length);
  return `webcal://${rest}/feed/${personHash}.ics`;
}

// ─── atomic writes ────────────────────────────────────────────────────────

async function atomicWrite(finalPath: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = finalPath + ".tmp";
  await writeFile(tmp, bytes);
  await rename(tmp, finalPath);
}

async function existsFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ─── in-process write mutex ───────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => (release = r));
  return (async () => {
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  })();
}

// ─── validation ───────────────────────────────────────────────────────────

export class BadRequest extends Error {
  constructor(public code: string, public detail: string) {
    super(detail);
    this.name = "BadRequest";
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validatePayload(json: unknown): UploadPayload {
  if (typeof json !== "object" || json === null) {
    throw new BadRequest("schema", "payload is not an object");
  }
  const p = json as Record<string, unknown>;
  if (!isString(p.department)) throw new BadRequest("schema", "department missing or not a string");
  if (!isString(p.pdf_sha256) || !HEX_64.test(p.pdf_sha256))
    throw new BadRequest("schema", "pdf_sha256 must be 64 lowercase hex");
  if (!isString(p.source_file_name))
    throw new BadRequest("schema", "source_file_name missing or not a string");

  const dr = p.date_range as Record<string, unknown> | undefined;
  if (!dr || !isString(dr.start) || !isString(dr.end) || !DATE_RE.test(dr.start) || !DATE_RE.test(dr.end))
    throw new BadRequest("schema", "date_range.{start,end} must be YYYY-MM-DD");
  if (dr.end < dr.start) throw new BadRequest("schema", "date_range.end must be >= start");

  if (!Array.isArray(p.months)) throw new BadRequest("schema", "months must be an array");
  if (p.months.length < 1 || p.months.length > 2)
    throw new BadRequest("schema", `months.length must be 1 or 2, got ${p.months.length}`);
  for (let i = 0; i < p.months.length; i++) {
    const m = p.months[i] as Record<string, unknown>;
    if (!isNumber(m.year) || !isNumber(m.month) || !Array.isArray(m.days_covered))
      throw new BadRequest("schema", `months[${i}] malformed`);
    for (const d of m.days_covered as unknown[]) {
      if (!isNumber(d)) throw new BadRequest("schema", `months[${i}].days_covered must be numbers`);
    }
  }

  if (!Array.isArray(p.people)) throw new BadRequest("schema", "people must be an array");
  if (p.people.length < 1) throw new BadRequest("schema", "people must be non-empty");

  const expectedDays = (p.months as Array<{ days_covered: number[] }>).reduce(
    (sum, m) => sum + m.days_covered.length,
    0,
  );

  for (let i = 0; i < p.people.length; i++) {
    const person = p.people[i] as Record<string, unknown>;
    if (!isString(person.role)) throw new BadRequest("schema", `people[${i}].role missing`);
    if (!isString(person.name)) throw new BadRequest("schema", `people[${i}].name missing`);
    if (!isString(person.person_hash) || !HEX_16.test(person.person_hash))
      throw new BadRequest("schema", `people[${i}].person_hash must be 16 lowercase hex`);
    if (!Array.isArray(person.days))
      throw new BadRequest("schema", `people[${i}].days must be an array`);
    if (person.days.length !== expectedDays)
      throw new BadRequest(
        "schema",
        `people[${i}].days.length=${person.days.length} != months days_covered sum=${expectedDays}`,
      );
    for (let j = 0; j < person.days.length; j++) {
      const day = person.days[j] as Record<string, unknown>;
      if (!isString(day.date) || !DATE_RE.test(day.date))
        throw new BadRequest("schema", `people[${i}].days[${j}].date must be YYYY-MM-DD`);
      if (day.date < dr.start || day.date > dr.end)
        throw new BadRequest(
          "schema",
          `people[${i}].days[${j}].date=${day.date} outside date_range`,
        );
      if (!Array.isArray(day.codes))
        throw new BadRequest("schema", `people[${i}].days[${j}].codes must be an array`);
      for (const c of day.codes as unknown[]) {
        if (!isString(c))
          throw new BadRequest("schema", `people[${i}].days[${j}].codes must be strings`);
      }
    }
  }

  return p as unknown as UploadPayload;
}

// ─── per-request flow ─────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function manifestResponse(cache: ManifestCache): Promise<Response> {
  const body = await cache.get();
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(status: number, error: string, code?: string): Response {
  const body: { error: string; code?: string } = { error };
  if (code) body.code = code;
  return jsonResponse(status, body);
}

async function handleUpload(req: Request, env: Env): Promise<Response> {
  // Step 1 — parse multipart
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    return errorResponse(415, "Content-Type must be multipart/form-data");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return errorResponse(400, `multipart parse failed: ${(e as Error).message}`, "schema");
  }

  const payloadPart = form.get("payload");
  const pdfPart = form.get("pdf");
  if (!payloadPart) return errorResponse(400, "payload part missing", "missing_part");
  if (!pdfPart) return errorResponse(400, "pdf part missing", "missing_part");
  if (typeof pdfPart === "string") return errorResponse(400, "pdf part must be a file", "missing_part");
  if (pdfPart.type !== "application/pdf")
    return errorResponse(415, `pdf part has Content-Type ${pdfPart.type}, expected application/pdf`);

  const rowParts = new Map<string, File>();
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("row_")) continue;
    const hash = key.slice("row_".length);
    if (!HEX_16.test(hash))
      return errorResponse(
        400,
        `row part key suffix must be 16 lowercase hex`,
        "missing_part",
      );
    if (typeof value === "string")
      return errorResponse(400, `${key} part must be a file`, "missing_part");
    const file = value as File;
    if (file.type !== "image/png")
      return errorResponse(415, `${key} part has Content-Type ${file.type}, expected image/png`);
    rowParts.set(hash, file);
  }

  // Step 2 — validate payload JSON
  let payload: UploadPayload;
  try {
    const payloadText =
      typeof payloadPart === "string" ? payloadPart : await (payloadPart as File).text();
    const parsed = JSON.parse(payloadText) as unknown;
    payload = validatePayload(parsed);
  } catch (e) {
    if (e instanceof BadRequest) return errorResponse(400, e.detail, e.code);
    return errorResponse(400, `payload JSON parse failed: ${(e as Error).message}`, "schema");
  }

  // Step 3 — verify PDF bytes
  const pdfBytes = new Uint8Array(await pdfPart.arrayBuffer());
  const actualPdfSha = await sha256Hex(pdfBytes);
  if (actualPdfSha !== payload.pdf_sha256) {
    return errorResponse(
      400,
      `pdf_sha256 mismatch: payload=${payload.pdf_sha256} actual=${actualPdfSha}`,
      "pdf_hash_mismatch",
    );
  }

  // Step 4 — verify department
  if (payload.department !== env.departmentSlug) {
    return errorResponse(
      400,
      `department mismatch: payload=${payload.department} server=${env.departmentSlug}`,
      "department_mismatch",
    );
  }

  // Step 5 — verify person_hashes + row bijection + no collisions
  const seenHashes = new Map<string, string>(); // expected_hash → name
  for (const person of payload.people) {
    const expected = await personHash(payload.department, person.name);
    if (expected !== person.person_hash) {
      return errorResponse(
        400,
        `person_hash mismatch for ${person.name}: payload=${person.person_hash} server=${expected}`,
        "hash_mismatch",
      );
    }
    if (seenHashes.has(expected)) {
      return errorResponse(
        400,
        `Two persons normalize to the same hash: ${seenHashes.get(expected)} and ${person.name}`,
        "hash_collision",
      );
    }
    seenHashes.set(expected, person.name);
    if (!rowParts.has(expected)) {
      return errorResponse(400, `row_${expected} part missing for ${person.name}`, "missing_part");
    }
  }
  // Orphan row check: every row_<hash> must map to a person.
  for (const hash of rowParts.keys()) {
    if (!seenHashes.has(hash)) {
      return errorResponse(400, `orphan row_${hash} part (no matching person)`, "missing_part");
    }
  }

  // Pre-compute unknown_codes (pure — no I/O needed).
  const unknown = new Set<string>();
  const unknownLines: string[] = [];
  const tsIso = new Date().toISOString();
  for (const person of payload.people) {
    for (const day of person.days) {
      for (const code of day.codes) {
        if (!isKnownCode(code)) {
          unknown.add(code);
          unknownLines.push(`${tsIso}\t${code}\t${person.person_hash}\t${day.date}`);
        }
      }
    }
  }

  // Steps 6–9 — write phase under the mutex
  const uploadedAt = new Date();
  await withWriteLock(async () => {
    const d = dirs(env);

    // Step 7 — sources & row PNGs
    const sourcePath = join(d.sources, `${payload.pdf_sha256}.pdf`);
    if (!(await existsFile(sourcePath))) await atomicWrite(sourcePath, pdfBytes);

    const rowsDir = join(d.rows, payload.pdf_sha256);
    await mkdir(rowsDir, { recursive: true });
    for (const person of payload.people) {
      const target = join(rowsDir, `${person.person_hash}.png`);
      if (await existsFile(target)) continue;
      const rowFile = rowParts.get(person.person_hash)!;
      const rowBytes = new Uint8Array(await rowFile.arrayBuffer());
      await atomicWrite(target, rowBytes);
    }

    // Step 8 — per-person .ics + manifest
    for (const person of payload.people) {
      const feedPath = join(d.feeds, `${person.person_hash}.ics`);
      let existing: string | null = null;
      try {
        existing = await readFile(feedPath, "utf-8");
      } catch {
        existing = null;
      }

      const freshInput: GenerateInput = {
        person: { days: person.days },
        person_hash: person.person_hash,
        codes: V1_CODES_TABLE,
        source: {
          file_name: payload.source_file_name,
          uploaded_at: uploadedAt,
          pdf_sha256: payload.pdf_sha256,
          base_url: env.baseUrl,
        },
      };

      const merged = mergeIcs(existing, freshInput, payload.date_range);
      try {
        await atomicWrite(feedPath, merged);
      } catch (e) {
        throw new WriteFailure(
          `feed write failed for ${person.person_hash}: ${(e as Error).message}`,
        );
      }

      // Manifest is best-effort — never converts to a 500. See spec § Step 8.4.
      const manifest = {
        name: person.name,
        role: person.role,
        last_uploaded_at: uploadedAt.toISOString(),
        last_pdf_sha256: payload.pdf_sha256,
        last_date_range: payload.date_range,
      };
      try {
        await atomicWrite(
          join(d.manifest, `${person.person_hash}.json`),
          JSON.stringify(manifest, null, 2) + "\n",
        );
      } catch (e) {
        console.error(`manifest write failed for ${person.person_hash}: ${(e as Error).message}`);
      }
    }

    // unknown-codes.log append, inside the mutex so concurrent uploads can't
    // interleave torn lines (POSIX O_APPEND atomicity caps at PIPE_BUF).
    if (unknownLines.length > 0) {
      try {
        await appendFile(dirs(env).unknownLog, unknownLines.join("\n") + "\n");
      } catch (e) {
        console.error(`unknown-codes.log append failed: ${(e as Error).message}`);
      }
    }
  });

  // Step 10 — response

  const feeds: UploadResponseFeed[] = payload.people.map((p) => ({
    name: p.name,
    role: p.role,
    person_hash: p.person_hash,
    webcal_url: toWebcalUrl(env.baseUrl, p.person_hash),
  }));
  const body: UploadResponse = {
    feeds,
    unknown_codes: Array.from(unknown).sort(),
  };
  return jsonResponse(200, body);
}

class WriteFailure extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WriteFailure";
  }
}

// ─── server factory ───────────────────────────────────────────────────────

export type ServerLike = { port: number; stop: (closeActiveConnections?: boolean) => void };

export function createServer(env: Env): ServerLike {
  const cache = new ManifestCache({
    dataDir: env.dataDir,
    baseUrl: env.baseUrl,
    departmentSlug: env.departmentSlug,
  });

  const handler = async (req: Request): Promise<Response> => {
    const start = Date.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        res = jsonResponse(200, { ok: true });
      } else if (req.method === "GET" && url.pathname === "/api/manifest") {
        res = await manifestResponse(cache);
      } else if (req.method === "POST" && url.pathname === "/api/upload") {
        res = await handleUpload(req, env);
      } else {
        res = errorResponse(404, "not found");
      }
    } catch (e) {
      if (e instanceof WriteFailure) {
        console.error(`write_failure: ${e.message}`);
        res = errorResponse(500, e.message, "write_failure");
      } else {
        console.error(`internal_error: ${(e as Error).stack ?? (e as Error).message}`);
        res = errorResponse(500, "internal error", "internal_error");
      }
    }
    const dur = Date.now() - start;
    console.error(
      `${new Date().toISOString()} INFO ${req.method} ${url.pathname} ${res.status} ${dur}ms`,
    );
    return res;
  };

  // @ts-expect-error — Bun global is provided at runtime
  return Bun.serve({
    port: env.port,
    maxRequestBodySize: env.maxUploadBytes,
    fetch: handler,
    error(e: Error) {
      // Per spec § Failure modes: 413 is emitted by Bun automatically when
      // the body exceeds maxRequestBodySize. This handler catches anything
      // Bun throws before our `fetch` runs.
      console.error(`server error: ${e.message}`);
      return errorResponse(500, "internal error", "internal_error");
    },
  });
}

// ─── entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const env = readEnv();
  await bootstrap(env);
  await orphanSweep(env);
  try {
    const server = createServer(env);
    console.error(
      `pdf2calendar listening on :${server.port} (data=${env.dataDir}, base=${env.baseUrl}, dept=${env.departmentSlug})`,
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("EADDRINUSE")) {
      die(`port ${env.port} in use — set PDF2CAL_PORT or stop the other process`);
    }
    die(`server startup failed: ${msg}`);
  }
}
