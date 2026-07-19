import type { Express, Request, Response } from "express";
import {
  EnergyNetworkId,
  EnergySiteLedgerRecord,
  EnergySiteRecord,
  EnergyStore,
  EnergyTokenLockRecord
} from "../types";
import { generateEnergySiteId, readEnergyStore, writeEnergyStore } from "../storage/energyStore";
import { readWrappedConfigV7 } from "../storage/wrappedConfigStore";
import { readTokenMetadataCacheStore } from "../storage/tokenMetadataCacheStore";
import { callHoymilesPlantTimezone, callHoymilesProductionStats } from "./hoymiles";

export type EnergyCtx = {
  repoRoot: string;
  readWalletStore: (repoRootPath: string, userId: string) => any;
};

function getUserId(res: Response): string | null {
  const v = (res.locals as any).td_user_id;
  const uid = typeof v === "string" ? v.trim() : "";
  return uid || null;
}

function getBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object") return {};
  return req.body as Record<string, unknown>;
}

function trimmedString(value: unknown): string {
  return String(value ?? "").trim();
}

function lowerTrimmed(value: unknown): string {
  return trimmedString(value).toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIsoDateOnly(value: unknown): string | null {
  const s = trimmedString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return s;
}

function parseSiteId(value: unknown): string {
  return trimmedString(value);
}

function parseSid(value: unknown): string {
  return trimmedString(value);
}

function parseSiteTimezone(value: unknown): string {
  return trimmedString(value);
}

function parseEnergyNetworkId(value: unknown): EnergyNetworkId | null {
  const s = lowerTrimmed(value);
  if (s === "mainnet") return "mainnet";
  if (s === "tn10" || s === "testnet-10") return "tn10";
  return null;
}

function activeWalletNetId(active: any): EnergyNetworkId {
  return String(active?.network || "").trim() === "mainnet" ? "mainnet" : "tn10";
}

function getActiveWallet(ctx: EnergyCtx, userId: string): any | null {
  const store = ctx.readWalletStore(ctx.repoRoot, userId);
  const activeId = store && typeof store.active_id === "string" ? String(store.active_id).trim() : "";
  if (!activeId) return null;
  const items = Array.isArray(store?.items) ? store.items : [];
  return items.find((w: any) => String(w?.id || "").trim() === activeId) || null;
}

function ensureUserSiteOwnership(site: EnergySiteRecord | null, userId: string): boolean {
  return Boolean(site && site.owner_user_id === userId);
}

function initialLedgerForSite(siteId: string): EnergySiteLedgerRecord {
  const iso = nowIso();
  return {
    site_id: siteId,
    last_downloaded_at: null,
    last_downloaded_through_ymd: null,
    owed_wh: "0",
    issued_mainnet_wh: "0",
    issued_testnet_wh: "0",
    last_issue_preview_at: null,
    last_issue_network_id: null,
    last_issue_ca: null,
    last_issue_amount_raw: null,
    last_issue_commit_txid: null,
    last_issue_reveal_txid: null,
    created_at: iso,
    updated_at: iso
  };
}

function siteSummary(site: EnergySiteRecord): Record<string, unknown> {
  return {
    site_id: site.site_id,
    sid: site.sid,
    site_name: site.site_name,
    site_timezone: site.site_timezone,
    activation_start_date: site.activation_start_date,
    is_active: site.is_active,
    first_successful_download_at: site.first_successful_download_at,
    created_at: site.created_at,
    updated_at: site.updated_at
  };
}

function ledgerSummary(ledger: EnergySiteLedgerRecord): Record<string, unknown> {
  return {
    site_id: ledger.site_id,
    last_downloaded_at: ledger.last_downloaded_at,
    last_downloaded_through_ymd: ledger.last_downloaded_through_ymd,
    owed_wh: ledger.owed_wh,
    issued_mainnet_wh: ledger.issued_mainnet_wh,
    issued_testnet_wh: ledger.issued_testnet_wh,
    issued_wh: (bigintDigits(ledger.issued_mainnet_wh) + bigintDigits(ledger.issued_testnet_wh)).toString(),
    last_issue_preview_at: ledger.last_issue_preview_at,
    last_issue_network_id: ledger.last_issue_network_id,
    last_issue_ca: ledger.last_issue_ca,
    last_issue_amount_raw: ledger.last_issue_amount_raw,
    last_issue_commit_txid: ledger.last_issue_commit_txid,
    last_issue_reveal_txid: ledger.last_issue_reveal_txid,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at
  };
}

function yesterdayUtcYmd(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDaysUtcYmd(ymd: string, days: number): string | null {
  const parsed = parseIsoDateOnly(ymd);
  if (!parsed) return null;
  const d = new Date(`${parsed}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bigintDigits(value: unknown): bigint {
  const s = trimmedString(value);
  return /^\d+$/.test(s) ? BigInt(s) : 0n;
}

function parseDirectWh(value: unknown): bigint | null {
  const s = trimmedString(value);
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}

function parseKwhToWh(value: unknown): bigint | null {
  const s = trimmedString(value);
  const m = s.match(/^(\d+)(?:\.(\d{0,3})\d*)?$/);
  if (!m) return null;
  const whole = BigInt(m[1] || "0");
  const frac = BigInt(String(m[2] || "").padEnd(3, "0").slice(0, 3) || "0");
  return whole * 1000n + frac;
}

function parseHoymilesRowYmd(value: unknown): string | null {
  const s = trimmedString(value);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function normalizeHoymilesDailyRow(raw: unknown): { ymd: string; wh: bigint } | null {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj) return null;

  const ymd =
    parseHoymilesRowYmd(obj.date) ||
    parseHoymilesRowYmd(obj.day) ||
    parseHoymilesRowYmd(obj.ymd) ||
    parseHoymilesRowYmd(obj.time) ||
    parseHoymilesRowYmd(obj.datetime) ||
    parseHoymilesRowYmd(obj.statDate) ||
    parseHoymilesRowYmd(obj.stat_date) ||
    parseHoymilesRowYmd(obj.report_date);

  if (!ymd) return null;

  const wh =
    parseDirectWh(obj.e) ??
    parseDirectWh(obj.wh) ??
    parseDirectWh(obj.watt_hour) ??
    parseDirectWh(obj.wattHour) ??
    parseDirectWh(obj.total_energy) ??
    parseKwhToWh(obj.eq) ??
    parseKwhToWh(obj.energy) ??
    parseKwhToWh(obj.production) ??
    parseKwhToWh(obj.value) ??
    parseKwhToWh(obj.yield);

  if (wh === null) return null;
  return { ymd, wh };
}

function collectHoymilesDailyRows(raw: unknown, out: Array<{ ymd: string; wh: bigint }>): void {
  if (Array.isArray(raw)) {
    for (const item of raw) collectHoymilesDailyRows(item, out);
    return;
  }
  if (!raw || typeof raw !== "object") return;

  const row = normalizeHoymilesDailyRow(raw);
  if (row) out.push(row);

  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      collectHoymilesDailyRows(value, out);
    }
  }
}

function summarizeHoymilesDownload(payload: unknown, startYmd: string, endYmd: string):
  | { ok: true; importedWh: bigint; throughYmd: string; dayCount: number }
  | { ok: false; reason: string } {
  const rows: Array<{ ymd: string; wh: bigint }> = [];
  collectHoymilesDailyRows(payload, rows);

  const byDay = new Map<string, bigint>();
  for (const row of rows) {
    if (row.ymd < startYmd || row.ymd > endYmd) continue;
    if (!byDay.has(row.ymd)) {
      byDay.set(row.ymd, row.wh);
    }
  }

  if (byDay.size < 1) {
    return { ok: false, reason: "energy_download_parse_failed" };
  }

  const sortedDays = Array.from(byDay.keys()).sort();
  let importedWh = 0n;
  for (const day of sortedDays) importedWh += byDay.get(day) || 0n;

  return {
    ok: true,
    importedWh,
    throughYmd: sortedDays[sortedDays.length - 1],
    dayCount: sortedDays.length
  };
}

function getWrappedOwnerAddress(repoRoot: string, networkId: EnergyNetworkId, ca: string): string | null {
  const cfg = readWrappedConfigV7(repoRoot);
  const bucket = cfg.issuance?.deployerByNetwork?.[networkId];
  const addr = bucket && typeof bucket === "object" ? trimmedString((bucket as Record<string, unknown>)[ca]) : "";
  return addr || null;
}

function getMetadataOwnerAddress(repoRoot: string, networkId: EnergyNetworkId, ca: string): string | null {
  const store = readTokenMetadataCacheStore(repoRoot);
  const entry = store.byNetwork[networkId][ca] || null;
  const addr = entry ? trimmedString(entry.metadata?.issuance?.toAddress) : "";
  return addr || null;
}

function getWrappedMetadataDisplay(
  repoRoot: string,
  networkId: EnergyNetworkId,
  ca: string
): {
  name: string | null;
  tick: string | null;
  decimals: number | null;
} {
  const cfg = readWrappedConfigV7(repoRoot);
  const bucket = cfg.issuance?.metaByNetwork?.[networkId];
  const entry = bucket && typeof bucket === "object" ? (bucket as Record<string, any>)[ca] : null;
  return {
    name: entry ? trimmedString(entry.name) || null : null,
    tick: entry ? trimmedString(entry.tick) || null : null,
    decimals: entry && typeof entry.decimals === "number" && Number.isFinite(entry.decimals) ? entry.decimals : null
  };
}

function getMetadataDisplay(
  repoRoot: string,
  networkId: EnergyNetworkId,
  ca: string
): {
  name: string | null;
  tick: string | null;
  decimals: number | null;
} {
  const store = readTokenMetadataCacheStore(repoRoot);
  const entry = store.byNetwork[networkId][ca] || null;
  const wrapped = getWrappedMetadataDisplay(repoRoot, networkId, ca);

  const cacheName = entry?.metadata?.identity?.name ?? null;
  const cacheTick = entry?.metadata?.identity?.tick ?? null;
  const cacheDecimals = entry?.metadata?.identity?.decimals ?? null;

  return {
    name: cacheName ?? wrapped.name ?? null,
    tick: cacheTick ?? wrapped.tick ?? null,
    decimals: cacheDecimals ?? wrapped.decimals ?? null
  };
}

function isKnownEnergyCandidate(repoRoot: string, networkId: EnergyNetworkId, ca: string): boolean {
  if (getMetadataOwnerAddress(repoRoot, networkId, ca)) return true;
  if (getWrappedOwnerAddress(repoRoot, networkId, ca)) return true;
  const meta = getMetadataDisplay(repoRoot, networkId, ca);
  return Boolean(meta.name || meta.tick || meta.decimals !== null);
}

function isCaIssuableByActiveWallet(
  repoRoot: string,
  networkId: EnergyNetworkId,
  ca: string,
  activeAddress0: string
): boolean {
  const active0 = lowerTrimmed(activeAddress0);
  if (!active0) return false;

  const wrappedOwner = lowerTrimmed(getWrappedOwnerAddress(repoRoot, networkId, ca));
  if (wrappedOwner && wrappedOwner === active0) return true;

  const metadataOwner = lowerTrimmed(getMetadataOwnerAddress(repoRoot, networkId, ca));
  if (metadataOwner && metadataOwner === active0) return true;

  return false;
}

function getEligibleEnergyTokensForWallet(
  repoRoot: string,
  networkId: EnergyNetworkId,
  activeAddress0: string,
  store: EnergyStore
): Array<Record<string, unknown>> {
  const locks = store.energy_locks_by_network[networkId] || {};
  const out: Array<Record<string, unknown>> = [];

  for (const [ca0, lock] of Object.entries(locks)) {
    const ca = lowerTrimmed(ca0);
    const rec = lock as EnergyTokenLockRecord | undefined;
    if (!ca || !rec || rec.is_active !== true) continue;
    if (!isCaIssuableByActiveWallet(repoRoot, networkId, ca, activeAddress0)) continue;

    const display = getMetadataDisplay(repoRoot, networkId, ca);
    out.push({
      network_id: networkId,
      ca,
      name: display.name,
      tick: display.tick,
      decimals: display.decimals,
      is_energy_locked: true,
      locked_at: rec.locked_at
    });
  }

  return out.sort((a, b) => {
    const an = trimmedString(a.name || a.tick || a.ca);
    const bn = trimmedString(b.name || b.tick || b.ca);
    return an.localeCompare(bn);
  });
}

export function registerEnergyRoutes(app: Express, ctx: EnergyCtx): void {
  app.get("/api/v1/energy/sites", (_req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const store = readEnergyStore(ctx.repoRoot);
    const active = getActiveWallet(ctx, userId);

    const sites = Object.values(store.sites_by_id)
      .filter((site) => site.owner_user_id === userId)
      .sort((a, b) => a.site_name.localeCompare(b.site_name))
      .map(siteSummary);

    return res.json({
      ok: true,
      sites,
      active_wallet: active
        ? {
            wallet_id: trimmedString(active.id),
            network_id: activeWalletNetId(active),
            address0: trimmedString(active.address0)
          }
        : null
    });
  });

  app.post("/api/v1/energy/sites/add", async (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const body = getBody(req);
    const sid = parseSid(body.sid);
    const siteName = trimmedString(body.site_name);
    const activationStartDate = parseIsoDateOnly(body.activation_start_date);

    if (!sid) return res.status(400).json({ ok: false, reason: "invalid_sid" });
    if (!siteName) return res.status(400).json({ ok: false, reason: "invalid_site_name" });
    if (!activationStartDate) return res.status(400).json({ ok: false, reason: "invalid_activation_start_date" });

    const store = readEnergyStore(ctx.repoRoot);
    const existingSiteId = store.site_id_by_sid[sid] || null;
    if (existingSiteId) {
      return res.status(409).json({
        ok: false,
        reason: "energy_site_sid_already_exists",
        existing_site_id: existingSiteId
      });
    }

    const tzResult = await callHoymilesPlantTimezone(Number(sid));
    if (!tzResult.ok) {
      return res.status(tzResult.status).json(tzResult.body);
    }

    const siteTimezone = parseSiteTimezone(tzResult.tz_name);
    if (!siteTimezone) {
      return res.status(502).json({ ok: false, reason: "hoymiles_site_timezone_missing" });
    }

    const siteId = generateEnergySiteId();
    const iso = nowIso();
    const site: EnergySiteRecord = {
      site_id: siteId,
      owner_user_id: userId,
      sid,
      site_name: siteName,
      site_timezone: siteTimezone,
      activation_start_date: activationStartDate,
      is_active: true,
      first_successful_download_at: null,
      created_at: iso,
      updated_at: iso
    };

    store.sites_by_id[siteId] = site;
    store.site_id_by_sid[sid] = siteId;
    store.ledgers_by_site_id[siteId] = initialLedgerForSite(siteId);
    writeEnergyStore(ctx.repoRoot, store);

    return res.json({
      ok: true,
      site: siteSummary(site),
      ledger: ledgerSummary(store.ledgers_by_site_id[siteId])
    });
  });

  app.post("/api/v1/energy/sites/remove", (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const body = getBody(req);
    const siteId = parseSiteId(body.site_id || body.siteId);
    if (!siteId) return res.status(400).json({ ok: false, reason: "invalid_site_id" });

    const store = readEnergyStore(ctx.repoRoot);
    const site = store.sites_by_id[siteId] || null;
    if (!ensureUserSiteOwnership(site, userId)) {
      return res.status(404).json({ ok: false, reason: "energy_site_not_found" });
    }

    const ledger = store.ledgers_by_site_id[siteId] || initialLedgerForSite(siteId);
    if (bigintDigits(ledger.issued_mainnet_wh) === 0n) {
      delete store.sites_by_id[siteId];
      if (store.site_id_by_sid[site.sid] === siteId) {
        delete store.site_id_by_sid[site.sid];
      }
      delete store.ledgers_by_site_id[siteId];
      writeEnergyStore(ctx.repoRoot, store);

      return res.json({
        ok: true,
        removed_site_id: siteId,
        hard_deleted: true
      });
    }

    const next: EnergySiteRecord = {
      ...site,
      is_active: false,
      updated_at: nowIso()
    };
    store.sites_by_id[siteId] = next;
    writeEnergyStore(ctx.repoRoot, store);

    return res.json({
      ok: true,
      site: siteSummary(next),
      hard_deleted: false
    });
  });

  app.get("/api/v1/energy/tokens", (_req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const active = getActiveWallet(ctx, userId);
    if (!active) {
      return res.status(409).json({ ok: false, reason: "no_active_wallet" });
    }

    const activeAddress0 = trimmedString(active.address0);
    if (!activeAddress0) {
      return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
    }

    const networkId = activeWalletNetId(active);
    const store = readEnergyStore(ctx.repoRoot);
    const tokens = getEligibleEnergyTokensForWallet(ctx.repoRoot, networkId, activeAddress0, store);

    return res.json({
      ok: true,
      active_wallet: {
        wallet_id: trimmedString(active.id),
        network_id: networkId,
        address0: activeAddress0
      },
      tokens
    });
  });

  app.post("/api/v1/energy/tokens/lock", (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const body = getBody(req);
    const networkId = parseEnergyNetworkId(body.network_id || body.networkId);
    const ca = lowerTrimmed(body.ca);

    if (!networkId) return res.status(400).json({ ok: false, reason: "invalid_network" });
    if (!ca) return res.status(400).json({ ok: false, reason: "invalid_ca" });
    if (!isKnownEnergyCandidate(ctx.repoRoot, networkId, ca)) {
      return res.status(404).json({ ok: false, reason: "energy_token_candidate_not_found" });
    }

    const store = readEnergyStore(ctx.repoRoot);
    const existing = store.energy_locks_by_network[networkId][ca] || null;
    const next: EnergyTokenLockRecord = existing
      ? {
          ...existing,
          is_active: true
        }
      : {
          network_id: networkId,
          ca,
          is_active: true,
          locked_by_user_id: userId,
          locked_at: nowIso()
        };

    store.energy_locks_by_network[networkId][ca] = next;
    writeEnergyStore(ctx.repoRoot, store);

    return res.json({ ok: true, lock: next });
  });

  app.get("/api/v1/energy/ledger", (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const siteId = parseSiteId((req.query as any).site_id || (req.query as any).siteId);
    if (!siteId) return res.status(400).json({ ok: false, reason: "invalid_site_id" });

    const store = readEnergyStore(ctx.repoRoot);
    const site = store.sites_by_id[siteId] || null;
    if (!ensureUserSiteOwnership(site, userId)) {
      return res.status(404).json({ ok: false, reason: "energy_site_not_found" });
    }

    const ledger = store.ledgers_by_site_id[siteId] || initialLedgerForSite(siteId);
    return res.json({ ok: true, site: siteSummary(site), ledger: ledgerSummary(ledger) });
  });

  app.post("/api/v1/energy/download", async (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const body = getBody(req);
    const siteId = parseSiteId(body.site_id || body.siteId);
    if (!siteId) return res.status(400).json({ ok: false, reason: "invalid_site_id" });

    const store = readEnergyStore(ctx.repoRoot);
    const site = store.sites_by_id[siteId] || null;
    if (!ensureUserSiteOwnership(site, userId)) {
      return res.status(404).json({ ok: false, reason: "energy_site_not_found" });
    }

    const ledger = store.ledgers_by_site_id[siteId] || initialLedgerForSite(siteId);

    const lastDownloadedAtMs = ledger.last_downloaded_at ? Date.parse(ledger.last_downloaded_at) : NaN;
    if (Number.isFinite(lastDownloadedAtMs)) {
      const nextAllowedMs = lastDownloadedAtMs + 24 * 60 * 60 * 1000;
      if (Date.now() < nextAllowedMs) {
        return res.status(429).json({
          ok: false,
          reason: "energy_download_locked_24h",
          next_allowed_at: new Date(nextAllowedMs).toISOString(),
          site: siteSummary(site),
          ledger: ledgerSummary(ledger)
        });
      }
    }

    const startYmd = ledger.last_downloaded_through_ymd
      ? addDaysUtcYmd(ledger.last_downloaded_through_ymd, 1)
      : site.activation_start_date;

    if (!startYmd) {
      return res.status(500).json({
        ok: false,
        reason: "energy_download_start_unavailable",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    const endYmd = yesterdayUtcYmd();
    if (startYmd > endYmd) {
      return res.json({
        ok: true,
        site: siteSummary(site),
        ledger: ledgerSummary(ledger),
        download: {
          start_date: startYmd,
          through_ymd: ledger.last_downloaded_through_ymd,
          imported_wh: "0",
          day_count: 0,
          no_new_days: true
        }
      });
    }

    const hoy = await callHoymilesProductionStats(ctx as any, req, {
      sid: Number(site.sid),
      start_date: startYmd,
      granularity: "day"
    });

    if (!hoy.ok) {
      return res.status(hoy.status).json({
        ...(hoy.body || { ok: false, reason: "hoymiles_call_failed" }),
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    const payload = hoy.payload;
    if (!payload || String(payload.status ?? "") !== "0") {
      return res.status(502).json({
        ok: false,
        reason: "hoymiles_upstream_error",
        hoymiles: payload || null,
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    const summary = summarizeHoymilesDownload(payload, startYmd, endYmd);
    if (!summary.ok) {
      return res.status(502).json({
        ok: false,
        reason: summary.reason,
        hoymiles: payload,
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    const iso = nowIso();
    const nextLedger: EnergySiteLedgerRecord = {
      ...ledger,
      last_downloaded_at: iso,
      last_downloaded_through_ymd: summary.throughYmd,
      owed_wh: (bigintDigits(ledger.owed_wh) + summary.importedWh).toString(),
      issued_mainnet_wh: ledger.issued_mainnet_wh || "0",
      issued_testnet_wh: ledger.issued_testnet_wh || "0",
      updated_at: iso
    };

    const nextSite: EnergySiteRecord = {
      ...site,
      first_successful_download_at: site.first_successful_download_at || iso,
      updated_at: iso
    };

    store.sites_by_id[siteId] = nextSite;
    store.ledgers_by_site_id[siteId] = nextLedger;
    writeEnergyStore(ctx.repoRoot, store);

    return res.json({
      ok: true,
      site: siteSummary(nextSite),
      ledger: ledgerSummary(nextLedger),
      download: {
        start_date: startYmd,
        through_ymd: summary.throughYmd,
        imported_wh: summary.importedWh.toString(),
        day_count: summary.dayCount
      }
    });
  });

  app.post("/api/v1/energy/issue/prepare", (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const active = getActiveWallet(ctx, userId);
    if (!active) {
      return res.status(409).json({ ok: false, reason: "no_active_wallet" });
    }

    const activeAddress0 = trimmedString(active.address0);
    if (!activeAddress0) {
      return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
    }

    const networkId = activeWalletNetId(active);
    const body = getBody(req);
    const siteId = parseSiteId(body.site_id || body.siteId);
    const ca = lowerTrimmed(body.ca);
    const amountRaw = trimmedString(body.amount_raw || body.amountRaw);

    if (!siteId) return res.status(400).json({ ok: false, reason: "invalid_site_id" });
    if (!ca) return res.status(400).json({ ok: false, reason: "invalid_ca" });
    if (!/^\d+$/.test(amountRaw || "")) return res.status(400).json({ ok: false, reason: "invalid_amount_raw" });

    const amountWh = bigintDigits(amountRaw);
    if (amountWh <= 0n) {
      return res.status(400).json({ ok: false, reason: "invalid_amount_raw" });
    }

    const store = readEnergyStore(ctx.repoRoot);
    const site = store.sites_by_id[siteId] || null;
    if (!ensureUserSiteOwnership(site, userId)) {
      return res.status(404).json({ ok: false, reason: "energy_site_not_found" });
    }

    const lock = store.energy_locks_by_network[networkId][ca] || null;
    if (!lock || lock.is_active !== true) {
      return res.status(403).json({ ok: false, reason: "energy_token_not_locked" });
    }

    if (!isCaIssuableByActiveWallet(ctx.repoRoot, networkId, ca, activeAddress0)) {
      return res.status(403).json({ ok: false, reason: "energy_token_not_issuable_by_active_wallet" });
    }

    const ledger = store.ledgers_by_site_id[siteId] || initialLedgerForSite(siteId);
    const owedWh = bigintDigits(ledger.owed_wh);
    if (amountWh > owedWh) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_amount_exceeds_owed",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger),
        issue_request: {
          network_id: networkId,
          energy_site_id: siteId,
          ca,
          amt: amountRaw,
          to: activeAddress0
        }
      });
    }

    const iso = nowIso();
    const nextLedger: EnergySiteLedgerRecord = {
      ...ledger,
      last_issue_preview_at: iso,
      last_issue_network_id: networkId,
      last_issue_ca: ca,
      last_issue_amount_raw: amountRaw,
      last_issue_commit_txid: null,
      last_issue_reveal_txid: null,
      updated_at: iso
    };

    store.ledgers_by_site_id[siteId] = nextLedger;
    writeEnergyStore(ctx.repoRoot, store);

    const display = getMetadataDisplay(ctx.repoRoot, networkId, ca);
    const issuedMainnetAfter =
      networkId === "mainnet"
        ? (bigintDigits(nextLedger.issued_mainnet_wh) + amountWh).toString()
        : nextLedger.issued_mainnet_wh;
    const issuedTestnetAfter =
      networkId === "tn10"
        ? (bigintDigits(nextLedger.issued_testnet_wh) + amountWh).toString()
        : nextLedger.issued_testnet_wh;

    return res.json({
      ok: true,
      stage: "energy_issue_prepare",
      site: siteSummary(site),
      ledger: ledgerSummary(nextLedger),
      token: {
        network_id: networkId,
        ca,
        name: display.name,
        tick: display.tick,
        decimals: display.decimals,
        is_energy_locked: true
      },
      issue_request: {
        network_id: networkId,
        energy_site_id: siteId,
        ca,
        amt: amountRaw,
        to: activeAddress0
      },
      preview: {
        owed_wh_before: ledger.owed_wh,
        owed_wh_after: (owedWh - amountWh).toString(),
        issue_wh: amountRaw,
        issued_mainnet_wh_after: issuedMainnetAfter,
        issued_testnet_wh_after: issuedTestnetAfter
      }
    });
  });

  app.post("/api/v1/energy/issue/finalize-refresh", (req: Request, res: Response) => {
    const userId = getUserId(res);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const active = getActiveWallet(ctx, userId);
    if (!active) {
      return res.status(409).json({ ok: false, reason: "no_active_wallet" });
    }

    const activeAddress0 = trimmedString(active.address0);
    if (!activeAddress0) {
      return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
    }

    const networkId = activeWalletNetId(active);
    const body = getBody(req);
    const siteId = parseSiteId(body.site_id || body.siteId);
    const ca = lowerTrimmed(body.ca);
    const amountRaw = trimmedString(body.amount_raw || body.amountRaw);
    const commitTxid = trimmedString(body.commit_txid || body.commitTxid);
    const revealTxid = trimmedString(body.reveal_txid || body.revealTxid);

    if (!siteId) return res.status(400).json({ ok: false, reason: "invalid_site_id" });
    if (!ca) return res.status(400).json({ ok: false, reason: "invalid_ca" });
    if (!/^\d+$/.test(amountRaw || "")) return res.status(400).json({ ok: false, reason: "invalid_amount_raw" });
    if (!revealTxid) return res.status(400).json({ ok: false, reason: "energy_issue_reveal_txid_required" });

    const amountWh = bigintDigits(amountRaw);
    if (amountWh <= 0n) {
      return res.status(400).json({ ok: false, reason: "invalid_amount_raw" });
    }

    const store = readEnergyStore(ctx.repoRoot);
    const site = store.sites_by_id[siteId] || null;
    if (!ensureUserSiteOwnership(site, userId)) {
      return res.status(404).json({ ok: false, reason: "energy_site_not_found" });
    }

    const lock = store.energy_locks_by_network[networkId][ca] || null;
    if (!lock || lock.is_active !== true) {
      return res.status(403).json({ ok: false, reason: "energy_token_not_locked" });
    }

    if (!isCaIssuableByActiveWallet(ctx.repoRoot, networkId, ca, activeAddress0)) {
      return res.status(403).json({ ok: false, reason: "energy_token_not_issuable_by_active_wallet" });
    }

    const ledger = store.ledgers_by_site_id[siteId] || initialLedgerForSite(siteId);

    if (!ledger.last_issue_preview_at || !ledger.last_issue_network_id || !ledger.last_issue_ca || !ledger.last_issue_amount_raw) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_preview_missing",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    if (ledger.last_issue_network_id !== networkId) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_preview_network_mismatch",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    if (lowerTrimmed(ledger.last_issue_ca) !== ca) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_preview_ca_mismatch",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    if (trimmedString(ledger.last_issue_amount_raw) !== amountRaw) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_preview_amount_mismatch",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    if (trimmedString(ledger.last_issue_reveal_txid) === revealTxid) {
      return res.json({
        ok: true,
        stage: "energy_issue_finalize_refresh",
        already_applied: true,
        site: siteSummary(site),
        ledger: ledgerSummary(ledger),
        issue_finalize: {
          network_id: networkId,
          ca,
          amount_raw: amountRaw,
          commit_txid: trimmedString(ledger.last_issue_commit_txid),
          reveal_txid: revealTxid
        }
      });
    }

    const owedWh = bigintDigits(ledger.owed_wh);
    if (amountWh > owedWh) {
      return res.status(409).json({
        ok: false,
        reason: "energy_issue_amount_exceeds_owed",
        site: siteSummary(site),
        ledger: ledgerSummary(ledger)
      });
    }

    const iso = nowIso();
    const nextLedger: EnergySiteLedgerRecord = {
      ...ledger,
      owed_wh: (owedWh - amountWh).toString(),
      issued_mainnet_wh:
        networkId === "mainnet"
          ? (bigintDigits(ledger.issued_mainnet_wh) + amountWh).toString()
          : ledger.issued_mainnet_wh,
      issued_testnet_wh:
        networkId === "tn10"
          ? (bigintDigits(ledger.issued_testnet_wh) + amountWh).toString()
          : ledger.issued_testnet_wh,
      last_issue_commit_txid: commitTxid || ledger.last_issue_commit_txid || null,
      last_issue_reveal_txid: revealTxid,
      updated_at: iso
    };

    store.ledgers_by_site_id[siteId] = nextLedger;
    writeEnergyStore(ctx.repoRoot, store);

    return res.json({
      ok: true,
      stage: "energy_issue_finalize_refresh",
      site: siteSummary(site),
      ledger: ledgerSummary(nextLedger),
      issue_finalize: {
        network_id: networkId,
        ca,
        amount_raw: amountRaw,
        commit_txid: trimmedString(nextLedger.last_issue_commit_txid),
        reveal_txid: trimmedString(nextLedger.last_issue_reveal_txid),
        owed_wh_before: ledger.owed_wh,
        owed_wh_after: nextLedger.owed_wh,
        issued_mainnet_wh_after: nextLedger.issued_mainnet_wh,
        issued_testnet_wh_after: nextLedger.issued_testnet_wh
      }
    });
  });
}
