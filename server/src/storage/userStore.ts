import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type UserRecord = {
  id: string;
  label: string;
  created_at: string;

  email?: string;
  phone?: string;
  tenant_id?: string | null;

  password_algo?: "scrypt";
  password_salt_hex?: string;
  password_hash_hex?: string;
  password_set_at?: string;
};

export type UserNotificationSettings = {
  funds_sent: boolean;
  whitelist_added: boolean;
  whitelist_removed: boolean;
  new_offers: boolean;
  maker_offer_created: boolean;
  maker_offer_filled: boolean;
  entitlement_purchase: boolean;
  wallet_created_standard: boolean;
  wallet_created_compliance: boolean;
  wallet_deleted: boolean;
};

export type UserWalletTier = "basic" | "wallet_plus";
export type UserSkinId = "classic_teal" | "pink" | "pink_black" | "gold" | "gold_black" | "blue" | "blue_black" | "green" | "green_black" | "red" | "red_black" | "yellow" | "yellow_black" | "cyan" | "cyan_black" | "orange" | "orange_black";

export type UserProfileRecord = {
  id: string;
  label: string;
  created_at: string;

  email?: string;
  phone?: string;

  first_name?: string;
  last_name?: string;
  address?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;

  notification_destination?: string;
  notifications?: UserNotificationSettings;

  wallet_tier: UserWalletTier;
  skin_id: UserSkinId;

  updated_at?: string;
};

export type UserProfilePatch = {
  email: string;
  phone: string;

  first_name?: string;
  last_name?: string;
  address?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;

  notification_destination?: string;
  notifications?: Partial<UserNotificationSettings>;
};

type UserIndex = {
  items: UserRecord[];
};

function usersDir(repoRoot: string): string {
  return path.join(repoRoot, "data", "users");
}

function userIndexPath(repoRoot: string): string {
  return path.join(usersDir(repoRoot), "_index.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureIndexFile(filePath: string): void {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    const initial: UserIndex = { items: [] };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readIndex(repoRoot: string): UserIndex {
  const p = userIndexPath(repoRoot);
  ensureIndexFile(p);

  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as UserIndex;

  if (!parsed || typeof parsed !== "object") throw new Error("users/_index.json: invalid JSON root");
  if (!Array.isArray(parsed.items)) throw new Error("users/_index.json: items must be an array");

  return {
    items: parsed.items.map((item) => normalizeUserRecord(item))
  };
}

function writeIndex(repoRoot: string, idx: UserIndex): void {
  atomicWriteJson(userIndexPath(repoRoot), idx);
}

function normalizeTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s : null;
}

function normalizeUserRecord(input: Partial<UserRecord>): UserRecord {
  const id = String(input.id || "").trim();
  const label = String(input.label || "").trim();
  const created_at = String(input.created_at || "").trim();

  if (!id) throw new Error("users/_index.json: user.id is required");
  if (!label) throw new Error("users/_index.json: user.label is required");
  if (!created_at) throw new Error("users/_index.json: user.created_at is required");

  const out: UserRecord = {
    id,
    label,
    created_at,
    tenant_id: normalizeTenantId(input.tenant_id)
  };

  if (typeof input.email === "string" && input.email.trim()) out.email = input.email.trim();
  if (typeof input.phone === "string" && input.phone.trim()) out.phone = input.phone.trim();
  if (input.password_algo === "scrypt") out.password_algo = "scrypt";
  if (typeof input.password_salt_hex === "string" && input.password_salt_hex.trim()) {
    out.password_salt_hex = input.password_salt_hex.trim();
  }
  if (typeof input.password_hash_hex === "string" && input.password_hash_hex.trim()) {
    out.password_hash_hex = input.password_hash_hex.trim();
  }
  if (typeof input.password_set_at === "string" && input.password_set_at.trim()) {
    out.password_set_at = input.password_set_at.trim();
  }

  return out;
}

export function listUsers(repoRoot: string): UserRecord[] {
  const idx = readIndex(repoRoot);
  return idx.items.slice();
}

export function getUser(repoRoot: string, userId: string): UserRecord | null {
  const idx = readIndex(repoRoot);
  return idx.items.find((u) => u.id === userId) ?? null;
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function findUserByEmail(repoRoot: string, email: string): UserRecord | null {
  const e = normalizeEmail(email);
  if (!e) return null;

  const idx = readIndex(repoRoot);
  return idx.items.find((u) => normalizeEmail(u.email || "") === e) ?? null;
}

function normalizePhone(phone: string): string {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/[^\d]/g, "");
  // Treat "+1XXXXXXXXXX" and "1XXXXXXXXXX" as the same as "XXXXXXXXXX" for uniqueness.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function findUserByPhone(repoRoot: string, phone: string): UserRecord | null {
  const p = normalizePhone(phone);
  if (!p) return null;

  const idx = readIndex(repoRoot);
  return idx.items.find((u) => normalizePhone(u.phone || "") === p) ?? null;
}

function scryptHash(password: string, salt: Buffer): Buffer {
  // Node crypto.scryptSync uses { cost, blockSize, parallelization }
  return crypto.scryptSync(password, salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 });
}

function validatePassword(pw: string): void {
  if (!pw) throw new Error("password_required");
  if (pw.length < 10) throw new Error("password_too_short");

  // Allowed specials: $ # @ * & - ?
  // Disallow spaces and all other punctuation to keep UI+email+logs safe and predictable.
  const allowed = /^[A-Za-z0-9$#@*&\-?]+$/;
  if (!allowed.test(pw)) throw new Error("password_invalid_chars");

  if (!/[a-z]/.test(pw)) throw new Error("password_needs_lowercase");
  if (!/[A-Z]/.test(pw)) throw new Error("password_needs_uppercase");
  if (!/[0-9]/.test(pw)) throw new Error("password_needs_number");
}

export function verifyUserPassword(u: UserRecord, password: string): boolean {
  if (!u.password_salt_hex || !u.password_hash_hex || u.password_algo !== "scrypt") return false;
  const salt = Buffer.from(u.password_salt_hex, "hex");
  const expected = Buffer.from(u.password_hash_hex, "hex");
  const actual = scryptHash(password, salt);
  return crypto.timingSafeEqual(expected, actual);
}

export function setUserIdentity(repoRoot: string, userId: string, email?: string, phone?: string): UserRecord {
  const idx = readIndex(repoRoot);
  const u = idx.items.find((x) => x.id === userId);
  if (!u) throw new Error("user_not_found");

  if (typeof email === "string") {
    const next = normalizeEmail(email);
    if (next) {
      const other = idx.items.find((x) => x.id !== userId && normalizeEmail(x.email || "") === next);
      if (other) throw new Error("email_in_use");
    }
    u.email = next || undefined;
  }

  if (typeof phone === "string") {
    const next = String(phone || "").trim();
    if (next) {
      const norm = normalizePhone(next);
      if (norm) {
        const other = idx.items.find((x) => x.id !== userId && normalizePhone(x.phone || "") === norm);
        if (other) throw new Error("phone_in_use");
      }
    }
    u.phone = next || undefined;
  }

  writeIndex(repoRoot, idx);
  return u;
}

export function setUserTenantId(repoRoot: string, userId: string, tenantId: string | null): UserRecord {
  const id = String(userId || "").trim();
  if (!id) throw new Error("user_not_found");

  const idx = readIndex(repoRoot);
  const u = idx.items.find((x) => x.id === id);
  if (!u) throw new Error("user_not_found");

  u.tenant_id = normalizeTenantId(tenantId);
  writeIndex(repoRoot, idx);
  return u;
}

export function reassignUsersTenantId(repoRoot: string, oldTenantId: string, newTenantId: string): number {
  const oldId = normalizeTenantId(oldTenantId);
  const newId = normalizeTenantId(newTenantId);

  if (!oldId) throw new Error("old_tenant_id_required");
  if (!newId) throw new Error("new_tenant_id_required");
  if (oldId === newId) throw new Error("tenant_reassign_same_id");

  const idx = readIndex(repoRoot);
  let changed = 0;

  for (const u of idx.items) {
    if (normalizeTenantId(u.tenant_id) !== oldId) continue;
    u.tenant_id = newId;
    changed += 1;
  }

  if (changed > 0) writeIndex(repoRoot, idx);
  return changed;
}

export type UserPasswordAuth = {
  password_algo: "scrypt";
  password_salt_hex: string;
  password_hash_hex: string;
};

export function makeUserPasswordAuth(password: string): UserPasswordAuth {
  const pw = String(password || "");
  validatePassword(pw);

  const salt = crypto.randomBytes(16);
  const hash = scryptHash(pw, salt);

  return {
    password_algo: "scrypt",
    password_salt_hex: salt.toString("hex"),
    password_hash_hex: hash.toString("hex")
  };
}

function validateUserPasswordAuth(auth: UserPasswordAuth): UserPasswordAuth {
  if (!auth || typeof auth !== "object") throw new Error("password_auth_invalid");
  if (auth.password_algo !== "scrypt") throw new Error("password_auth_algo_invalid");

  const saltHex = String(auth.password_salt_hex || "").trim().toLowerCase();
  const hashHex = String(auth.password_hash_hex || "").trim().toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(saltHex)) throw new Error("password_auth_salt_invalid");
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error("password_auth_hash_invalid");

  return {
    password_algo: "scrypt",
    password_salt_hex: saltHex,
    password_hash_hex: hashHex
  };
}

export function setUserAuthHash(repoRoot: string, userId: string, auth: UserPasswordAuth): UserRecord {
  const normalized = validateUserPasswordAuth(auth);

  const idx = readIndex(repoRoot);
  const u = idx.items.find((x) => x.id === userId);
  if (!u) throw new Error("user_not_found");

  u.password_algo = normalized.password_algo;
  u.password_salt_hex = normalized.password_salt_hex;
  u.password_hash_hex = normalized.password_hash_hex;
  u.password_set_at = new Date().toISOString();

  writeIndex(repoRoot, idx);
  return u;
}

export function setUserAuth(repoRoot: string, userId: string, password: string): UserRecord {
  return setUserAuthHash(repoRoot, userId, makeUserPasswordAuth(password));
}

function userProfilePath(repoRoot: string, userId: string): string {
  return path.join(usersDir(repoRoot), userId, "profile.json");
}

function normOpt(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

const DEFAULT_USER_WALLET_TIER: UserWalletTier = "basic";
const DEFAULT_USER_SKIN_ID: UserSkinId = "classic_teal";

function normalizeUserWalletTier(input: unknown): UserWalletTier {
  if (input === "wallet_plus") return "wallet_plus";
  return DEFAULT_USER_WALLET_TIER;
}

function normalizeUserSkinId(input: unknown): UserSkinId {
  if (input === "classic_teal") return "classic_teal";
  if (input === "pink") return "pink";
  if (input === "pink_black") return "pink_black";
  if (input === "gold") return "gold";
  if (input === "gold_black") return "gold_black";
  if (input === "blue") return "blue";
  if (input === "blue_black") return "blue_black";
  if (input === "green") return "green";
  if (input === "green_black") return "green_black";
  if (input === "red") return "red";
  if (input === "red_black") return "red_black";
  if (input === "yellow") return "yellow";
  if (input === "yellow_black") return "yellow_black";
  if (input === "cyan") return "cyan";
  if (input === "cyan_black") return "cyan_black";
  if (input === "orange") return "orange";
  if (input === "orange_black") return "orange_black";
  return DEFAULT_USER_SKIN_ID;
}

const DEFAULT_USER_NOTIFICATION_SETTINGS: UserNotificationSettings = {
  funds_sent: false,
  whitelist_added: false,
  whitelist_removed: false,
  new_offers: false,
  maker_offer_created: false,
  maker_offer_filled: false,
  entitlement_purchase: false,
  wallet_created_standard: false,
  wallet_created_compliance: false,
  wallet_deleted: false
};

function normalizeUserNotificationSettings(
  input: unknown,
  fallback?: UserNotificationSettings
): UserNotificationSettings {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const base = fallback ?? DEFAULT_USER_NOTIFICATION_SETTINGS;

  return {
    funds_sent: typeof src.funds_sent === "boolean" ? src.funds_sent : base.funds_sent,
    whitelist_added: typeof src.whitelist_added === "boolean" ? src.whitelist_added : base.whitelist_added,
    whitelist_removed: typeof src.whitelist_removed === "boolean" ? src.whitelist_removed : base.whitelist_removed,
    new_offers: typeof src.new_offers === "boolean" ? src.new_offers : base.new_offers,
    maker_offer_created:
      typeof src.maker_offer_created === "boolean" ? src.maker_offer_created : base.maker_offer_created,
    maker_offer_filled:
      typeof src.maker_offer_filled === "boolean" ? src.maker_offer_filled : base.maker_offer_filled,
    entitlement_purchase:
      typeof src.entitlement_purchase === "boolean" ? src.entitlement_purchase : base.entitlement_purchase,
    wallet_created_standard:
      typeof src.wallet_created_standard === "boolean"
        ? src.wallet_created_standard
        : base.wallet_created_standard,
    wallet_created_compliance:
      typeof src.wallet_created_compliance === "boolean"
        ? src.wallet_created_compliance
        : base.wallet_created_compliance,
    wallet_deleted: typeof src.wallet_deleted === "boolean" ? src.wallet_deleted : base.wallet_deleted
  };
}

function pickProfileOptString(next: unknown, fallback?: string): string | undefined {
  if (typeof next === "undefined") return fallback;
  return normOpt(next);
}

export function readUserProfile(repoRoot: string, userId: string): UserProfileRecord {
  const u = getUser(repoRoot, userId);
  if (!u) throw new Error("user_not_found");

  const p = userProfilePath(repoRoot, userId);
  let fileObj: any = null;

  if (fs.existsSync(p)) {
    try {
      fileObj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      fileObj = null;
    }
  }

  const out: UserProfileRecord = {
    id: u.id,
    label: u.label,
    created_at: u.created_at,
    email: u.email,
    phone: u.phone,
    wallet_tier: DEFAULT_USER_WALLET_TIER,
    skin_id: DEFAULT_USER_SKIN_ID
  };

  if (fileObj && typeof fileObj === "object") {
    out.first_name = normOpt(fileObj.first_name);
    out.last_name = normOpt(fileObj.last_name);
    out.address = normOpt(fileObj.address);
    out.city = normOpt(fileObj.city);
    out.region = normOpt(fileObj.region);
    out.postal_code = normOpt(fileObj.postal_code);
    out.country = normOpt(fileObj.country);
    out.notification_destination = normOpt(fileObj.notification_destination);
    out.notifications = normalizeUserNotificationSettings(fileObj.notifications);
    out.wallet_tier = normalizeUserWalletTier(fileObj.wallet_tier);
    out.skin_id = normalizeUserSkinId(fileObj.skin_id);
    out.updated_at = normOpt(fileObj.updated_at);
  } else {
    out.notifications = normalizeUserNotificationSettings(undefined);
  }

  return out;
}

export function saveUserProfile(repoRoot: string, userId: string, patch: UserProfilePatch): UserProfileRecord {
  if (!patch || typeof patch !== "object") throw new Error("invalid_profile_patch");

  const email = String(patch.email || "").trim();
  const phone = String(patch.phone || "").trim();
  if (!email) throw new Error("missing_email");
  if (!phone) throw new Error("missing_phone");

  // Updates index (authoritative for login) and enforces unique email.
  setUserIdentity(repoRoot, userId, email, phone);

  const u = getUser(repoRoot, userId);
  if (!u) throw new Error("user_not_found");

  const existing = readUserProfile(repoRoot, userId);

  const merged: UserProfileRecord = {
    id: u.id,
    label: u.label,
    created_at: u.created_at,
    email: u.email,
    phone: u.phone,

    first_name: normOpt(patch.first_name),
    last_name: normOpt(patch.last_name),
    address: normOpt(patch.address),
    city: normOpt(patch.city),
    region: normOpt(patch.region),
    postal_code: normOpt(patch.postal_code),
    country: normOpt(patch.country),

    notification_destination: pickProfileOptString(
      patch.notification_destination,
      existing.notification_destination
    ),
    notifications: normalizeUserNotificationSettings(
      patch.notifications,
      existing.notifications
    ),

    wallet_tier: existing.wallet_tier,
    skin_id: existing.skin_id,

    updated_at: new Date().toISOString()
  };

  atomicWriteJson(userProfilePath(repoRoot, userId), merged);
  return merged;
}

export function saveUserSkin(repoRoot: string, userId: string, skinId: unknown): UserProfileRecord {
  const existing = readUserProfile(repoRoot, userId);
  const next: UserProfileRecord = {
    ...existing,
    skin_id: normalizeUserSkinId(skinId),
    updated_at: new Date().toISOString()
  };

  atomicWriteJson(userProfilePath(repoRoot, userId), next);
  return readUserProfile(repoRoot, userId);
}

function generateUserId(): string {
  const ts = Date.now();
  const rnd = crypto.randomBytes(4).toString("hex");
  return `USR_${ts}_${rnd}`;
}

export function createUser(repoRoot: string, label: string): UserRecord {
  const safeLabel = String(label || "").trim();
  if (!safeLabel) throw new Error("label_required");
  if (safeLabel.length > 64) throw new Error("label_too_long");

  const idx = readIndex(repoRoot);
  const record: UserRecord = {
    id: generateUserId(),
    label: safeLabel,
    created_at: new Date().toISOString(),
    tenant_id: null
  };
  idx.items.push(record);
  writeIndex(repoRoot, idx);

  // Ensure per-user dir exists for later CBs.
  const dir = path.join(usersDir(repoRoot), record.id);
  ensureDir(dir);

  const profilePath = path.join(dir, "profile.json");
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, JSON.stringify({ id: record.id, label: record.label }, null, 2) + "\n", "utf8");
  }

  return record;
}

export function deleteUser(repoRoot: string, userId: string): void {
  const id = String(userId || "").trim();
  if (!id) return;

  const idx = readIndex(repoRoot);
  const nextItems = idx.items.filter((u) => u.id !== id);
  if (nextItems.length !== idx.items.length) {
    idx.items = nextItems;
    writeIndex(repoRoot, idx);
  }

  const dir = path.join(usersDir(repoRoot), id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
