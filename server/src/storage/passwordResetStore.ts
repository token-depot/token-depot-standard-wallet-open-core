import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type PasswordResetRecord = {
  email: string;
  code_hash_hex: string;
  expires_at_ms: number;
  created_at_ms: number;
  last_send_at_ms: number;
};

type PasswordResetStore = {
  items: PasswordResetRecord[];
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "users", "_pwreset.json");
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

function readStore(repoRoot: string): PasswordResetStore {
  const p = storePath(repoRoot);
  if (!fs.existsSync(p)) return { items: [] };

  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeParseJson(raw);

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const out: PasswordResetRecord[] = [];

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const email = normalizeEmail((it as any).email);
    const code_hash_hex = String((it as any).code_hash_hex || "").trim();
    const expires_at_ms = Number((it as any).expires_at_ms);
    const created_at_ms = Number((it as any).created_at_ms);
    const last_send_at_ms = Number((it as any).last_send_at_ms);

    if (!email) continue;
    if (!/^[0-9a-f]{64}$/i.test(code_hash_hex)) continue;
    if (!Number.isFinite(expires_at_ms) || expires_at_ms <= 0) continue;
    if (!Number.isFinite(created_at_ms) || created_at_ms <= 0) continue;
    if (!Number.isFinite(last_send_at_ms) || last_send_at_ms <= 0) continue;

    out.push({ email, code_hash_hex: code_hash_hex.toLowerCase(), expires_at_ms, created_at_ms, last_send_at_ms });
  }

  return { items: out };
}

function writeStore(repoRoot: string, store: PasswordResetStore): void {
  const p = storePath(repoRoot);
  atomicWriteJson(p, store);
}

export function getPasswordReset(repoRoot: string, email: string): PasswordResetRecord | null {
  const e = normalizeEmail(email);
  if (!e) return null;

  const store = readStore(repoRoot);
  const r = store.items.find((x) => x.email === e) ?? null;
  if (!r) return null;

  if (r.expires_at_ms <= Date.now()) return null;
  return r;
}

export function upsertPasswordReset(
  repoRoot: string,
  email: string,
  codeHashHex: string,
  expiresAtMs: number,
  nowMs: number
): void {
  const e = normalizeEmail(email);
  if (!e) throw new Error("email_invalid");
  const h = String(codeHashHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("reset_code_hash_invalid");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) throw new Error("reset_expires_invalid");
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("reset_time_invalid");

  const store = readStore(repoRoot);
  const keep = store.items.filter((x) => x.email !== e && x.expires_at_ms > nowMs);
  keep.push({
    email: e,
    code_hash_hex: h,
    expires_at_ms: expiresAtMs,
    created_at_ms: nowMs,
    last_send_at_ms: nowMs
  });

  writeStore(repoRoot, { items: keep });
}

export function clearPasswordReset(repoRoot: string, email: string): void {
  const e = normalizeEmail(email);
  if (!e) return;

  const store = readStore(repoRoot);
  const next = store.items.filter((x) => x.email !== e);
  writeStore(repoRoot, { items: next });
}