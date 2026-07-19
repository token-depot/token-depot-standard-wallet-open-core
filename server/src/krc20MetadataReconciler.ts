import {
  upsertTokenMetadataCacheEntry,
  type CanonicalKrc20TokenMetadata
} from "./storage/tokenMetadataCacheStore";
import {
  readWrappedConfigV7,
  writeWrappedConfigV7,
  type IssuanceMetaEntry
} from "./storage/wrappedConfigStore";
import type { AppNetworkKey } from "./types";

export type ResolveKrc20TokenMetadataInput = {
  networkId: AppNetworkKey;
  lookup: {
    kind: "ca" | "tick";
    value: string;
  };
  options?: {
    timeoutMs?: number;
  };
};

export type ResolveKrc20TokenMetadataResult =
  | { ok: true; data: CanonicalKrc20TokenMetadata }
  | { ok: false; reason: string };

export type ResolveKrc20TokenMetadataFn = (
  input: ResolveKrc20TokenMetadataInput
) => Promise<ResolveKrc20TokenMetadataResult>;

export type Krc20MetadataQualityResult =
  | { ok: true }
  | { ok: false; reason: string };

export type RefreshKrc20IssueModeMetadataResult =
  | {
      ok: true;
      updated: true;
      ca: string;
      networkId: AppNetworkKey;
      ownerAddress: string;
      metadata: CanonicalKrc20TokenMetadata;
    }
  | {
      ok: false;
      updated: false;
      ca: string;
      networkId: AppNetworkKey;
      reason: string;
      providerReason?: string;
    };

function normalizeCaKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function lowerCleanString(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function isValidCa(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function expectedAddressPrefix(networkId: AppNetworkKey): "kaspa:" | "kaspatest:" {
  return networkId === "mainnet" ? "kaspa:" : "kaspatest:";
}

function nonEmpty(value: unknown): boolean {
  return cleanString(value).length > 0;
}

function metadataNetworkMatches(networkId: AppNetworkKey, metadata: CanonicalKrc20TokenMetadata): boolean {
  return String(metadata.networkId || "").trim() === networkId;
}

export function validateIssueModeKrc20Metadata(args: {
  networkId: AppNetworkKey;
  ca: string;
  metadata: CanonicalKrc20TokenMetadata;
  expectedOwnerAddress?: string | null;
}): Krc20MetadataQualityResult {
  const ca = normalizeCaKey(args.ca);
  if (!isValidCa(ca)) return { ok: false, reason: "invalid_ca" };

  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object") return { ok: false, reason: "metadata_missing" };
  if (!metadataNetworkMatches(args.networkId, metadata)) return { ok: false, reason: "network_mismatch" };

  const identityCa = normalizeCaKey(metadata.identity?.ca);
  if (identityCa !== ca) return { ok: false, reason: "identity_ca_mismatch" };
  if (!nonEmpty(metadata.identity?.name)) return { ok: false, reason: "identity_name_missing" };

  const decimals = metadata.identity?.decimals;
  if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals < 0) {
    return { ok: false, reason: "identity_decimals_invalid" };
  }

  const toAddress = cleanString(metadata.issuance?.toAddress);
  if (!toAddress) return { ok: false, reason: "issuance_to_address_missing" };
  if (!toAddress.startsWith(expectedAddressPrefix(args.networkId))) {
    return { ok: false, reason: "issuance_to_address_network_mismatch" };
  }

  const expectedOwnerAddress = cleanString(args.expectedOwnerAddress);
  if (expectedOwnerAddress && lowerCleanString(expectedOwnerAddress) !== lowerCleanString(toAddress)) {
    return { ok: false, reason: "issuance_to_address_owner_mismatch" };
  }

  if (cleanString(metadata.issuance?.mod).toLowerCase() !== "issue") {
    return { ok: false, reason: "issuance_mod_not_issue" };
  }

  if (cleanString(metadata.issuance?.state).toLowerCase() !== "deployed") {
    return { ok: false, reason: "issuance_state_not_deployed" };
  }

  const hashRev = normalizeCaKey(metadata.stats?.hashRev);
  if (hashRev !== ca) return { ok: false, reason: "stats_hash_rev_mismatch" };
  if (!nonEmpty(metadata.stats?.mtsAdd)) return { ok: false, reason: "stats_mts_add_missing" };

  return { ok: true };
}

export function isIncompleteIssueModeKrc20Metadata(args: {
  networkId: AppNetworkKey;
  ca: string;
  metadata: CanonicalKrc20TokenMetadata | null | undefined;
  expectedOwnerAddress?: string | null;
}): boolean {
  if (!args.metadata) return true;
  return !validateIssueModeKrc20Metadata({
    networkId: args.networkId,
    ca: args.ca,
    metadata: args.metadata,
    expectedOwnerAddress: args.expectedOwnerAddress
  }).ok;
}

function parseMsOrNull(value: unknown): number | null {
  const n = Number(cleanString(value));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function issuanceMetaFromIssueModeMetadata(args: {
  existing?: IssuanceMetaEntry | null;
  metadata: CanonicalKrc20TokenMetadata;
  source?: "deploy" | "import";
  ownerAddress?: string | null;
  nowMs?: number;
}): IssuanceMetaEntry {
  const existing = args.existing ?? null;
  const nowMs = Number.isFinite(args.nowMs) ? Math.trunc(args.nowMs as number) : Date.now();
  const metadata = args.metadata;
  const providerCreatedAtMs = parseMsOrNull(metadata.stats.mtsAdd);
  const ownerAddress = cleanString(args.ownerAddress) || cleanString(metadata.issuance.toAddress) || null;

  return {
    name: cleanString(metadata.identity.name) || null,
    tick: metadata.identity.tick === null ? null : cleanString(metadata.identity.tick) || null,
    decimals: metadata.identity.decimals,
    max: metadata.issuance.maxRaw === null ? null : cleanString(metadata.issuance.maxRaw),
    lim: metadata.issuance.limitRaw === null ? null : cleanString(metadata.issuance.limitRaw),
    pre: metadata.issuance.preRaw === null ? null : cleanString(metadata.issuance.preRaw),
    source: existing?.source ?? args.source ?? "import",
    status: existing?.status ?? "active",
    confirmationStatus: "resolved",
    ownerAddress,
    commitTxId: existing?.commitTxId ?? null,
    revealTxId: existing?.revealTxId ?? (cleanString(metadata.stats.hashRev) || null),
    createdAtMs: existing?.createdAtMs ?? providerCreatedAtMs ?? nowMs,
    updatedAtMs: nowMs,
    confirmedAtMs: nowMs
  };
}

export async function refreshIssueModeKrc20MetadataForCa(args: {
  repoRoot: string;
  networkId: AppNetworkKey;
  ca: string;
  resolveKrc20TokenMetadata: ResolveKrc20TokenMetadataFn;
  expectedOwnerAddress?: string | null;
  source?: "deploy" | "import";
  timeoutMs?: number;
  nowMs?: number;
}): Promise<RefreshKrc20IssueModeMetadataResult> {
  const ca = normalizeCaKey(args.ca);
  if (!isValidCa(ca)) {
    return { ok: false, updated: false, ca, networkId: args.networkId, reason: "invalid_ca" };
  }

  const provider = await args.resolveKrc20TokenMetadata({
    networkId: args.networkId,
    lookup: { kind: "ca", value: ca },
    options: { timeoutMs: args.timeoutMs }
  });

  if (!provider.ok) {
    return {
      ok: false,
      updated: false,
      ca,
      networkId: args.networkId,
      reason: "provider_lookup_failed",
      providerReason: provider.reason
    };
  }

  const cfg = readWrappedConfigV7(args.repoRoot);
  const deployerByNetwork = cfg.issuance.deployerByNetwork;
  const metaByNetwork = cfg.issuance.metaByNetwork;

  const existingDeployer = cleanString(deployerByNetwork[args.networkId]?.[ca]);
  const expectedOwnerAddress = cleanString(args.expectedOwnerAddress) || existingDeployer || null;

  const quality = validateIssueModeKrc20Metadata({
    networkId: args.networkId,
    ca,
    metadata: provider.data,
    expectedOwnerAddress
  });

  if (!quality.ok) {
    return { ok: false, updated: false, ca, networkId: args.networkId, reason: quality.reason };
  }

  const ownerAddress = expectedOwnerAddress || cleanString(provider.data.issuance.toAddress);
  if (!ownerAddress) {
    return { ok: false, updated: false, ca, networkId: args.networkId, reason: "owner_address_missing" };
  }

  if (!deployerByNetwork[args.networkId]) deployerByNetwork[args.networkId] = {};
  if (!metaByNetwork[args.networkId]) metaByNetwork[args.networkId] = {};

  deployerByNetwork[args.networkId][ca] = ownerAddress;
  metaByNetwork[args.networkId][ca] = issuanceMetaFromIssueModeMetadata({
    existing: metaByNetwork[args.networkId][ca] ?? null,
    metadata: provider.data,
    source: args.source,
    ownerAddress,
    nowMs: args.nowMs
  });

  writeWrappedConfigV7(args.repoRoot, cfg);
  upsertTokenMetadataCacheEntry(args.repoRoot, {
    networkId: args.networkId,
    ca,
    metadata: provider.data
  });

  return {
    ok: true,
    updated: true,
    ca,
    networkId: args.networkId,
    ownerAddress,
    metadata: provider.data
  };
}
