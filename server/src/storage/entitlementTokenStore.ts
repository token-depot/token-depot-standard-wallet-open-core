import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type EntitlementPackageType = "PLUS" | "PRO" | "TENANT";
export type EntitlementRuleStatus = "active" | "archived";
export type EntitlementOwnerScope = "broker" | "tenant";
export type EntitlementSaleStatus = "pending" | "verified" | "rejected";

export type EntitlementTokenRuleV1 = {
  id: string;
  status: EntitlementRuleStatus;
  owner_scope: EntitlementOwnerScope;
  tenant_id: string | null;
  brand_id: string | null;
  package_type: EntitlementPackageType;
  network: "mainnet";
  trigger_ca: string;
  trigger_label: string;
  seller_address: string;
  active_months: number;
  grace_months: number;
  gate_title: string;
  gate_body: string;
  gate_testnet_note: string;
  gate_warning: string;
  gate_button_label: string;
  operator_email_enabled: boolean;
  operator_email_to: string;
  operator_email_subject: string;
  operator_email_body: string;
  created_at: string;
  updated_at: string;
};

export type EntitlementTokenSaleV1 = {
  sale_txid: string;
  rule_id: string;
  package_type: EntitlementPackageType;
  network: "mainnet";
  trigger_ca: string;
  trigger_label: string;
  seller_address: string;
  recipient_address: string;
  user_id: string | null;
  amount_units: string;
  accepted_at: string;
  active_months: number;
  grace_months: number;
  status: EntitlementSaleStatus;
  verified_at?: string;
  reject_reason?: string;
  notes?: string;
  recorded_at: string;
  updated_at: string;
};

export type EntitlementTokenStoreV1 = {
  version: 1;
  rules: EntitlementTokenRuleV1[];
  sales: EntitlementTokenSaleV1[];
};

export type EntitlementPackageStatusV1 = {
  package_type: EntitlementPackageType;
  addresses: string[];
  user_ids: string[];
  sale_count: number;
  active: boolean;
  in_grace: boolean;
  expired: boolean;
  renewal_reminder_required: boolean;
  latest_sale_txid: string | null;
  latest_accepted_at: string | null;
  active_until: string | null;
  grace_until: string | null;
};

export type EntitlementWalletPlusStatusV1 = {
  status: "active" | "grace" | "expired";
  wallet_plus_active: boolean;
  wallet_plus_grace: boolean;
  ads_enabled: boolean;
  renewal_reminder_required: boolean;
  saved_skin_id: string;
  effective_skin_id: string;
  qualifying_sale_txid: string | null;
  qualifying_sale_accepted_at: string | null;
  active_until: string | null;
  grace_until: string | null;
};

export type EntitlementTokenRulePatchV1 = Partial<Omit<EntitlementTokenRuleV1, "created_at" | "updated_at">> & {
  id?: string;
};

export type EntitlementTokenSalePatchV1 = Partial<Omit<EntitlementTokenSaleV1, "recorded_at" | "updated_at">> & {
  sale_txid: string;
  rule_id: string;
};

const TDPLUS_CA = "d0d62c9ce8b93a9d2b52801d8d336c28ea7b2b7d48588ae9fb556407dbc9f23a";
const TDPRO_CA = "853d6d0deb46c10369a76d0cdf0cd30ebaa178f5a39c5b2b4789caff562808a3";
const TOKEN_DEPOT_SELLER_ADDRESS = "kaspa:qpkxn24070npk7cx336vlfa6wcj8cvcgrwd482rxdeqn9qrsd6gkzkpt9sr94";

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "entitlement-token-settings.v1.json");
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

function createEntitlementRuleId(): string {
  return `ETR_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

function normalizeAddress(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function normalizeUserId(value: unknown): string | null {
  const s = normalizeString(value);
  return /^[A-Za-z0-9_-]{3,120}$/.test(s) ? s : null;
}

function normalizeHex64(value: unknown): string {
  const s = normalizeString(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

function normalizeRuleId(value: unknown): string {
  const s = normalizeString(value);
  return /^[A-Za-z0-9_-]{3,80}$/.test(s) ? s : "";
}

function normalizeStatus(value: unknown): EntitlementRuleStatus {
  if (value === "archived" || value === "active") return value;
  return "active";
}

function normalizeOwnerScope(value: unknown): EntitlementOwnerScope {
  if (value === "tenant" || value === "broker") return value;
  return "broker";
}

function normalizePackageType(value: unknown): EntitlementPackageType | null {
  if (value === "PLUS" || value === "PRO" || value === "TENANT") return value;
  return null;
}

function normalizeSaleStatus(value: unknown): EntitlementSaleStatus {
  if (value === "verified" || value === "rejected" || value === "pending") return value;
  return "pending";
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.trunc(n);
  return whole >= 1 ? whole : fallback;
}

function normalizeGateText(value: unknown, fallback: string, maxLength: number): string {
  const s = normalizeString(value);
  const text = s || fallback;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEmailAddress(value: unknown): string {
  const s = normalizeString(value).toLowerCase();
  if (!s) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function defaultOperatorEmailSubject(label: string): string {
  return `${label} entitlement purchase recorded`;
}

function defaultOperatorEmailBody(label: string): string {
  return `A ${label} entitlement purchase was recorded. Review the proof details below and complete any required setup steps.`;
}

function defaultGateTitle(label: string): string {
  return `${label} license required`;
}

function defaultGateBody(label: string): string {
  return `${label} license required.`;
}

function defaultGateTestnetNote(): string {
  return "These pages are free to use with testnet-10 without a license.";
}

function defaultGateWarning(): string {
  return "Warning: The testnet-10 network is not a permanent record. It is not for real-world use cases. Data stored there will be deleted from time to time.";
}

function defaultGateButtonLabel(): string {
  return "OK";
}

function normalizeIsoOrNull(value: unknown): string | null {
  const s = normalizeString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  const desiredDay = d.getUTCDate();
  const out = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    1,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  ));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(desiredDay, lastDay));
  return out.toISOString();
}

function defaultRule(id: string, packageType: EntitlementPackageType, triggerCa: string, label: string): EntitlementTokenRuleV1 {
  const ts = nowIso();
  return {
    id,
    status: "active",
    owner_scope: "broker",
    tenant_id: null,
    brand_id: null,
    package_type: packageType,
    network: "mainnet",
    trigger_ca: triggerCa,
    trigger_label: label,
    seller_address: TOKEN_DEPOT_SELLER_ADDRESS,
    active_months: 12,
    grace_months: 1,
    gate_title: defaultGateTitle(label),
    gate_body: defaultGateBody(label),
    gate_testnet_note: defaultGateTestnetNote(),
    gate_warning: defaultGateWarning(),
    gate_button_label: defaultGateButtonLabel(),
    operator_email_enabled: false,
    operator_email_to: "",
    operator_email_subject: defaultOperatorEmailSubject(label),
    operator_email_body: defaultOperatorEmailBody(label),
    created_at: ts,
    updated_at: ts
  };
}

function initialStore(): EntitlementTokenStoreV1 {
  return {
    version: 1,
    rules: [
      defaultRule("tdplus_default", "PLUS", TDPLUS_CA, "TDPLUS"),
      defaultRule("tdpro_default", "PRO", TDPRO_CA, "TDPRO")
    ],
    sales: []
  };
}

function ensureStoreFile(p: string): void {
  ensureDir(path.dirname(p));
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(initialStore(), null, 2) + "\n", "utf8");
  }
}

function normalizeRule(input: unknown): EntitlementTokenRuleV1 | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!obj) return null;

  const id = normalizeRuleId(obj.id);
  const package_type = normalizePackageType(obj.package_type);
  const owner_scope = normalizeOwnerScope(obj.owner_scope);
  const tenant_id = normalizeNullableString(obj.tenant_id);
  const trigger_ca = normalizeHex64(obj.trigger_ca);
  const seller_address = normalizeAddress(obj.seller_address);
  const created_at = normalizeIsoOrNull(obj.created_at);
  const updated_at = normalizeIsoOrNull(obj.updated_at) || created_at;

  if (!id) return null;
  if (!package_type) return null;
  if (owner_scope === "tenant" && !tenant_id) return null;
  if (!trigger_ca) return null;
  if (!seller_address.startsWith("kaspa:")) return null;
  if (!created_at || !updated_at) return null;

  const trigger_label = normalizeString(obj.trigger_label) || package_type;

  return {
    id,
    status: normalizeStatus(obj.status),
    owner_scope,
    tenant_id: owner_scope === "tenant" ? tenant_id : null,
    brand_id: normalizeNullableString(obj.brand_id),
    package_type,
    network: "mainnet",
    trigger_ca,
    trigger_label,
    seller_address,
    active_months: normalizePositiveInteger(obj.active_months, 12),
    grace_months: normalizePositiveInteger(obj.grace_months, 1),
    gate_title: normalizeGateText(obj.gate_title, defaultGateTitle(trigger_label), 120),
    gate_body: normalizeGateText(obj.gate_body, defaultGateBody(trigger_label), 1000),
    gate_testnet_note: normalizeGateText(obj.gate_testnet_note, defaultGateTestnetNote(), 1000),
    gate_warning: normalizeGateText(obj.gate_warning, defaultGateWarning(), 1000),
    gate_button_label: normalizeGateText(obj.gate_button_label, defaultGateButtonLabel(), 80),
    operator_email_enabled: obj.operator_email_enabled === true,
    operator_email_to: normalizeEmailAddress(obj.operator_email_to),
    operator_email_subject: normalizeGateText(obj.operator_email_subject, defaultOperatorEmailSubject(trigger_label), 160),
    operator_email_body: normalizeGateText(obj.operator_email_body, defaultOperatorEmailBody(trigger_label), 2000),
    created_at,
    updated_at
  };
}

function normalizeSale(input: unknown, rules: EntitlementTokenRuleV1[]): EntitlementTokenSaleV1 | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!obj) return null;

  const sale_txid = normalizeHex64(obj.sale_txid);
  const rule_id = normalizeRuleId(obj.rule_id);
  const rule = rules.find((candidate) => candidate.id === rule_id) || null;
  const seller_address = normalizeAddress(obj.seller_address);
  const recipient_address = normalizeAddress(obj.recipient_address);
  const user_id = normalizeUserId(obj.user_id);
  const amount_units = normalizeString(obj.amount_units);
  const accepted_at = normalizeIsoOrNull(obj.accepted_at);
  const recorded_at = normalizeIsoOrNull(obj.recorded_at);
  const updated_at = normalizeIsoOrNull(obj.updated_at) || recorded_at;

  if (!sale_txid) return null;
  if (!rule) return null;
  if (seller_address !== rule.seller_address) return null;
  if (!recipient_address.startsWith("kaspa:")) return null;
  if (!amount_units) return null;
  if (!accepted_at || !recorded_at || !updated_at) return null;

  const active_months = normalizePositiveInteger(obj.active_months, rule.active_months);
  const grace_months = normalizePositiveInteger(obj.grace_months, rule.grace_months);
  const verified_at = normalizeIsoOrNull(obj.verified_at);
  const reject_reason = normalizeString(obj.reject_reason);
  const notes = normalizeString(obj.notes);

  const out: EntitlementTokenSaleV1 = {
    sale_txid,
    rule_id: rule.id,
    package_type: rule.package_type,
    network: "mainnet",
    trigger_ca: rule.trigger_ca,
    trigger_label: rule.trigger_label,
    seller_address: rule.seller_address,
    recipient_address,
    user_id,
    amount_units,
    accepted_at,
    active_months,
    grace_months,
    status: normalizeSaleStatus(obj.status),
    recorded_at,
    updated_at
  };

  if (verified_at) out.verified_at = verified_at;
  if (reject_reason) out.reject_reason = reject_reason;
  if (notes) out.notes = notes;

  return out;
}

function normalizeStore(input: unknown): EntitlementTokenStoreV1 {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
  const normalizedRules = rawRules
    .map((x) => normalizeRule(x))
    .filter((x): x is EntitlementTokenRuleV1 => !!x);
  const rules = normalizedRules.length ? normalizedRules : initialStore().rules;
  const rawSales = Array.isArray(obj.sales) ? obj.sales : [];
  const sales = rawSales
    .map((x) => normalizeSale(x, rules))
    .filter((x): x is EntitlementTokenSaleV1 => !!x)
    .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));

  return {
    version: 1,
    rules: rules.sort((a, b) => a.package_type.localeCompare(b.package_type) || a.id.localeCompare(b.id)),
    sales
  };
}

export function readEntitlementTokenStore(repoRoot: string): EntitlementTokenStoreV1 {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeStore(parsed);
}

export function writeEntitlementTokenStore(repoRoot: string, store: EntitlementTokenStoreV1): void {
  const normalized = normalizeStore(store);
  atomicWriteJson(storePath(repoRoot), normalized);
}

export function readEntitlementTokenRaw(repoRoot: string): { filename: string; content: string } {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  return {
    filename: path.basename(p),
    content: fs.readFileSync(p, "utf8")
  };
}

export function listEntitlementTokenRules(repoRoot: string): EntitlementTokenRuleV1[] {
  return readEntitlementTokenStore(repoRoot).rules;
}

export function listEntitlementTokenSales(repoRoot: string): EntitlementTokenSaleV1[] {
  return readEntitlementTokenStore(repoRoot).sales;
}

export function getEntitlementTokenRuleById(repoRoot: string, id: string): EntitlementTokenRuleV1 | null {
  const normalizedId = normalizeRuleId(id);
  if (!normalizedId) return null;
  return listEntitlementTokenRules(repoRoot).find((rule) => rule.id === normalizedId) || null;
}

function calculateEntitlementPackageFromSales(
  packageType: EntitlementPackageType,
  addresses: string[],
  userIds: string[],
  sales: EntitlementTokenSaleV1[],
  asOfIso: string
): EntitlementPackageStatusV1 {
  const package_type = normalizePackageType(packageType) || packageType;
  const addressSet = new Set(addresses.map((addr) => normalizeAddress(addr)).filter((addr) => addr.startsWith("kaspa:")));
  const userIdSet = new Set(userIds.map((id) => normalizeUserId(id)).filter((id): id is string => !!id));
  const asOf = normalizeIsoOrNull(asOfIso) || nowIso();

  let active_until: string | null = null;
  let grace_until: string | null = null;
  let latest_sale_txid: string | null = null;
  let latest_accepted_at: string | null = null;

  const sortedSales = sales
    .filter((sale) => sale.status === "verified")
    .filter((sale) => sale.package_type === package_type)
    .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at));

  for (const sale of sortedSales) {
    const saleAt = sale.accepted_at;
    const base = active_until && grace_until && saleAt <= grace_until ? active_until : saleAt;
    active_until = addMonthsIso(base, sale.active_months);
    grace_until = addMonthsIso(active_until, sale.grace_months);
    latest_sale_txid = sale.sale_txid;
    latest_accepted_at = saleAt;
    if (sale.recipient_address) addressSet.add(normalizeAddress(sale.recipient_address));
    if (sale.user_id) userIdSet.add(sale.user_id);
  }

  const active = !!active_until && asOf <= active_until;
  const in_grace = !active && !!grace_until && asOf <= grace_until;
  const expired = !!grace_until && !active && !in_grace;

  return {
    package_type,
    addresses: Array.from(addressSet),
    user_ids: Array.from(userIdSet),
    sale_count: sortedSales.length,
    active,
    in_grace,
    expired,
    renewal_reminder_required: in_grace,
    latest_sale_txid,
    latest_accepted_at,
    active_until,
    grace_until
  };
}

export function calculateEntitlementPackageForAddresses(
  repoRoot: string,
  packageType: EntitlementPackageType,
  addresses: string[],
  asOfIso = nowIso()
): EntitlementPackageStatusV1 {
  const addressSet = new Set(addresses.map((addr) => normalizeAddress(addr)).filter((addr) => addr.startsWith("kaspa:")));
  const sales = readEntitlementTokenStore(repoRoot).sales
    .filter((sale) => addressSet.has(normalizeAddress(sale.recipient_address)));
  return calculateEntitlementPackageFromSales(packageType, Array.from(addressSet), [], sales, asOfIso);
}

export function calculateEntitlementPackageForUserIds(
  repoRoot: string,
  packageType: EntitlementPackageType,
  userIds: string[],
  asOfIso = nowIso()
): EntitlementPackageStatusV1 {
  const userIdSet = new Set(userIds.map((id) => normalizeUserId(id)).filter((id): id is string => !!id));
  const sales = readEntitlementTokenStore(repoRoot).sales
    .filter((sale) => !!sale.user_id && userIdSet.has(sale.user_id));
  return calculateEntitlementPackageFromSales(packageType, [], Array.from(userIdSet), sales, asOfIso);
}

function entitlementStatusDateMs(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function chooseLatestEntitlementStatus(statuses: EntitlementPackageStatusV1[]): EntitlementPackageStatusV1 | null {
  if (statuses.length === 0) return null;
  return statuses
    .slice()
    .sort((a, b) => entitlementStatusDateMs(b.grace_until) - entitlementStatusDateMs(a.grace_until))[0] || null;
}

export function calculateWalletPlusEntitlementForUserIds(
  repoRoot: string,
  userIds: string[],
  savedSkinId: string,
  asOfIso = nowIso()
): EntitlementWalletPlusStatusV1 {
  const savedSkin = normalizeString(savedSkinId) || "classic_teal";
  const packageStatuses = (["PLUS", "PRO", "TENANT"] as EntitlementPackageType[])
    .map((packageType) => calculateEntitlementPackageForUserIds(repoRoot, packageType, userIds, asOfIso));

  const activeStatus = chooseLatestEntitlementStatus(packageStatuses.filter((status) => status.active));
  const graceStatus = activeStatus ? null : chooseLatestEntitlementStatus(packageStatuses.filter((status) => status.in_grace));
  const bestStatus = activeStatus || graceStatus;

  if (!bestStatus) {
    return {
      status: "expired",
      wallet_plus_active: false,
      wallet_plus_grace: false,
      ads_enabled: true,
      renewal_reminder_required: false,
      saved_skin_id: savedSkin,
      effective_skin_id: "classic_teal",
      qualifying_sale_txid: null,
      qualifying_sale_accepted_at: null,
      active_until: null,
      grace_until: null
    };
  }

  const inGrace = !activeStatus && !!graceStatus;

  return {
    status: inGrace ? "grace" : "active",
    wallet_plus_active: true,
    wallet_plus_grace: inGrace,
    ads_enabled: false,
    renewal_reminder_required: inGrace,
    saved_skin_id: savedSkin,
    effective_skin_id: savedSkin,
    qualifying_sale_txid: bestStatus.latest_sale_txid,
    qualifying_sale_accepted_at: bestStatus.latest_accepted_at,
    active_until: bestStatus.active_until,
    grace_until: bestStatus.grace_until
  };
}

export function upsertEntitlementTokenRule(repoRoot: string, patch: EntitlementTokenRulePatchV1): EntitlementTokenRuleV1 {
  const store = readEntitlementTokenStore(repoRoot);
  const ts = nowIso();
  const id = normalizeRuleId(patch.id) || createEntitlementRuleId();
  const existing = store.rules.find((rule) => rule.id === id) || null;

  const normalized = normalizeRule({
    ...(existing || {}),
    ...patch,
    id,
    created_at: existing ? existing.created_at : ts,
    updated_at: ts
  });

  if (!normalized) throw new Error("invalid_entitlement_token_rule");

  const nextRules = store.rules.filter((rule) => rule.id !== id);
  nextRules.push(normalized);
  writeEntitlementTokenStore(repoRoot, {
    version: 1,
    rules: nextRules,
    sales: store.sales
  });

  return normalized;
}

export function upsertEntitlementTokenSale(repoRoot: string, patch: EntitlementTokenSalePatchV1): EntitlementTokenSaleV1 {
  const store = readEntitlementTokenStore(repoRoot);
  const ts = nowIso();
  const sale_txid = normalizeHex64(patch.sale_txid);
  const existing = store.sales.find((sale) => sale.sale_txid === sale_txid) || null;

  const normalized = normalizeSale(
    {
      ...(existing || {}),
      ...patch,
      sale_txid,
      recorded_at: existing ? existing.recorded_at : ts,
      updated_at: ts
    },
    store.rules
  );

  if (!normalized) throw new Error("invalid_entitlement_token_sale");

  const nextSales = store.sales.filter((sale) => sale.sale_txid !== sale_txid);
  nextSales.push(normalized);
  writeEntitlementTokenStore(repoRoot, {
    version: 1,
    rules: store.rules,
    sales: nextSales
  });

  return normalized;
}
