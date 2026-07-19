import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  EnergyNetworkId,
  EnergySiteLedgerRecord,
  EnergySiteRecord,
  EnergyStore,
  EnergyTokenLockRecord
} from "../types";

function energyStorePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "energy.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function initialEnergyStore(): EnergyStore {
  return {
    version: 1,
    updated_at: new Date(0).toISOString(),
    sites_by_id: {},
    site_id_by_sid: {},
    energy_locks_by_network: {},
    ledgers_by_site_id: {}
  };
}

function ensureStoreFile(storePath: string): void {
  const dir = path.dirname(storePath);
  ensureDir(dir);
  if (!fs.existsSync(storePath)) {
    atomicWriteJson(storePath, initialEnergyStore());
  }
}

function parseJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function trimmedString(value: unknown): string {
  return String(value ?? "").trim();
}

function isoStringOrNull(value: unknown): string | null {
  const s = trimmedString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isoStringOrNow(value: unknown): string {
  return isoStringOrNull(value) || new Date().toISOString();
}

function normalizeSid(value: unknown): string {
  return trimmedString(value);
}

function normalizeCa(value: unknown): string {
  return trimmedString(value).toLowerCase();
}

function normalizeSiteId(value: unknown, fallback: string): string {
  const s = trimmedString(value);
  return s || fallback;
}

function normalizeSiteName(value: unknown, fallback: string): string {
  const s = trimmedString(value);
  return s || fallback;
}

function normalizeNetworkIdOrNull(value: unknown): EnergyNetworkId | null {
  const s = trimmedString(value).toLowerCase();
  if (s === "mainnet") return "mainnet";
  if (/^tn\d+$/.test(s)) return s as EnergyNetworkId;
  return null;
}

function normalizeNetworkId(value: unknown, fallback: EnergyNetworkId): EnergyNetworkId {
  return normalizeNetworkIdOrNull(value) || fallback;
}

function canonicalizeEnergySiteRecord(raw: unknown, fallbackSiteId: string): EnergySiteRecord | null {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const siteId = normalizeSiteId(obj.site_id, fallbackSiteId);
  const sid = normalizeSid(obj.sid);
  if (!siteId || !sid) return null;

  return {
    site_id: siteId,
    owner_user_id: trimmedString(obj.owner_user_id),
    sid,
    site_name: normalizeSiteName(obj.site_name, sid),
    site_timezone: trimmedString(obj.site_timezone),
    activation_start_date: trimmedString(obj.activation_start_date),
    is_active: obj.is_active === false ? false : true,
    first_successful_download_at: isoStringOrNull(obj.first_successful_download_at),
    created_at: isoStringOrNow(obj.created_at),
    updated_at: isoStringOrNow(obj.updated_at)
  };
}

function canonicalizeEnergyTokenLockRecord(
  raw: unknown,
  fallbackNetworkId: EnergyNetworkId,
  fallbackCa: string
): EnergyTokenLockRecord | null {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const networkId = normalizeNetworkId(obj.network_id, fallbackNetworkId);
  const ca = normalizeCa(obj.ca || fallbackCa);
  if (!ca) return null;

  return {
    network_id: networkId,
    ca,
    is_active: obj.is_active === false ? false : true,
    locked_by_user_id: trimmedString(obj.locked_by_user_id) || null,
    locked_at: isoStringOrNow(obj.locked_at)
  };
}

function canonicalizeEnergySiteLedgerRecord(raw: unknown, fallbackSiteId: string): EnergySiteLedgerRecord | null {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const siteId = normalizeSiteId(obj.site_id, fallbackSiteId);
  if (!siteId) return null;

  const lastIssueNetworkId = normalizeNetworkIdOrNull(obj.last_issue_network_id);

  const legacyIssuedWh = trimmedString(obj.issued_wh) || "0";
  const issuedMainnetWh = trimmedString(obj.issued_mainnet_wh) || legacyIssuedWh || "0";
  const issuedTestnetWh = trimmedString(obj.issued_testnet_wh) || "0";

  return {
    site_id: siteId,
    last_downloaded_at: isoStringOrNull(obj.last_downloaded_at),
    last_downloaded_through_ymd: trimmedString(obj.last_downloaded_through_ymd) || null,
    owed_wh: trimmedString(obj.owed_wh) || "0",
    issued_mainnet_wh: issuedMainnetWh,
    issued_testnet_wh: issuedTestnetWh,
    last_issue_preview_at: isoStringOrNull(obj.last_issue_preview_at),
    last_issue_network_id: lastIssueNetworkId,
    last_issue_ca: normalizeCa(obj.last_issue_ca) || null,
    last_issue_amount_raw: trimmedString(obj.last_issue_amount_raw) || null,
    last_issue_commit_txid: trimmedString(obj.last_issue_commit_txid) || null,
    last_issue_reveal_txid: trimmedString(obj.last_issue_reveal_txid) || null,
    created_at: isoStringOrNow(obj.created_at),
    updated_at: isoStringOrNow(obj.updated_at)
  };
}

export function canonicalizeEnergyStore(raw: unknown): EnergyStore {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = initialEnergyStore();

  const version = Number((obj as any).version);
  out.version = version === 1 ? 1 : 1;
  out.updated_at = isoStringOrNow((obj as any).updated_at);

  const sitesRaw = (obj as any).sites_by_id;
  if (sitesRaw && typeof sitesRaw === "object") {
    for (const [siteId0, siteRaw] of Object.entries(sitesRaw as Record<string, unknown>)) {
      const siteId = trimmedString(siteId0);
      if (!siteId) continue;
      const rec = canonicalizeEnergySiteRecord(siteRaw, siteId);
      if (!rec) continue;
      out.sites_by_id[rec.site_id] = rec;
    }
  }

  out.site_id_by_sid = {};
  for (const rec of Object.values(out.sites_by_id)) {
    if (!rec.sid) continue;
    out.site_id_by_sid[rec.sid] = rec.site_id;
  }

  const locksRaw = (obj as any).energy_locks_by_network;
  if (locksRaw && typeof locksRaw === "object") {
    for (const [networkId0, bucketRaw] of Object.entries(locksRaw as Record<string, unknown>)) {
      const networkId = normalizeNetworkIdOrNull(networkId0);
      if (!networkId) continue;
      if (!bucketRaw || typeof bucketRaw !== "object") continue;
      if (!out.energy_locks_by_network[networkId]) {
        out.energy_locks_by_network[networkId] = {};
      }
      for (const [ca0, lockRaw] of Object.entries(bucketRaw as Record<string, unknown>)) {
        const ca = normalizeCa(ca0);
        if (!ca) continue;
        const rec = canonicalizeEnergyTokenLockRecord(lockRaw, networkId, ca);
        if (!rec) continue;
        out.energy_locks_by_network[networkId][rec.ca] = rec;
      }
    }
  }

  const ledgersRaw = (obj as any).ledgers_by_site_id;
  if (ledgersRaw && typeof ledgersRaw === "object") {
    for (const [siteId0, ledgerRaw] of Object.entries(ledgersRaw as Record<string, unknown>)) {
      const siteId = trimmedString(siteId0);
      if (!siteId) continue;
      const rec = canonicalizeEnergySiteLedgerRecord(ledgerRaw, siteId);
      if (!rec) continue;
      out.ledgers_by_site_id[rec.site_id] = rec;
    }
  }

  return out;
}

export function readEnergyStore(repoRoot: string): EnergyStore {
  const storePath = energyStorePath(repoRoot);
  ensureStoreFile(storePath);
  return canonicalizeEnergyStore(parseJsonFile(storePath));
}

export function writeEnergyStore(repoRoot: string, store: EnergyStore): void {
  const storePath = energyStorePath(repoRoot);
  const canonical = canonicalizeEnergyStore(store);
  canonical.updated_at = new Date().toISOString();
  atomicWriteJson(storePath, canonical);
}

export function generateEnergySiteId(): string {
  return `SITE_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
