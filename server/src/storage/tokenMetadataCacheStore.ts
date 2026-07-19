import fs from "fs";
import path from "path";
import crypto from "crypto";

type TokenMetadataCacheNetworkId = "mainnet" | `tn${number}`;

export type CanonicalKrc20TokenMetadata = {
  provider: "kasplex";
  networkId: TokenMetadataCacheNetworkId;

  lookup: {
    kind: "ca" | "tick";
    value: string;
    found: boolean;
    foundBy: "ca" | "tick" | null;
  };

  identity: {
    ca: string | null;
    tick: string | null;
    name: string | null;
    decimals: number | null;
  };

  issuance: {
    maxRaw: string | null;
    limitRaw: string | null;
    preRaw: string | null;
    toAddress: string | null;
    mod: string | null;
    state: string | null;
  };

  stats: {
    mintedRaw: string | null;
    burnedRaw: string | null;
    holderTotal: string | null;
    transferTotal: string | null;
    mintTotal: string | null;
    opScoreAdd: string | null;
    opScoreMod: string | null;
    hashRev: string | null;
    mtsAdd: string | null;
  };

  fetchedAtMs: number;
};

export type TokenMetadataCacheEntry = {
  ca: string;
  networkId: TokenMetadataCacheNetworkId;
  cachedAtMs: number;
  updatedAtMs: number;
  metadata: CanonicalKrc20TokenMetadata;
};

export type TokenMetadataCacheStoreV1 = {
  version: 1;
  updatedAtMs: number;
  byNetwork: Record<string, Record<string, TokenMetadataCacheEntry>>;
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "token-metadata-cache.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStoreFile(filePath: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  if (!fs.existsSync(filePath)) {
    const initial: TokenMetadataCacheStoreV1 = {
      version: 1,
      updatedAtMs: 0,
      byNetwork: {}
    };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeNetworkId(v: unknown): TokenMetadataCacheNetworkId | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "mainnet") return "mainnet";
  if (/^tn\d+$/.test(s)) return s as TokenMetadataCacheNetworkId;
  return null;
}

function normalizeCaKey(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function trimmedStringOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function finiteNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(v: unknown, fallback = 0): number {
  const n = finiteNumberOrNull(v);
  if (n === null || n < 0) return fallback;
  return Math.trunc(n);
}

function canonicalizeMetadata(raw: any): CanonicalKrc20TokenMetadata {
  const obj = raw && typeof raw === "object" ? raw : {};
  const networkId = normalizeNetworkId(obj.networkId) ?? "tn10";

  const lookup0 = obj.lookup && typeof obj.lookup === "object" ? obj.lookup : {};
  const identity0 = obj.identity && typeof obj.identity === "object" ? obj.identity : {};
  const issuance0 = obj.issuance && typeof obj.issuance === "object" ? obj.issuance : {};
  const stats0 = obj.stats && typeof obj.stats === "object" ? obj.stats : {};

  const lookupKindRaw = String(lookup0.kind ?? "").trim();
  const lookupKind: "ca" | "tick" = lookupKindRaw === "tick" ? "tick" : "ca";

  const foundByRaw = String(lookup0.foundBy ?? "").trim();
  const foundBy: "ca" | "tick" | null =
    foundByRaw === "ca" || foundByRaw === "tick" ? foundByRaw : null;

  return {
    provider: "kasplex",
    networkId,

    lookup: {
      kind: lookupKind,
      value: String(lookup0.value ?? "").trim(),
      found: Boolean(lookup0.found),
      foundBy
    },

    identity: {
      ca: trimmedStringOrNull(identity0.ca),
      tick: trimmedStringOrNull(identity0.tick),
      name: trimmedStringOrNull(identity0.name),
      decimals: finiteNumberOrNull(identity0.decimals)
    },

    issuance: {
      maxRaw: trimmedStringOrNull(issuance0.maxRaw),
      limitRaw: trimmedStringOrNull(issuance0.limitRaw),
      preRaw: trimmedStringOrNull(issuance0.preRaw),
      toAddress: trimmedStringOrNull(issuance0.toAddress),
      mod: trimmedStringOrNull(issuance0.mod),
      state: trimmedStringOrNull(issuance0.state)
    },

    stats: {
      mintedRaw: trimmedStringOrNull(stats0.mintedRaw),
      burnedRaw: trimmedStringOrNull(stats0.burnedRaw),
      holderTotal: trimmedStringOrNull(stats0.holderTotal),
      transferTotal: trimmedStringOrNull(stats0.transferTotal),
      mintTotal: trimmedStringOrNull(stats0.mintTotal),
      opScoreAdd: trimmedStringOrNull(stats0.opScoreAdd),
      opScoreMod: trimmedStringOrNull(stats0.opScoreMod),
      hashRev: trimmedStringOrNull(stats0.hashRev),
      mtsAdd: trimmedStringOrNull(stats0.mtsAdd)
    },

    fetchedAtMs: timestampMs(obj.fetchedAtMs, 0)
  };
}

function canonicalizeEntry(raw: any): TokenMetadataCacheEntry | null {
  const obj = raw && typeof raw === "object" ? raw : {};
  const metadata = canonicalizeMetadata(obj.metadata);
  const networkId = normalizeNetworkId(obj.networkId) ?? metadata.networkId;
  const ca = normalizeCaKey(obj.ca ?? metadata.identity.ca);

  if (!networkId || !ca) return null;

  const cachedAtMs = timestampMs(obj.cachedAtMs, metadata.fetchedAtMs);
  const updatedAtMs = timestampMs(obj.updatedAtMs, cachedAtMs);

  return {
    ca,
    networkId,
    cachedAtMs,
    updatedAtMs,
    metadata: {
      ...metadata,
      networkId,
      identity: {
        ...metadata.identity,
        ca
      }
    }
  };
}

function canonicalizeStore(raw: any): TokenMetadataCacheStoreV1 {
  const obj = raw && typeof raw === "object" ? raw : {};
  const byNetwork0 = obj.byNetwork && typeof obj.byNetwork === "object" ? obj.byNetwork : {};

  const next: TokenMetadataCacheStoreV1 = {
    version: 1,
    updatedAtMs: timestampMs(obj.updatedAtMs, 0),
    byNetwork: {}
  };

  for (const [networkId0, bucketAny] of Object.entries(byNetwork0 as Record<string, unknown>)) {
    const networkId = normalizeNetworkId(networkId0);
    if (!networkId) continue;

    const bucket0 = bucketAny && typeof bucketAny === "object" ? bucketAny : {};
    const nextBucket: Record<string, TokenMetadataCacheEntry> = {};

    for (const [ca0, entryAny] of Object.entries(bucket0 as Record<string, unknown>)) {
      const caKey = normalizeCaKey(ca0);
      if (!caKey) continue;

      const entry = canonicalizeEntry(entryAny);
      if (!entry) continue;
      if (entry.networkId !== networkId) continue;

      nextBucket[caKey] = {
        ...entry,
        ca: caKey,
        networkId,
        metadata: {
          ...entry.metadata,
          networkId,
          identity: {
            ...entry.metadata.identity,
            ca: caKey
          }
        }
      };
    }

    next.byNetwork[networkId] = nextBucket;
  }

  return next;
}

export function readTokenMetadataCacheStore(repoRoot: string): TokenMetadataCacheStoreV1 {
  const filePath = storePath(repoRoot);
  ensureStoreFile(filePath);

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as TokenMetadataCacheStoreV1;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("token-metadata-cache.v1.json: invalid JSON root");
  }

  return canonicalizeStore(parsed);
}

export function writeTokenMetadataCacheStore(repoRoot: string, store: TokenMetadataCacheStoreV1): void {
  const filePath = storePath(repoRoot);
  atomicWriteJson(filePath, canonicalizeStore(store));
}

export function getTokenMetadataCacheEntry(
  repoRoot: string,
  networkId0: string,
  ca0: string
): TokenMetadataCacheEntry | null {
  const networkId = normalizeNetworkId(networkId0);
  const ca = normalizeCaKey(ca0);

  if (!networkId || !ca) return null;

  const store = readTokenMetadataCacheStore(repoRoot);
  return store.byNetwork[networkId][ca] ?? null;
}

export function upsertTokenMetadataCacheEntry(
  repoRoot: string,
  input: {
    networkId: TokenMetadataCacheNetworkId;
    ca: string;
    metadata: CanonicalKrc20TokenMetadata;
  }
): TokenMetadataCacheEntry {
  const networkId = normalizeNetworkId(input.networkId);
  const ca = normalizeCaKey(input.ca);

  if (!networkId) throw new Error("token_metadata_cache_invalid_network");
  if (!ca) throw new Error("token_metadata_cache_invalid_ca");

  const store = readTokenMetadataCacheStore(repoRoot);
  const nowMs = Date.now();
  const existing = store.byNetwork[networkId][ca] ?? null;

  const next: TokenMetadataCacheEntry = {
    ca,
    networkId,
    cachedAtMs: existing ? existing.cachedAtMs : nowMs,
    updatedAtMs: nowMs,
    metadata: {
      ...canonicalizeMetadata(input.metadata),
      provider: "kasplex",
      networkId,
      identity: {
        ...canonicalizeMetadata(input.metadata).identity,
        ca
      }
    }
  };

  store.byNetwork[networkId][ca] = next;
  store.updatedAtMs = nowMs;
  writeTokenMetadataCacheStore(repoRoot, store);
  return next;
}
