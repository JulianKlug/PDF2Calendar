// In-memory cache + version counter for GET /api/manifest. See
// docs/v2-spec.md § Server changes / New endpoint.
//
// Only withWriteLock (src/server.ts) calls invalidate(). Reads are lock-free:
// callers either see pre-write state or post-write state, never torn, because
// invalidate() is the LAST step inside the mutex. Cache is in-process only,
// empty on boot, repopulated by the first reader after each write.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ManifestPlanInfo as PlanInfo,
  ManifestResponse,
  ManifestStaffEntry as StaffEntry,
} from "./types.ts";

export type { ManifestResponse, PlanInfo, StaffEntry };

export type ManifestCacheOpts = {
  dataDir: string;
  baseUrl: string;
  departmentSlug: string;
};

export class ManifestCache {
  private cache: ManifestResponse | null = null;
  private version = 0;

  constructor(private readonly opts: ManifestCacheOpts) {}

  invalidate(): void {
    this.cache = null;
    this.version += 1;
  }

  getVersion(): number {
    return this.version;
  }

  async get(): Promise<ManifestResponse> {
    if (this.cache !== null) return this.cache;
    this.cache = await this.scan();
    return this.cache;
  }

  private async scan(): Promise<ManifestResponse> {
    const plansDir = join(this.opts.dataDir, "plans");
    const manifestDir = join(this.opts.dataDir, "manifest");

    const plans = await this.scanPlans(plansDir);
    plans.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    const latest_plan = plans[0] ?? null;

    const staff = await this.scanStaff(manifestDir);
    staff.sort((a, b) => a.name.localeCompare(b.name));

    return {
      schema_version: 2,
      department_slug: this.opts.departmentSlug,
      latest_plan,
      plans,
      staff,
    };
  }

  private async scanPlans(plansDir: string): Promise<PlanInfo[]> {
    const out: PlanInfo[] = [];
    const files = await safeReaddir(plansDir);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const path = join(plansDir, f);
      const parsed = await safeReadJson(path);
      if (parsed === null) continue;
      if (!isValidPlanFile(parsed)) continue;
      out.push({
        pdf_sha256: parsed.pdf_sha256,
        original_filename: parsed.original_filename,
        uploaded_at: parsed.uploaded_at,
        months: parsed.months,
      });
    }
    return out;
  }

  private async scanStaff(manifestDir: string): Promise<StaffEntry[]> {
    const out: StaffEntry[] = [];
    const files = await safeReaddir(manifestDir);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const path = join(manifestDir, f);
      const parsed = await safeReadJson(path);
      if (parsed === null) continue;
      // V1-shaped manifests (no schema_version, no entries[]) are silently
      // skipped — their feeds still serve from nginx unchanged.
      if (!isValidV2Manifest(parsed)) continue;
      const person_hash = f.slice(0, -".json".length);
      out.push({
        person_hash,
        name: parsed.name,
        role: parsed.role,
        feed_url: `${this.opts.baseUrl}/feed/${person_hash}.ics`,
        entries: parsed.entries.map((e) => ({
          pdf_sha256: e.pdf_sha256,
          original_filename: e.original_filename,
          uploaded_at: e.uploaded_at,
          months: e.months,
          row_url: `${this.opts.baseUrl}/source/${e.pdf_sha256}/${person_hash}.png`,
        })),
      });
    }
    return out;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text);
  } catch (e) {
    console.warn(`manifest-cache: skipped ${path} (${(e as Error).message})`);
    return null;
  }
}

type RawPlanFile = {
  schema_version: 2;
  pdf_sha256: string;
  original_filename: string;
  uploaded_at: string;
  months: Array<{ year: number; month: number; days_covered: number[] }>;
  person_hashes: string[];
};

function isValidPlanFile(v: unknown): v is RawPlanFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schema_version === 2 &&
    typeof o.pdf_sha256 === "string" &&
    typeof o.original_filename === "string" &&
    typeof o.uploaded_at === "string" &&
    Array.isArray(o.months) &&
    Array.isArray(o.person_hashes)
  );
}

type RawV2Manifest = {
  schema_version: 2;
  name: string;
  role: string;
  entries: Array<{
    pdf_sha256: string;
    original_filename: string;
    uploaded_at: string;
    months: Array<{ year: number; month: number }>;
  }>;
};

function isValidV2Manifest(v: unknown): v is RawV2Manifest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.schema_version !== 2) return false;
  if (typeof o.name !== "string" || typeof o.role !== "string") return false;
  if (!Array.isArray(o.entries) || o.entries.length === 0) return false;
  return true;
}
