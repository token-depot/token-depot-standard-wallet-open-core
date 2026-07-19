import type { Express, Request, Response } from "express";
import { readWrappedConfigV7, writeWrappedConfigV7, type IssuanceMetaEntry } from "../storage/wrappedConfigStore";
import { upsertTokenMetadataCacheEntry, type CanonicalKrc20TokenMetadata } from "../storage/tokenMetadataCacheStore";
import { readEnergyStore, writeEnergyStore } from "../storage/energyStore";
import type { AppNetworkKey, EnergyNetworkId, EnergyTokenLockRecord } from "../types";
import { validateIssueModeKrc20Metadata } from "../krc20MetadataReconciler";

type ResolveKrc20TokenMetadataInput = {
  networkId: AppNetworkKey;
  lookup: {
    kind: "ca" | "tick";
    value: string;
  };
  options?: {
    timeoutMs?: number;
  };
};

type ResolveKrc20TokenMetadataResult =
  | { ok: true; data: CanonicalKrc20TokenMetadata }
  | { ok: false; reason: string };

export type Krc20ImportCtx = {
  repoRoot: string;
  resolveKrc20TokenMetadata?: (
    input: ResolveKrc20TokenMetadataInput
  ) => Promise<ResolveKrc20TokenMetadataResult>;
};

function getBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object") return {};
  return req.body as Record<string, unknown>;
}

function trimmedStringOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function normalizeNetworkId(v: unknown): AppNetworkKey | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "mainnet") return "mainnet";
  if (s === "tn10" || s === "testnet-10" || s === "testnet") return "tn10";
  return null;
}

function normalizeCaKey(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function isValidCa(v: string): boolean {
  return /^[0-9a-f]{64}$/i.test(v);
}

function kaspaAddressPrefixForAppNetwork(networkId: AppNetworkKey): "kaspa:" | "kaspatest:" {
  return networkId === "mainnet" ? "kaspa:" : "kaspatest:";
}

function isValidKaspaAddressForNetwork(networkId: AppNetworkKey, value: string): boolean {
  const expectedPrefix = kaspaAddressPrefixForAppNetwork(networkId);
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith(expectedPrefix)) return false;
  return /^[a-z0-9:]+$/i.test(trimmed);
}

type ParsedImportRequest = {
  networkId: AppNetworkKey;
  caKey: string;
  ownerAddress: string | null;
  energyLockRequested: boolean;
};

function parseEnergyLockRequested(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function digitsToBigIntOrZero(v: unknown): bigint {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? BigInt(s) : 0n;
}

function applyPostImportEnergyLock(args: {
  repoRoot: string;
  userId: string;
  networkId: EnergyNetworkId;
  ca: string;
  resolved: CanonicalKrc20TokenMetadata;
}):
  | { ok: true; lock: EnergyTokenLockRecord }
  | { ok: false; reason: string } {
  const decimals = args.resolved?.identity?.decimals;
  if (!Number.isInteger(decimals) || Number(decimals) < 0) {
    return { ok: false, reason: "energy_lock_metadata_incomplete" };
  }

  const preRaw = digitsToBigIntOrZero(args.resolved?.issuance?.preRaw);
  const mintedRaw = digitsToBigIntOrZero(args.resolved?.stats?.mintedRaw);
  const burnedRaw = digitsToBigIntOrZero(args.resolved?.stats?.burnedRaw);
  const thresholdRaw = 1n;
  const effectiveRaw = preRaw + mintedRaw >= burnedRaw ? (preRaw + mintedRaw - burnedRaw) : 0n;

  if (effectiveRaw > thresholdRaw) {
    return { ok: false, reason: "energy_lock_not_eligible" };
  }

  try {
    const store = readEnergyStore(args.repoRoot);
    const ca = normalizeCaKey(args.ca);
    const existing = store.energy_locks_by_network[args.networkId][ca] || null;

    const next: EnergyTokenLockRecord = existing
      ? {
          ...existing,
          is_active: true
        }
      : {
          network_id: args.networkId,
          ca,
          is_active: true,
          locked_by_user_id: String(args.userId || "").trim() || null,
          locked_at: new Date().toISOString()
        };

    store.energy_locks_by_network[args.networkId][ca] = next;
    writeEnergyStore(args.repoRoot, store);
    return { ok: true, lock: next };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

function parseImportRequest(body: Record<string, unknown>):
  | { ok: true; data: ParsedImportRequest }
  | { ok: false; status: number; reason: string } {
  const networkId = normalizeNetworkId(body.networkId);
  const caKey = normalizeCaKey(body.ca);
  const ownerAddress = trimmedStringOrNull(body.ownerAddress);
  const energyLockRequested = parseEnergyLockRequested(body.energyLockRequested);

  if (!networkId) {
    return { ok: false, status: 400, reason: "network_id_invalid" };
  }
  if (!isValidCa(caKey)) {
    return { ok: false, status: 400, reason: "ca_invalid" };
  }
  if (ownerAddress && !isValidKaspaAddressForNetwork(networkId, ownerAddress)) {
    return { ok: false, status: 400, reason: "owner_address_invalid" };
  }

  return {
    ok: true,
    data: {
      networkId,
      caKey,
      ownerAddress,
      energyLockRequested
    }
  };
}


function validateImportedIssueModeMetadata(args: {
  input: ParsedImportRequest;
  metadata: CanonicalKrc20TokenMetadata;
}): { ok: true } | { ok: false; status: number; reason: string; detail: string } {
  const quality = validateIssueModeKrc20Metadata({
    networkId: args.input.networkId,
    ca: args.input.caKey,
    metadata: args.metadata,
    expectedOwnerAddress: args.input.ownerAddress
  });

  if (!quality.ok) {
    return {
      ok: false,
      status: 409,
      reason: "token_metadata_incomplete",
      detail: quality.reason
    };
  }

  return { ok: true };
}

async function resolveImportedMetadata(
  ctx: Krc20ImportCtx,
  input: ParsedImportRequest
): Promise<ResolveKrc20TokenMetadataResult> {
  if (!ctx.resolveKrc20TokenMetadata) {
    return { ok: false, reason: "token_metadata_resolver_unavailable" };
  }

  return ctx.resolveKrc20TokenMetadata({
    networkId: input.networkId,
    lookup: { kind: "ca", value: input.caKey },
    options: { timeoutMs: 8000 }
  });
}

async function upsertImportedRegistration(args: {
  repoRoot: string;
  networkId: AppNetworkKey;
  ca: string;
  ownerAddress: string | null;
  resolved: CanonicalKrc20TokenMetadata;
}): Promise<{
  ok: true;
  networkId: AppNetworkKey;
  caKey: string;
  ownerAddress: string | null;
  confirmationStatus: "resolved";
}> {
  const caKey = normalizeCaKey(args.ca);
  const ownerAddress = trimmedStringOrNull(args.ownerAddress);
  const nowMs = Date.now();

  upsertTokenMetadataCacheEntry(args.repoRoot, {
    networkId: args.networkId,
    ca: caKey,
    metadata: args.resolved
  });

  const cfg0 = readWrappedConfigV7(args.repoRoot);
  const next = JSON.parse(JSON.stringify(cfg0 || {}));

  next.issuance = next.issuance || {};
  next.issuance.deployerByNetwork = next.issuance.deployerByNetwork || {};
  next.issuance.metaByNetwork = next.issuance.metaByNetwork || {};

  next.issuance.deployerByNetwork[args.networkId] = next.issuance.deployerByNetwork[args.networkId] || {};
  next.issuance.metaByNetwork[args.networkId] = next.issuance.metaByNetwork[args.networkId] || {};

  const currentRaw = next.issuance.metaByNetwork[args.networkId][caKey];
  const current =
    currentRaw && typeof currentRaw === "object"
      ? (currentRaw as Partial<IssuanceMetaEntry>)
      : null;

  const currentDeployerOwner = trimmedStringOrNull(
    next.issuance.deployerByNetwork[args.networkId][caKey]
  );
  const finalOwnerAddress = ownerAddress || current?.ownerAddress || currentDeployerOwner || null;

  next.issuance.metaByNetwork[args.networkId][caKey] = {
    name: args.resolved.identity.name,
    tick: args.resolved.identity.tick,
    decimals: args.resolved.identity.decimals,
    max: args.resolved.issuance.maxRaw,
    lim: args.resolved.issuance.limitRaw,
    pre: args.resolved.issuance.preRaw,

    source: "import",
    status: "active",

    confirmationStatus: "resolved",

    ownerAddress: finalOwnerAddress,

    commitTxId: current?.commitTxId ?? null,
    revealTxId: current?.revealTxId ?? null,

    createdAtMs:
      typeof current?.createdAtMs === "number" && Number.isFinite(current.createdAtMs) && current.createdAtMs >= 0
        ? Math.trunc(current.createdAtMs)
        : nowMs,
    updatedAtMs: nowMs,
    confirmedAtMs: nowMs
  } satisfies IssuanceMetaEntry;

  if (ownerAddress) {
    next.issuance.deployerByNetwork[args.networkId][caKey] = ownerAddress;
  }

  writeWrappedConfigV7(args.repoRoot, next);

  return {
    ok: true,
    networkId: args.networkId,
    caKey,
    ownerAddress: finalOwnerAddress,
    confirmationStatus: "resolved"
  };
}

export function registerKrc20ImportRoutes(app: Express, ctx: Krc20ImportCtx): void {
  app.post("/api/v1/krc20/import/preview", async (req: Request, res: Response) => {
    try {
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const body = getBody(req);
      const parsed = parseImportRequest(body);
      if (!parsed.ok) {
        return res.status(parsed.status).json({ ok: false, reason: parsed.reason });
      }

      const resolvedResult = await resolveImportedMetadata(ctx, parsed.data);
      if (!resolvedResult.ok) {
        if (resolvedResult.reason === "token_metadata_resolver_unavailable") {
          return res.status(500).json({ ok: false, reason: resolvedResult.reason });
        }
        return res.status(404).json({
          ok: false,
          reason: "token_metadata_not_found",
          detail: resolvedResult.reason
        });
      }

      const metadataQuality = validateImportedIssueModeMetadata({
        input: parsed.data,
        metadata: resolvedResult.data
      });
      if (!metadataQuality.ok) {
        return res.status(metadataQuality.status).json({
          ok: false,
          reason: metadataQuality.reason,
          detail: metadataQuality.detail
        });
      }

      return res.json({
        ok: true,
        action: "import_preview",
        previewOnly: true,
        committed: false,
        networkId: parsed.data.networkId,
        ca: parsed.data.caKey,
        ownerAddress: parsed.data.ownerAddress,
        metadata: resolvedResult.data
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        reason: "krc20_import_preview_failed",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  app.post("/api/v1/krc20/import", async (req: Request, res: Response) => {
    try {
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const body = getBody(req);
      const parsed = parseImportRequest(body);
      if (!parsed.ok) {
        return res.status(parsed.status).json({ ok: false, reason: parsed.reason });
      }

      const resolvedResult = await resolveImportedMetadata(ctx, parsed.data);
      if (!resolvedResult.ok) {
        if (resolvedResult.reason === "token_metadata_resolver_unavailable") {
          return res.status(500).json({ ok: false, reason: resolvedResult.reason });
        }
        return res.status(404).json({
          ok: false,
          reason: "token_metadata_not_found",
          detail: resolvedResult.reason
        });
      }

      const metadataQuality = validateImportedIssueModeMetadata({
        input: parsed.data,
        metadata: resolvedResult.data
      });
      if (!metadataQuality.ok) {
        return res.status(metadataQuality.status).json({
          ok: false,
          reason: metadataQuality.reason,
          detail: metadataQuality.detail
        });
      }

      const out = await upsertImportedRegistration({
        repoRoot: ctx.repoRoot,
        networkId: parsed.data.networkId,
        ca: parsed.data.caKey,
        ownerAddress: parsed.data.ownerAddress,
        resolved: resolvedResult.data
      });

      const energyLock =
        parsed.data.energyLockRequested
          ? applyPostImportEnergyLock({
              repoRoot: ctx.repoRoot,
              userId,
              networkId: parsed.data.networkId,
              ca: parsed.data.caKey,
              resolved: resolvedResult.data
            })
          : null;

      return res.json({
        ok: true,
        networkId: out.networkId,
        ca: out.caKey,
        ownerAddress: out.ownerAddress,
        confirmationStatus: out.confirmationStatus,
        metadata: resolvedResult.data,
        energyLock
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        reason: "krc20_import_failed",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
