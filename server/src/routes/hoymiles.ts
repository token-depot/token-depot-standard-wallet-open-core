import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type HoymilesCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  readWalletStore: (repoRootPath: string, userId: string) => any;

  requireMainnetLicenseOrReject: (args: {
    networkId: "mainnet" | "testnet-10";
    userId: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; status: number; reason: string; tick: string; ca: string; error?: string }
  >;
};

export type HoymilesProductionStatsCallResult =
  | { ok: true; payload: any }
  | { ok: false; status: number; body: any };

type HoymilesRateLimitHit = {
  at: string;
  endpoint: string;
};

type HoymilesRateLimitMonthBucket = {
  total_hits: number;
  by_endpoint: Record<string, number>;
  first_hit_at: string | null;
  last_hit_at: string | null;
  last_success_at_by_endpoint: Record<string, string>;
};

type HoymilesRateLimitDb = {
  version: 2;
  minute_window: {
    hits: HoymilesRateLimitHit[];
  };
  months: Record<string, HoymilesRateLimitMonthBucket>;
};

function rlPath(repoRoot: string): string {
  return path.join(repoRoot, "data", "hoymiles-rate-limit.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeParseJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function currentMonthUtcYm(): string {
  return new Date().toISOString().slice(0, 7);
}

function rlDefault(): HoymilesRateLimitDb {
  return {
    version: 2,
    minute_window: { hits: [] },
    months: {}
  };
}

function normalizeMinuteHits(input: unknown): HoymilesRateLimitHit[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const at = String((row as any).at || "").trim();
      const endpoint = String((row as any).endpoint || "").trim();
      if (!at || !endpoint) return null;
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) return null;
      return { at, endpoint };
    })
    .filter((row): row is HoymilesRateLimitHit => !!row)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function normalizeMonthBucket(input: unknown): HoymilesRateLimitMonthBucket {
  const total_hits = Math.max(0, Number((input as any)?.total_hits || 0) || 0);
  const byEndpointRaw = (input as any)?.by_endpoint;
  const by_endpoint: Record<string, number> = {};
  if (byEndpointRaw && typeof byEndpointRaw === "object") {
    for (const [endpoint, value] of Object.entries(byEndpointRaw)) {
      const key = String(endpoint || "").trim();
      if (!key) continue;
      by_endpoint[key] = Math.max(0, Number(value || 0) || 0);
    }
  }

  const successRaw = (input as any)?.last_success_at_by_endpoint;
  const last_success_at_by_endpoint: Record<string, string> = {};
  if (successRaw && typeof successRaw === "object") {
    for (const [endpoint, value] of Object.entries(successRaw)) {
      const key = String(endpoint || "").trim();
      const at = String(value || "").trim();
      if (!key || !at) continue;
      if (!Number.isFinite(Date.parse(at))) continue;
      last_success_at_by_endpoint[key] = at;
    }
  }

  const first_hit_at = String((input as any)?.first_hit_at || "").trim();
  const last_hit_at = String((input as any)?.last_hit_at || "").trim();

  return {
    total_hits,
    by_endpoint,
    first_hit_at: Number.isFinite(Date.parse(first_hit_at)) ? first_hit_at : null,
    last_hit_at: Number.isFinite(Date.parse(last_hit_at)) ? last_hit_at : null,
    last_success_at_by_endpoint
  };
}

function legacyDaysToMonths(daysRaw: unknown): Record<string, HoymilesRateLimitMonthBucket> {
  const months: Record<string, HoymilesRateLimitMonthBucket> = {};
  if (!daysRaw || typeof daysRaw !== "object") return months;

  for (const [dayKey, bucketRaw] of Object.entries(daysRaw)) {
    const day = String(dayKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!bucketRaw || typeof bucketRaw !== "object") continue;

    const ym = day.slice(0, 7);
    if (!months[ym]) {
      months[ym] = {
        total_hits: 0,
        by_endpoint: {},
        first_hit_at: null,
        last_hit_at: null,
        last_success_at_by_endpoint: {}
      };
    }

    const monthBucket = months[ym];

    for (const entryRaw of Object.values(bucketRaw)) {
      if (!entryRaw || typeof entryRaw !== "object") continue;

      const attempts = Math.max(0, Number((entryRaw as any).attempts || 0) || 0);
      const endpoint = "production_stats";
      if (attempts > 0) {
        monthBucket.total_hits += attempts;
        monthBucket.by_endpoint[endpoint] = Math.max(0, Number(monthBucket.by_endpoint[endpoint] || 0) || 0) + attempts;
      }

      const firstAt = String((entryRaw as any).firstAt || "").trim();
      const lastAt = String((entryRaw as any).lastAt || "").trim();
      const successAt = String((entryRaw as any).successAt || "").trim();

      if (Number.isFinite(Date.parse(firstAt))) {
        if (!monthBucket.first_hit_at || Date.parse(firstAt) < Date.parse(monthBucket.first_hit_at)) {
          monthBucket.first_hit_at = firstAt;
        }
      }

      if (Number.isFinite(Date.parse(lastAt))) {
        if (!monthBucket.last_hit_at || Date.parse(lastAt) > Date.parse(monthBucket.last_hit_at)) {
          monthBucket.last_hit_at = lastAt;
        }
      }

      if (Number.isFinite(Date.parse(successAt))) {
        const prior = String(monthBucket.last_success_at_by_endpoint[endpoint] || "").trim();
        if (!prior || Date.parse(successAt) > Date.parse(prior)) {
          monthBucket.last_success_at_by_endpoint[endpoint] = successAt;
        }
      }
    }
  }

  return months;
}

function normalizeMonthsMap(input: unknown): Record<string, HoymilesRateLimitMonthBucket> {
  const months: Record<string, HoymilesRateLimitMonthBucket> = {};
  if (!input || typeof input !== "object") return months;

  for (const [ym, value] of Object.entries(input)) {
    const key = String(ym || "").trim();
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    months[key] = normalizeMonthBucket(value);
  }

  return months;
}

function normalizeRateLimitDb(input: unknown): HoymilesRateLimitDb {
  if (!input || typeof input !== "object") return rlDefault();

  const hits = normalizeMinuteHits((input as any)?.minute_window?.hits);
  const monthsRaw = (input as any)?.months;
  const months = monthsRaw && typeof monthsRaw === "object" && Object.keys(monthsRaw).length > 0
    ? normalizeMonthsMap(monthsRaw)
    : normalizeMonthsMap(legacyDaysToMonths((input as any)?.days));

  return {
    version: 2,
    minute_window: { hits },
    months
  };
}

function readRateLimitDb(repoRoot: string): HoymilesRateLimitDb {
  const p = rlPath(repoRoot);
  if (!fs.existsSync(p)) return rlDefault();

  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeParseJson(raw);
  return normalizeRateLimitDb(parsed);
}

function writeRateLimitDb(repoRoot: string, db: HoymilesRateLimitDb): void {
  const normalized = normalizeRateLimitDb(db);
  pruneMinuteWindow(normalized, Date.now());
  gcMonths(normalized, 6);
  atomicWriteJson(rlPath(repoRoot), normalized);
}

function gcMonths(db: HoymilesRateLimitDb, keepMonths: number): void {
  const keys = Object.keys(db.months || {}).sort();
  while (keys.length > keepMonths) {
    const oldest = keys.shift();
    if (oldest) delete db.months[oldest];
  }
}

function pruneMinuteWindow(db: HoymilesRateLimitDb, nowMs: number): void {
  const cutoff = nowMs - 60_000;
  db.minute_window.hits = (db.minute_window.hits || []).filter((row) => Date.parse(row.at) > cutoff);
}

function ensureMonthBucket(db: HoymilesRateLimitDb, ym: string): HoymilesRateLimitMonthBucket {
  if (!db.months[ym]) {
    db.months[ym] = {
      total_hits: 0,
      by_endpoint: {},
      first_hit_at: null,
      last_hit_at: null,
      last_success_at_by_endpoint: {}
    };
  }
  return db.months[ym];
}

function rateLimitPrecheck(
  ctx: HoymilesCtx,
  _req: Request,
  _sid: number,
  endpoint: string = "production_stats"
): { ok: boolean; message?: string } {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const monthKey = currentMonthUtcYm();

  const db = readRateLimitDb(ctx.repoRoot);
  pruneMinuteWindow(db, nowMs);

  if (db.minute_window.hits.length >= 10) {
    return {
      ok: false,
      message: "Hoymiles rate limit: Plan A global minute cap reached (10 hits/minute). Try again shortly."
    };
  }

  const monthBucket = ensureMonthBucket(db, monthKey);
  if (monthBucket.total_hits >= 10000) {
    return {
      ok: false,
      message: "Hoymiles rate limit: Plan A global monthly cap reached (10,000 hits/month)."
    };
  }

  db.minute_window.hits.push({ at: nowIso, endpoint });
  monthBucket.total_hits += 1;
  monthBucket.by_endpoint[endpoint] = Math.max(0, Number(monthBucket.by_endpoint[endpoint] || 0) || 0) + 1;
  monthBucket.first_hit_at = monthBucket.first_hit_at || nowIso;
  monthBucket.last_hit_at = nowIso;

  gcMonths(db, 6);
  writeRateLimitDb(ctx.repoRoot, db);
  return { ok: true };
}

function rateLimitMarkSuccess(
  ctx: HoymilesCtx,
  _req: Request,
  _sid: number,
  endpoint: string = "production_stats"
): void {
  const monthKey = currentMonthUtcYm();
  const db = readRateLimitDb(ctx.repoRoot);
  const monthBucket = ensureMonthBucket(db, monthKey);
  monthBucket.last_success_at_by_endpoint[endpoint] = new Date().toISOString();
  gcMonths(db, 6);
  writeRateLimitDb(ctx.repoRoot, db);
}

async function hoymilesPostJson(apiKey: string, endpointPath: string, payload: any): Promise<any> {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Missing Hoymiles apiKey");

  const url = `https://wapi.hoymiles.com${endpointPath}?key=${encodeURIComponent(key)}`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "*/*" },
      body: JSON.stringify(payload || {}),
      signal: ac.signal
    });

    const text = await r.text();
    const parsed = safeParseJson(text);

    if (!parsed || typeof parsed !== "object") {
      return { status: String(r.status), message: "Invalid JSON response from Hoymiles", data: text, http_status: r.status };
    }

    return { ...parsed, http_status: r.status };
  } finally {
    clearTimeout(t);
  }
}

let registeredHoymilesRepoRoot = "";

function hoymilesRateLimitCtx(repoRoot: string): HoymilesCtx {
  return { repoRoot } as HoymilesCtx;
}

function getHoymilesRepoRoot(ctx?: HoymilesCtx): string {
  const fromCtx = String(ctx?.repoRoot || "").trim();
  if (fromCtx) return fromCtx;
  const fromRegistered = String(registeredHoymilesRepoRoot || "").trim();
  if (fromRegistered) return fromRegistered;
  throw new Error("hoymiles_rate_limit_repo_root_unavailable");
}

export async function callHoymilesProductionStats(
  ctx: HoymilesCtx,
  req: Request,
  body: Record<string, unknown>
): Promise<HoymilesProductionStatsCallResult> {
  const serverApiKey = String(process.env.HOYMILES_API_KEY || "").trim();
  if (!serverApiKey) {
    return { ok: false, status: 500, body: { ok: false, reason: "server_missing_hoymiles_api_key" } };
  }

  if (
    typeof body.api_key === "string" ||
    typeof body.apiKey === "string" ||
    typeof body.hoymiles_api_key === "string" ||
    typeof body.HOYMILES_API_KEY === "string"
  ) {
    return { ok: false, status: 400, body: { ok: false, reason: "client_hoymiles_key_not_allowed" } };
  }

  const sid = Number(body.sid);
  const start_date = String(body.start_date || "").trim();
  const end_date = body.end_date === null || body.end_date === undefined ? "" : String(body.end_date).trim();
  const granularity = String(body.granularity || "day").trim();

  if (!Number.isFinite(sid) || sid <= 0) {
    return { ok: false, status: 400, body: { ok: false, reason: "invalid_sid" } };
  }
  if (!start_date) {
    return { ok: false, status: 400, body: { ok: false, reason: "missing_start_date" } };
  }
  if (granularity !== "day") {
    return { ok: false, status: 400, body: { ok: false, reason: "invalid_granularity" } };
  }

  const rl = rateLimitPrecheck(ctx, req, sid, "production_stats");
  if (!rl.ok) {
    return {
      ok: false,
      status: 429,
      body: { ok: false, reason: "hoymiles_rate_limited", message: rl.message }
    };
  }

  const payload: any = { start_date, granularity: "day" };
  if (end_date) payload.end_date = end_date;

  const out = await hoymilesPostJson(serverApiKey, `/v2/plant/${sid}/production_stats`, payload);
  const success = out && String(out.status ?? "") === "0";
  if (success) rateLimitMarkSuccess(ctx, req, sid, "production_stats");

  return { ok: true, payload: out };
}

export async function callHoymilesPlantTimezone(
  sid: number
): Promise<
  | { ok: true; sid: number; tz_name: string }
  | { ok: false; status: number; body: any }
> {
  const serverApiKey = String(process.env.HOYMILES_API_KEY || "").trim();
  if (!serverApiKey) {
    return { ok: false, status: 500, body: { ok: false, reason: "server_missing_hoymiles_api_key" } };
  }

  if (!Number.isFinite(sid) || sid <= 0) {
    return { ok: false, status: 400, body: { ok: false, reason: "invalid_sid" } };
  }

  const repoRoot = getHoymilesRepoRoot();
  const rlCtx = hoymilesRateLimitCtx(repoRoot);
  const rl = rateLimitPrecheck(rlCtx, {} as Request, sid, "gpw");
  if (!rl.ok) {
    return {
      ok: false,
      status: 429,
      body: { ok: false, reason: "hoymiles_rate_limited", message: rl.message }
    };
  }

  const out = await hoymilesPostJson(serverApiKey, `/v2/plant/${sid}/gpw`, {});
  if (String(out?.status ?? "") !== "0") {
    return {
      ok: false,
      status: 502,
      body: { ok: false, reason: "hoymiles_upstream_error", hoymiles: out }
    };
  }

  rateLimitMarkSuccess(rlCtx, {} as Request, sid, "gpw");

  const tz_name = String(out?.data?.tz_name || "").trim();
  if (!tz_name) {
    return {
      ok: false,
      status: 502,
      body: { ok: false, reason: "hoymiles_site_timezone_missing", hoymiles: out }
    };
  }

  return { ok: true, sid, tz_name };
}

export function registerHoymilesRoutes(app: Express, ctx: HoymilesCtx): void {
  registeredHoymilesRepoRoot = String(ctx.repoRoot || "").trim();

  app.post("/api/v1/hoymiles/production-stats", async (req: Request, res: Response) => {
    try {
      await ctx.ensureKaspaReady(ctx.repoRoot);

      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = ctx.readWalletStore(ctx.repoRoot, userId);
      const active = store && store.active_id
        ? (store.items || []).find((w: any) => w.id === store.active_id) ?? null
        : null;

      if (!active) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      }
      if (String(active.state || "") !== "READY") {
        return res.status(409).json({ ok: false, reason: "wallet_not_ready" });
      }

      const walletNetwork = String(active.network || "").trim() === "mainnet" ? "mainnet" : "testnet";
      const networkId = walletNetwork === "mainnet" ? "mainnet" : "testnet-10";

      const fromAddress = String(active.address0 || "").trim();
      if (!fromAddress) {
        return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
      }

      const lic = await ctx.requireMainnetLicenseOrReject({ networkId: networkId as any, userId });
      if (!lic.ok) {
        const out: any = { ok: false, reason: lic.reason, tick: lic.tick, ca: lic.ca };
        if ("error" in lic && lic.error) out.error = lic.error;
        return res.status(lic.status).json(out);
      }

      const body = req.body && typeof req.body === "object" ? (req.body as any) : {};
      const out = await callHoymilesProductionStats(ctx, req, body);

      if (!out.ok) {
        return res.status(out.status).json(out.body);
      }

      return res.json(out.payload);
    } catch (e) {
      return res.status(500).json({ ok: false, reason: "hoymiles_exception", error: String(e) });
    }
  });
}
