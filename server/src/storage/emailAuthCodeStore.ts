import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type EmailAuthPurpose = "signup" | "login" | "profile_email";

export type EmailAuthPendingSignup = {
  name: string;
  email: string;
  phone: string;
  wants_license: boolean;
  password_algo: "scrypt";
  password_salt_hex: string;
  password_hash_hex: string;
  tenant_id: string | null;
  tenant_signup_notify_email: string | null;
  ip: string | null;
};

export type EmailAuthPendingProfileEmailChange = {
  email: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  notification_destination: string | null;
  notifications: Record<string, boolean> | null;
  ip: string | null;
};

export type EmailAuthCodeRecord = {
  purpose: EmailAuthPurpose;
  email: string;
  user_id: string | null;
  code_hash_hex: string;
  expires_at_ms: number;
  created_at_ms: number;
  last_send_at_ms: number;
  attempts: number;
  pending_signup: EmailAuthPendingSignup | null;
  pending_profile_email_change?: EmailAuthPendingProfileEmailChange | null;
};

type EmailAuthCodeStore = {
  version: 1;
  items: EmailAuthCodeRecord[];
};

export type EmailAuthVerifyResult =
  | { ok: true; record: EmailAuthCodeRecord }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "invalid_code" };

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "users", "_email_auth_codes.v1.json");
}

function safeParseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath: string, obj: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const body = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function normalizePurpose(purpose: unknown): EmailAuthPurpose | null {
  const p = String(purpose || "").trim().toLowerCase();
  if (p === "signup" || p === "login" || p === "profile_email") return p;
  return null;
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s : null;
}

function normalizePendingSignup(input: unknown): EmailAuthPendingSignup | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;

  const name = normalizeNullableString(src.name) || "";
  const email = normalizeEmail(typeof src.email === "string" ? src.email : "");
  const phone = normalizeNullableString(src.phone) || "";
  const wants_license = src.wants_license === true;
  const password_algo = src.password_algo === "scrypt" ? "scrypt" : null;
  const password_salt_hex = normalizeNullableString(src.password_salt_hex) || "";
  const password_hash_hex = normalizeNullableString(src.password_hash_hex) || "";
  const tenant_id = normalizeNullableString(src.tenant_id);
  const tenant_signup_notify_email = normalizeNullableString(src.tenant_signup_notify_email);
  const ip = normalizeNullableString(src.ip);

  if (!email) return null;
  if (password_algo !== "scrypt") return null;
  if (!/^[0-9a-f]{32}$/i.test(password_salt_hex)) return null;
  if (!/^[0-9a-f]{64}$/i.test(password_hash_hex)) return null;

  return {
    name,
    email,
    phone,
    wants_license,
    password_algo,
    password_salt_hex: password_salt_hex.toLowerCase(),
    password_hash_hex: password_hash_hex.toLowerCase(),
    tenant_id,
    tenant_signup_notify_email,
    ip
  };
}

function normalizePendingProfileEmailChange(input: unknown): EmailAuthPendingProfileEmailChange | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;

  const email = normalizeEmail(typeof src.email === "string" ? src.email : "");
  const phone = normalizeNullableString(src.phone) || "";
  const first_name = normalizeNullableString(src.first_name);
  const last_name = normalizeNullableString(src.last_name);
  const address = normalizeNullableString(src.address);
  const city = normalizeNullableString(src.city);
  const region = normalizeNullableString(src.region);
  const postal_code = normalizeNullableString(src.postal_code);
  const country = normalizeNullableString(src.country);
  const notification_destination = normalizeNullableString(src.notification_destination);
  const ip = normalizeNullableString(src.ip);

  let notifications: Record<string, boolean> | null = null;
  if (src.notifications && typeof src.notifications === "object" && !Array.isArray(src.notifications)) {
    notifications = {};
    for (const [key, value] of Object.entries(src.notifications as Record<string, unknown>)) {
      const k = String(key || "").trim();
      if (!k) continue;
      if (value === true || value === false) notifications[k] = value;
    }
  }

  if (!email) return null;
  if (!phone) return null;

  return {
    email,
    phone,
    first_name,
    last_name,
    address,
    city,
    region,
    postal_code,
    country,
    notification_destination,
    notifications,
    ip
  };
}

function normalizeRecord(input: unknown): EmailAuthCodeRecord | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;

  const purpose = normalizePurpose(src.purpose);
  const email = normalizeEmail(typeof src.email === "string" ? src.email : "");
  const user_id = normalizeNullableString(src.user_id);
  const code_hash_hex = normalizeNullableString(src.code_hash_hex) || "";
  const expires_at_ms = Number(src.expires_at_ms);
  const created_at_ms = Number(src.created_at_ms);
  const last_send_at_ms = Number(src.last_send_at_ms);
  const attempts = Number(src.attempts);
  const pending_signup = normalizePendingSignup(src.pending_signup);
  const pending_profile_email_change = normalizePendingProfileEmailChange(src.pending_profile_email_change);

  if (!purpose) return null;
  if (!email) return null;
  if (!/^[0-9a-f]{64}$/i.test(code_hash_hex)) return null;
  if (!Number.isFinite(expires_at_ms) || expires_at_ms <= 0) return null;
  if (!Number.isFinite(created_at_ms) || created_at_ms <= 0) return null;
  if (!Number.isFinite(last_send_at_ms) || last_send_at_ms <= 0) return null;
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  if (purpose === "login" && !user_id) return null;
  if (purpose === "profile_email" && !user_id) return null;
  if (purpose === "signup" && !pending_signup) return null;
  if (purpose === "profile_email" && !pending_profile_email_change) return null;

  return {
    purpose,
    email,
    user_id,
    code_hash_hex: code_hash_hex.toLowerCase(),
    expires_at_ms,
    created_at_ms,
    last_send_at_ms,
    attempts: Math.floor(attempts),
    pending_signup: purpose === "signup" ? pending_signup : null,
    pending_profile_email_change: purpose === "profile_email" ? pending_profile_email_change : null
  };
}

function readStore(repoRoot: string): EmailAuthCodeStore {
  const p = storePath(repoRoot);
  if (!fs.existsSync(p)) return { version: 1, items: [] };

  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeParseJson(raw);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const nowMs = Date.now();
  const out: EmailAuthCodeRecord[] = [];

  for (const item of items) {
    const rec = normalizeRecord(item);
    if (!rec) continue;
    if (rec.expires_at_ms <= nowMs) continue;
    out.push(rec);
  }

  return { version: 1, items: out };
}

function writeStore(repoRoot: string, store: EmailAuthCodeStore): void {
  atomicWriteJson(storePath(repoRoot), { version: 1, items: store.items });
}

export function makeEmailAuthCode(): string {
  return String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
}

export function hashEmailAuthCode(code: string): string {
  const c = String(code || "").trim();
  if (!/^[0-9]{8}$/.test(c)) throw new Error("email_auth_code_invalid");
  return crypto.createHash("sha256").update(c).digest("hex");
}

export function getEmailAuthCode(
  repoRoot: string,
  purpose: EmailAuthPurpose,
  email: string
): EmailAuthCodeRecord | null {
  const e = normalizeEmail(email);
  if (!e) return null;

  const store = readStore(repoRoot);
  return store.items.find((x) => x.purpose === purpose && x.email === e) ?? null;
}

export function upsertEmailAuthCode(repoRoot: string, record: EmailAuthCodeRecord): void {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error("email_auth_record_invalid");

  const store = readStore(repoRoot);
  const keep = store.items.filter((x) => !(x.purpose === normalized.purpose && x.email === normalized.email));
  keep.push(normalized);
  writeStore(repoRoot, { version: 1, items: keep });
}

export function verifyEmailAuthCode(
  repoRoot: string,
  purpose: EmailAuthPurpose,
  email: string,
  code: string,
  maxAttempts = 5
): EmailAuthVerifyResult {
  const e = normalizeEmail(email);
  if (!e) return { ok: false, reason: "not_found" };

  const store = readStore(repoRoot);
  const idx = store.items.findIndex((x) => x.purpose === purpose && x.email === e);
  if (idx < 0) return { ok: false, reason: "not_found" };

  const rec = store.items[idx];
  if (rec.expires_at_ms <= Date.now()) {
    store.items.splice(idx, 1);
    writeStore(repoRoot, store);
    return { ok: false, reason: "expired" };
  }

  if (rec.attempts >= maxAttempts) {
    store.items.splice(idx, 1);
    writeStore(repoRoot, store);
    return { ok: false, reason: "too_many_attempts" };
  }

  let codeHashHex = "";
  try {
    codeHashHex = hashEmailAuthCode(code);
  } catch {
    rec.attempts += 1;
    writeStore(repoRoot, store);
    return { ok: false, reason: "invalid_code" };
  }

  const expected = Buffer.from(rec.code_hash_hex, "hex");
  const actual = Buffer.from(codeHashHex, "hex");
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!ok) {
    rec.attempts += 1;
    writeStore(repoRoot, store);
    return { ok: false, reason: "invalid_code" };
  }

  return { ok: true, record: rec };
}

export function clearEmailAuthCode(repoRoot: string, purpose: EmailAuthPurpose, email: string): void {
  const e = normalizeEmail(email);
  if (!e) return;

  const store = readStore(repoRoot);
  const next = store.items.filter((x) => !(x.purpose === purpose && x.email === e));
  writeStore(repoRoot, { version: 1, items: next });
}

export function gcEmailAuthCodes(repoRoot: string, nowMs = Date.now()): void {
  const store = readStore(repoRoot);
  const next = store.items.filter((x) => x.expires_at_ms > nowMs);
  if (next.length !== store.items.length) writeStore(repoRoot, { version: 1, items: next });
}
