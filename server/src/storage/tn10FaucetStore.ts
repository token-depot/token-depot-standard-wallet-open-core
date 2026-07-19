import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Tn10FaucetClaimRecordV1 = {
  user_id: string;
  ymd_utc: string;
  claimed_sompi: string;
  claim_count: number;
  last_claim_at: string;
  txids: string[];
};

export type Tn10FaucetStoreV1 = {
  version: 1;
  claims: Tn10FaucetClaimRecordV1[];
};

export type Tn10FaucetUsageV1 = {
  user_id: string;
  ymd_utc: string;
  claimed_sompi: string;
  claim_count: number;
  last_claim_at: string | null;
  txids: string[];
};

export type Tn10FaucetRecordClaimParams = {
  userId: string;
  ymdUtc?: string;
  amountSompi: bigint | number | string;
  txids: string[];
  now?: Date;
  dailyLimitSompi?: bigint | number | string;
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "tn10-faucet-claims.v1.json");
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

function initialStore(): Tn10FaucetStoreV1 {
  return {
    version: 1,
    claims: []
  };
}

function ensureStoreFile(filePath: string): void {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialStore(), null, 2) + "\n", "utf8");
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return initialStore();
  }
}

function normalizeUserId(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || s.length > 200) return "";
  return s;
}

export function tn10FaucetYmdUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function normalizeYmdUtc(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function normalizeIso(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function parseSompi(value: unknown, errorCode: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(errorCode);
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(errorCode);
    return BigInt(value);
  }

  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(s)) throw new Error(errorCode);
  return BigInt(s);
}

function sompiToStoreString(value: bigint): string {
  if (value < 0n) throw new Error("tn10_faucet_sompi_invalid");
  return value.toString(10);
}

function normalizeTxids(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const txid = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    if (seen.has(txid)) continue;
    seen.add(txid);
    out.push(txid);
  }

  return out;
}

function normalizeClaimRecord(value: unknown): Tn10FaucetClaimRecordV1 | null {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!obj) return null;

  const user_id = normalizeUserId(obj.user_id);
  const ymd_utc = normalizeYmdUtc(obj.ymd_utc);
  const last_claim_at = normalizeIso(obj.last_claim_at);
  const txids = normalizeTxids(obj.txids);

  if (!user_id || !ymd_utc || !last_claim_at) return null;

  let claimedSompi: bigint;
  try {
    claimedSompi = parseSompi(obj.claimed_sompi, "tn10_faucet_claimed_sompi_invalid");
  } catch {
    return null;
  }

  const rawCount = typeof obj.claim_count === "number" ? obj.claim_count : Number(obj.claim_count);
  const claim_count = Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : txids.length;

  return {
    user_id,
    ymd_utc,
    claimed_sompi: sompiToStoreString(claimedSompi),
    claim_count,
    last_claim_at,
    txids
  };
}

function normalizeStore(value: unknown): Tn10FaucetStoreV1 {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawClaims = Array.isArray(obj.claims) ? obj.claims : [];

  const merged = new Map<string, Tn10FaucetClaimRecordV1>();

  for (const raw of rawClaims) {
    const claim = normalizeClaimRecord(raw);
    if (!claim) continue;

    const key = `${claim.user_id}\u0000${claim.ymd_utc}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, claim);
      continue;
    }

    const claimedSompi = parseSompi(existing.claimed_sompi, "tn10_faucet_claimed_sompi_invalid") + parseSompi(claim.claimed_sompi, "tn10_faucet_claimed_sompi_invalid");
    const txids = normalizeTxids([...existing.txids, ...claim.txids]);
    const last_claim_at = existing.last_claim_at.localeCompare(claim.last_claim_at) >= 0 ? existing.last_claim_at : claim.last_claim_at;

    merged.set(key, {
      user_id: existing.user_id,
      ymd_utc: existing.ymd_utc,
      claimed_sompi: sompiToStoreString(claimedSompi),
      claim_count: existing.claim_count + claim.claim_count,
      last_claim_at,
      txids
    });
  }

  const claims = Array.from(merged.values()).sort((a, b) => a.ymd_utc.localeCompare(b.ymd_utc) || a.user_id.localeCompare(b.user_id));

  return {
    version: 1,
    claims
  };
}

export function readTn10FaucetStore(repoRoot: string): Tn10FaucetStoreV1 {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  return normalizeStore(safeParseJson(fs.readFileSync(p, "utf8")));
}

export function writeTn10FaucetStore(repoRoot: string, store: Tn10FaucetStoreV1): void {
  atomicWriteJson(storePath(repoRoot), normalizeStore(store));
}

export function getTn10FaucetUsage(repoRoot: string, userId: string, ymdUtc: string = tn10FaucetYmdUtc()): Tn10FaucetUsageV1 {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedYmdUtc = normalizeYmdUtc(ymdUtc);
  if (!normalizedUserId) throw new Error("tn10_faucet_user_id_invalid");
  if (!normalizedYmdUtc) throw new Error("tn10_faucet_ymd_utc_invalid");

  const store = readTn10FaucetStore(repoRoot);
  const found = store.claims.find((claim) => claim.user_id === normalizedUserId && claim.ymd_utc === normalizedYmdUtc) || null;

  if (!found) {
    return {
      user_id: normalizedUserId,
      ymd_utc: normalizedYmdUtc,
      claimed_sompi: "0",
      claim_count: 0,
      last_claim_at: null,
      txids: []
    };
  }

  return {
    user_id: found.user_id,
    ymd_utc: found.ymd_utc,
    claimed_sompi: found.claimed_sompi,
    claim_count: found.claim_count,
    last_claim_at: found.last_claim_at,
    txids: found.txids.slice()
  };
}

export function getTn10FaucetClaimedSompi(repoRoot: string, userId: string, ymdUtc: string = tn10FaucetYmdUtc()): bigint {
  return parseSompi(getTn10FaucetUsage(repoRoot, userId, ymdUtc).claimed_sompi, "tn10_faucet_claimed_sompi_invalid");
}

export function getTn10FaucetRemainingSompi(repoRoot: string, userId: string, ymdUtc: string, dailyLimitSompi: bigint | number | string): bigint {
  const limit = parseSompi(dailyLimitSompi, "tn10_faucet_daily_limit_invalid");
  const claimed = getTn10FaucetClaimedSompi(repoRoot, userId, ymdUtc);
  return claimed >= limit ? 0n : limit - claimed;
}

export function recordTn10FaucetClaim(repoRoot: string, params: Tn10FaucetRecordClaimParams): Tn10FaucetUsageV1 {
  const user_id = normalizeUserId(params.userId);
  const ymd_utc = normalizeYmdUtc(params.ymdUtc || tn10FaucetYmdUtc(params.now || new Date()));
  const amountSompi = parseSompi(params.amountSompi, "tn10_faucet_amount_sompi_invalid");
  const txids = normalizeTxids(params.txids);
  const nowIso = (params.now || new Date()).toISOString();

  if (!user_id) throw new Error("tn10_faucet_user_id_invalid");
  if (!ymd_utc) throw new Error("tn10_faucet_ymd_utc_invalid");
  if (amountSompi <= 0n) throw new Error("tn10_faucet_amount_sompi_invalid");
  if (txids.length < 1) throw new Error("tn10_faucet_txid_required");

  const store = readTn10FaucetStore(repoRoot);
  const existingIndex = store.claims.findIndex((claim) => claim.user_id === user_id && claim.ymd_utc === ymd_utc);
  const existing = existingIndex >= 0 ? store.claims[existingIndex] : null;
  const existingClaimed = existing ? parseSompi(existing.claimed_sompi, "tn10_faucet_claimed_sompi_invalid") : 0n;
  const nextClaimed = existingClaimed + amountSompi;

  if (params.dailyLimitSompi !== undefined) {
    const dailyLimit = parseSompi(params.dailyLimitSompi, "tn10_faucet_daily_limit_invalid");
    if (nextClaimed > dailyLimit) throw new Error("tn10_faucet_quota_exceeded");
  }

  const nextRecord: Tn10FaucetClaimRecordV1 = {
    user_id,
    ymd_utc,
    claimed_sompi: sompiToStoreString(nextClaimed),
    claim_count: (existing?.claim_count || 0) + 1,
    last_claim_at: nowIso,
    txids: normalizeTxids([...(existing?.txids || []), ...txids])
  };

  if (existingIndex >= 0) {
    store.claims[existingIndex] = nextRecord;
  } else {
    store.claims.push(nextRecord);
  }

  writeTn10FaucetStore(repoRoot, store);
  return getTn10FaucetUsage(repoRoot, user_id, ymd_utc);
}
