import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type SponsoredOfferStatus = "disabled" | "active" | "paused" | "archived";
export type SponsoredOfferPlacement =
  | "post_login"
  | "wallet_dashboard"
  | "offers_page"
  | "deploy_page"
  | "issue_page"
  | "redeem_page"
  | "energy_page"
  | "settings_page"
  | "renewal_reminder"
  | "post_action";
export type SponsoredOfferAudience = "all" | "basic" | "wallet_plus" | "wallet_plus_grace";

export type SponsoredOfferRecordV1 = {
  id: string;
  status: SponsoredOfferStatus;
  title: string;
  body: string;
  cta_label: string;
  destination_url: string | null;
  placement: SponsoredOfferPlacement;
  audience: SponsoredOfferAudience;
  priority: number;
  active_from: string | null;
  active_until: string | null;
  max_impressions_per_day: number | null;
  cooldown_minutes: number | null;
  allow_user_block: boolean;
  brand_id: string | null;
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SponsoredOfferStoreV1 = {
  version: 1;
  campaigns: SponsoredOfferRecordV1[];
};

export type SponsoredOfferPatchV1 = Partial<Omit<SponsoredOfferRecordV1, "id" | "created_at" | "updated_at">> & {
  id?: string;
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "sponsored-offers.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createSponsoredOfferId(): string {
  return `SO_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

function normalizeCampaignId(value: unknown): string {
  const s = normalizeString(value);
  return /^SO_[A-Za-z0-9_-]{6,80}$/.test(s) ? s : "";
}

function normalizeStatus(value: unknown): SponsoredOfferStatus {
  if (value === "active" || value === "paused" || value === "archived" || value === "disabled") return value;
  return "disabled";
}

function normalizePlacement(value: unknown): SponsoredOfferPlacement {
  if (
    value === "post_login" ||
    value === "wallet_dashboard" ||
    value === "offers_page" ||
    value === "deploy_page" ||
    value === "issue_page" ||
    value === "redeem_page" ||
    value === "energy_page" ||
    value === "settings_page" ||
    value === "renewal_reminder" ||
    value === "post_action"
  ) {
    return value;
  }
  return "wallet_dashboard";
}

function normalizeAudience(value: unknown): SponsoredOfferAudience {
  if (value === "all" || value === "basic" || value === "wallet_plus" || value === "wallet_plus_grace") return value;
  return "basic";
}

function normalizePriority(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100000, Math.trunc(n)));
}

function normalizePositiveIntegerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const whole = Math.trunc(n);
  return whole > 0 ? whole : null;
}

function normalizeIsoOrNull(value: unknown): string | null {
  const s = normalizeString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeHttpUrlOrNull(value: unknown): string | null {
  const s = normalizeString(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function initialStore(): SponsoredOfferStoreV1 {
  return {
    version: 1,
    campaigns: []
  };
}

function ensureStoreFile(p: string): void {
  ensureDir(path.dirname(p));
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(initialStore(), null, 2) + "\n", "utf8");
  }
}

function normalizeCampaign(input: unknown): SponsoredOfferRecordV1 | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!obj) return null;

  const id = normalizeCampaignId(obj.id);
  const title = normalizeString(obj.title);
  const body = normalizeString(obj.body);
  const cta_label = normalizeString(obj.cta_label) || "Learn more";
  const created_at = normalizeIsoOrNull(obj.created_at);
  const updated_at = normalizeIsoOrNull(obj.updated_at) || created_at;

  if (!id) return null;
  if (!title) return null;
  if (!body) return null;
  if (!created_at || !updated_at) return null;

  return {
    id,
    status: normalizeStatus(obj.status),
    title,
    body,
    cta_label,
    destination_url: normalizeHttpUrlOrNull(obj.destination_url),
    placement: normalizePlacement(obj.placement),
    audience: normalizeAudience(obj.audience),
    priority: normalizePriority(obj.priority),
    active_from: normalizeIsoOrNull(obj.active_from),
    active_until: normalizeIsoOrNull(obj.active_until),
    max_impressions_per_day: normalizePositiveIntegerOrNull(obj.max_impressions_per_day),
    cooldown_minutes: normalizePositiveIntegerOrNull(obj.cooldown_minutes),
    allow_user_block: obj.allow_user_block === true,
    brand_id: normalizeNullableString(obj.brand_id),
    tenant_id: normalizeNullableString(obj.tenant_id),
    created_at,
    updated_at
  };
}

function normalizeStore(input: unknown): SponsoredOfferStoreV1 {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawCampaigns = Array.isArray(obj.campaigns) ? obj.campaigns : [];
  const campaigns = rawCampaigns
    .map((x) => normalizeCampaign(x))
    .filter((x): x is SponsoredOfferRecordV1 => !!x)
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));

  return {
    version: 1,
    campaigns
  };
}

export function readSponsoredOfferStore(repoRoot: string): SponsoredOfferStoreV1 {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeStore(parsed);
}

export function writeSponsoredOfferStore(repoRoot: string, store: SponsoredOfferStoreV1): void {
  const normalized = normalizeStore(store);
  atomicWriteJson(storePath(repoRoot), normalized);
}

export function readSponsoredOfferRaw(repoRoot: string): { filename: string; content: string } {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  return {
    filename: path.basename(p),
    content: fs.readFileSync(p, "utf8")
  };
}

export function listSponsoredOffers(repoRoot: string): SponsoredOfferRecordV1[] {
  return readSponsoredOfferStore(repoRoot).campaigns;
}

export function getSponsoredOfferById(repoRoot: string, id: string): SponsoredOfferRecordV1 | null {
  const normalizedId = normalizeCampaignId(id);
  if (!normalizedId) return null;
  return listSponsoredOffers(repoRoot).find((campaign) => campaign.id === normalizedId) || null;
}

export function upsertSponsoredOffer(repoRoot: string, patch: SponsoredOfferPatchV1): SponsoredOfferRecordV1 {
  const store = readSponsoredOfferStore(repoRoot);
  const ts = nowIso();
  const id = normalizeCampaignId(patch.id) || createSponsoredOfferId();
  const existing = store.campaigns.find((campaign) => campaign.id === id) || null;

  const normalized = normalizeCampaign({
    ...(existing || {}),
    ...patch,
    id,
    created_at: existing ? existing.created_at : ts,
    updated_at: ts
  });

  if (!normalized) throw new Error("sponsored_offer_invalid");

  const idx = store.campaigns.findIndex((campaign) => campaign.id === normalized.id);
  if (idx >= 0) {
    store.campaigns[idx] = normalized;
  } else {
    store.campaigns.push(normalized);
  }

  writeSponsoredOfferStore(repoRoot, store);
  return normalized;
}
