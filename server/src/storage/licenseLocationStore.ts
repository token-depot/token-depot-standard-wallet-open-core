import fs from "fs";
import path from "path";
import crypto from "crypto";

export type LicenseLocation = {
  user_id: string;
  wallet_id: string;
  address0: string;
  network: "mainnet";
  tick: string;
  ca: string;
  discovered_at: string;
  verified_at: string;
};

function licenseLocationPath(repoRoot: string, userId: string): string {
  return path.join(repoRoot, "data", "users", userId, "license_location.json");
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

function safeParseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalize(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

export function readLicenseLocation(repoRoot: string, userId: string): LicenseLocation | null {
  const uid = normalize(userId);
  if (!uid) return null;

  const p = licenseLocationPath(repoRoot, uid);
  if (!fs.existsSync(p)) return null;

  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeParseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const user_id = normalize((parsed as any).user_id);
  const wallet_id = normalize((parsed as any).wallet_id);
  const address0 = normalize((parsed as any).address0);
  const network = normalize((parsed as any).network);
  const tick = normalize((parsed as any).tick);
  const ca = normalize((parsed as any).ca).toLowerCase();
  const discovered_at = normalize((parsed as any).discovered_at);
  const verified_at = normalize((parsed as any).verified_at);

  if (!user_id || user_id !== uid) return null;
  if (!wallet_id) return null;
  if (!address0) return null;
  if (network !== "mainnet") return null;
  if (!tick) return null;
  if (!isHex64(ca)) return null;
  if (!discovered_at) return null;
  if (!verified_at) return null;

  return {
    user_id,
    wallet_id,
    address0,
    network: "mainnet",
    tick,
    ca,
    discovered_at,
    verified_at
  };
}

export function writeLicenseLocation(repoRoot: string, loc: LicenseLocation): void {
  const uid = normalize(loc && (loc as any).user_id);
  if (!uid) throw new Error("license_location_missing_user_id");

  const wallet_id = normalize(loc.wallet_id);
  const address0 = normalize(loc.address0);
  const tick = normalize(loc.tick);
  const ca = normalize(loc.ca).toLowerCase();
  const discovered_at = normalize(loc.discovered_at);
  const verified_at = normalize(loc.verified_at);

  if (!wallet_id) throw new Error("license_location_missing_wallet_id");
  if (!address0) throw new Error("license_location_missing_address0");
  if (!tick) throw new Error("license_location_missing_tick");
  if (!isHex64(ca)) throw new Error("license_location_invalid_ca");
  if (!discovered_at) throw new Error("license_location_missing_discovered_at");
  if (!verified_at) throw new Error("license_location_missing_verified_at");

  const out: LicenseLocation = {
    user_id: uid,
    wallet_id,
    address0,
    network: "mainnet",
    tick,
    ca,
    discovered_at,
    verified_at
  };

  const p = licenseLocationPath(repoRoot, uid);
  atomicWriteJson(p, out);
}

export function clearLicenseLocation(repoRoot: string, userId: string): void {
  const uid = normalize(userId);
  if (!uid) return;

  const p = licenseLocationPath(repoRoot, uid);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}