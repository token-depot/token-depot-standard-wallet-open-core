import { randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import { Transaction, kaspaToSompi, maximumStandardTransactionMass, RpcClient as ToccataRpcClient } from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";
import { readWrappedConfigV7, writeWrappedConfigV7, type IssuanceMetaEntry } from "../storage/wrappedConfigStore";
import { upsertTokenMetadataCacheEntry, type CanonicalKrc20TokenMetadata } from "../storage/tokenMetadataCacheStore";
import { issuanceMetaFromIssueModeMetadata, validateIssueModeKrc20Metadata } from "../krc20MetadataReconciler";
import { readEnergyStore, writeEnergyStore } from "../storage/energyStore";
import type {
  AppNetworkKey,
  EnergyNetworkId,
  EnergyTokenLockRecord,
  RpcNetworkId,
  WalletNetworkType
} from "../types";

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

export type Krc20DeployCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: RpcNetworkId) => Promise<any>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  getAppConfig: (repoRootPath: string) => any;

  requireMainnetLicenseOrReject: (args: {
    networkId: RpcNetworkId;
    userId: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; status: number; reason: string; tick: string; ca: string; error?: string }
  >;

  resolveKrc20TokenMetadata?: (
    input: ResolveKrc20TokenMetadataInput
  ) => Promise<ResolveKrc20TokenMetadataResult>;
};

function cleanName(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
}
function validName(s: string): boolean {
  return /^[A-Z]{4,6}$/.test(s || "");
}
function validDigits(s: string): boolean {
  return /^\d{1,64}$/.test(s || "");
}
function normalizeAppNetworkKey(raw: string): AppNetworkKey | null {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "mainnet") return "mainnet";
  if (value === "tn10" || value === "testnet-10" || value === "testnet") return "tn10";
  return null;
}
function walletNetworkTypeFor(appNetwork: AppNetworkKey): WalletNetworkType {
  return appNetwork === "mainnet" ? "mainnet" : "testnet";
}
function rpcNetworkIdFor(appNetwork: AppNetworkKey): RpcNetworkId {
  return appNetwork === "mainnet" ? "mainnet" : "testnet-10";
}
function kaspaAddressPrefixForRpcNetwork(networkId: RpcNetworkId): "kaspa:" | "kaspatest:" {
  return networkId === "mainnet" ? "kaspa:" : "kaspatest:";
}
function validKaspaAddrForRpcNetwork(networkId: RpcNetworkId, s: string): boolean {
  const value = String(s || "").trim();
  const expectedPrefix = kaspaAddressPrefixForRpcNetwork(networkId);
  if (!value.startsWith(expectedPrefix)) return false;
  return /^[a-z0-9:]+$/i.test(value);
}
function validP2shAddressForRpcNetwork(networkId: RpcNetworkId, s: string): boolean {
  const value = String(s || "").trim();
  const expectedPrefix = kaspaAddressPrefixForRpcNetwork(networkId);
  if (!value.startsWith(expectedPrefix)) return false;
  return /^[a-z0-9:]+$/i.test(value);
}

const KRC20_DEPLOY_TN10_COVENANT_RPC_URL = "ws://tn10.token-depot.co:17210";

type Krc20DeployCommitCovenantExclusion = {
  inspection_kind: "krc20_deploy_commit_covenant_exclusion_v1";
  networkId: string;
  address: string;
  total_entries: number;
  spendable_entries: number;
  excluded_entries: number;
  excluded_outpoints: string[];
  inspection_path: "reference.entry.covenantId";
  signing_enabled: false;
  broadcasting_enabled: false;
  minting_enabled: false;
};

function krc20DeployPrintable(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function krc20DeployReferenceEntry(reference: any): any | null {
  return reference && typeof reference === "object" && reference.entry ? reference.entry : null;
}

function krc20DeployCovenantIdFromReference(reference: any): string | null {
  const entry = krc20DeployReferenceEntry(reference);
  const canonical = entry ? entry.covenantId : undefined;
  return canonical === null || canonical === undefined ? null : krc20DeployPrintable(canonical);
}

function krc20DeployOutpointKeyFromValue(outpoint: any): string {
  if (!outpoint) return "";
  if (typeof outpoint === "string") return outpoint;
  if (outpoint && typeof outpoint.toJSON === "function") return krc20DeployOutpointKeyFromValue(outpoint.toJSON());
  const transactionId = krc20DeployPrintable(outpoint.transactionId ?? outpoint.transaction_id ?? outpoint.txid);
  const rawIndex = outpoint.index ?? outpoint.outputIndex ?? outpoint.output_index;
  const index = rawIndex === null || rawIndex === undefined ? null : Number(rawIndex);
  return transactionId && Number.isFinite(index) ? `${transactionId}:${index}` : "";
}

function krc20DeployOutpointKeyFromReference(reference: any): string {
  const entry = krc20DeployReferenceEntry(reference);
  const candidates = [
    reference && reference.outpoint,
    entry && entry.outpoint,
    reference && reference.utxo && reference.utxo.outpoint,
    reference && reference.utxoEntry && reference.utxoEntry.outpoint
  ];

  for (const candidate of candidates) {
    const key = krc20DeployOutpointKeyFromValue(candidate);
    if (key) return key;
  }
  return "";
}

function krc20DeployEntriesFromResponse(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.entries)) return response.entries;
  if (response && Array.isArray(response.utxos)) return response.utxos;
  if (response && Array.isArray(response.result)) return response.result;
  return [];
}

async function applyKrc20DeployCommitCovenantExclusion(args: {
  networkId: RpcNetworkId;
  address: string;
  entries: any[];
}): Promise<{ entries: any[]; exclusion: Krc20DeployCommitCovenantExclusion }> {
  const totalEntries = Array.isArray(args.entries) ? args.entries.length : 0;
  const covenantOutpoints = new Set<string>();

  for (const entry of args.entries) {
    const covenantId = krc20DeployCovenantIdFromReference(entry);
    const key = covenantId ? krc20DeployOutpointKeyFromReference(entry) : "";
    if (key) covenantOutpoints.add(key);
  }

  if (args.networkId === "testnet-10") {
    let rpc: InstanceType<typeof ToccataRpcClient> | null = null;
    try {
      rpc = new ToccataRpcClient({ url: KRC20_DEPLOY_TN10_COVENANT_RPC_URL, networkId: args.networkId });
      await rpc.connect();
      const response = await rpc.getUtxosByAddresses({ addresses: [args.address] });
      const toccataEntries = krc20DeployEntriesFromResponse(response);
      for (const entry of toccataEntries) {
        const covenantId = krc20DeployCovenantIdFromReference(entry);
        const key = covenantId ? krc20DeployOutpointKeyFromReference(entry) : "";
        if (key) covenantOutpoints.add(key);
      }
    } finally {
      if (rpc) {
        try {
          await rpc.disconnect();
        } catch {}
      }
    }
  }

  const spendableEntries = args.entries.filter((entry) => {
    const key = krc20DeployOutpointKeyFromReference(entry);
    return !key || !covenantOutpoints.has(key);
  });
  const excludedOutpoints = Array.from(covenantOutpoints).sort();

  return {
    entries: spendableEntries,
    exclusion: {
      inspection_kind: "krc20_deploy_commit_covenant_exclusion_v1",
      networkId: args.networkId,
      address: args.address,
      total_entries: totalEntries,
      spendable_entries: spendableEntries.length,
      excluded_entries: totalEntries - spendableEntries.length,
      excluded_outpoints: excludedOutpoints,
      inspection_path: "reference.entry.covenantId",
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false
    }
  };
}

function getBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object") return {};
  return req.body as Record<string, unknown>;
}

function requireAdminToken(req: Request): { ok: true } | { ok: false; status: number; reason: string } {
  const tok = String(req.headers["x-td-admin-token"] || "").trim();
  const expected = String(process.env.TD_ADMIN_TOKEN || "").trim();

  if (!expected) {
    return { ok: false, status: 500, reason: "Server missing TD_ADMIN_TOKEN; refusing write." };
  }
  if (!tok || tok !== expected) {
    return { ok: false, status: 403, reason: "Forbidden" };
  }
  return { ok: true };
}

function parseTimeoutMs(raw: unknown): number {
  const s = typeof raw === "string" ? raw.trim() : "";
  const n = Number.parseInt(s || "0", 10);
  const v = Number.isFinite(n) ? n : 0;
  const clamped = Math.max(10_000, Math.min(600_000, v || 120_000));
  return clamped;
}

function parseMultiplierScaled1e8(raw: unknown): bigint {
  const s0 = typeof raw === "string" ? raw.trim() : "";
  const s = s0 || "1";
  const m = s.match(/^(\d+)(?:\.(\d{0,8}))?$/);
  if (!m) return 100000000n;
  const i = m[1] || "0";
  const f = (m[2] || "").padEnd(8, "0");
  const scaled = BigInt(i) * 100000000n + BigInt(f || "0");
  return scaled > 0n ? scaled : 100000000n;
}

function parseEnergyLockRequested(raw: unknown): boolean {
  if (raw === true) return true;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

type BcwKrc20DeployIntentV1 = {
  v: 1;
  purpose: "bcw_krc20_deploy";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "testnet" | "mainnet";
  broker_custody_key_ref: string;
  from_address: string;
  name: string;
  max: string;
  dec: string;
  pre: string;
  to_address: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwDeployRouteString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBcwDeployRouteIso(value: unknown): string {
  const s = normalizeBcwDeployRouteString(value);
  const ms = Date.parse(s);
  if (!s || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function normalizeBcwKrc20DeployIntent(raw: unknown): BcwKrc20DeployIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network = input.network === "testnet" || input.network === "mainnet" ? input.network : null;
  if (!network) return null;

  const intent: BcwKrc20DeployIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_krc20_deploy" ? "bcw_krc20_deploy" : "" as "bcw_krc20_deploy",
    wallet_id: normalizeBcwDeployRouteString(input.wallet_id),
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: normalizeBcwDeployRouteString(input.broker_custody_key_ref),
    from_address: normalizeBcwDeployRouteString(input.from_address),
    name: normalizeBcwDeployRouteString(input.name).toUpperCase(),
    max: normalizeBcwDeployRouteString(input.max),
    dec: normalizeBcwDeployRouteString(input.dec),
    pre: normalizeBcwDeployRouteString(input.pre) || "0",
    to_address: normalizeBcwDeployRouteString(input.to_address),
    user_auth_pubkey: normalizeBcwDeployRouteString(input.user_auth_pubkey),
    created_at: normalizeBcwDeployRouteIso(input.created_at),
    expires_at: normalizeBcwDeployRouteIso(input.expires_at),
    nonce: normalizeBcwDeployRouteString(input.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_krc20_deploy") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;
  if (!/^BCWDEPLOYREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;
  if (!validName(intent.name)) return null;
  if (!validDigits(intent.max)) return null;
  if (!/^[0-9]{1,2}$/.test(intent.dec)) return null;

  const decNum = Number.parseInt(intent.dec, 10);
  if (!Number.isFinite(decNum) || decNum < 0 || decNum > 18) return null;
  if (!validDigits(intent.pre)) return null;
  if (BigInt(intent.pre) > 0n && !intent.to_address) return null;
  if (BigInt(intent.pre) === 0n && intent.to_address) return null;

  return intent;
}

function canonicalBcwKrc20DeployIntentMessage(intent: BcwKrc20DeployIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    name: intent.name,
    max: intent.max,
    dec: intent.dec,
    pre: intent.pre,
    to_address: intent.to_address,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

async function postBcwKrc20DeployToCn(params: {
  repoRoot: string;
  getAppConfig: (repoRootPath: string) => any;
  intent: BcwKrc20DeployIntentV1;
  authSignature: string;
}): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = params.getAppConfig(params.repoRoot);
  const cnUrl = String(cfg && cfg.cn_url ? cfg.cn_url : "").trim().replace(/\/+$/, "");
  if (!cnUrl) return { ok: false, status: 500, data: { ok: false, reason: "cn_url_missing" } };

  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) return { ok: false, status: 500, data: { ok: false, reason: "td_admin_token_missing" } };

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") return { ok: false, status: 500, data: { ok: false, reason: "fetch_unavailable" } };

  const resp = await fetchFn(`${cnUrl}/api/cn/bcw/krc20/deploy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-td-admin-token": adminToken
    },
    body: JSON.stringify({
      intent: params.intent,
      auth_signature: params.authSignature
    })
  });

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = { ok: false, reason: "cn_non_json_response" };
  }

  return { ok: !!resp.ok && data && data.ok === true, status: resp.status, data };
}

function applyDirectEnergyLockAfterDeploy(args: {
  repoRoot: string;
  userId: string;
  appNetwork: EnergyNetworkId;
  ca: string;
}):
  | { ok: true; lock: EnergyTokenLockRecord }
  | { ok: false; reason: string } {
  try {
    const networkId: EnergyNetworkId = args.appNetwork;

    const ca = String(args.ca || "").trim().toLowerCase();
    if (!ca) return { ok: false, reason: "invalid_ca" };

    const store = readEnergyStore(args.repoRoot);
    const existing = store.energy_locks_by_network[networkId][ca] || null;

    const next: EnergyTokenLockRecord = existing
      ? {
          ...existing,
          is_active: true
        }
      : {
          network_id: networkId,
          ca,
          is_active: true,
          locked_by_user_id: String(args.userId || "").trim() || null,
          locked_at: new Date().toISOString()
        };

    store.energy_locks_by_network[networkId][ca] = next;
    writeEnergyStore(args.repoRoot, store);
    return { ok: true, lock: next };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function upsertDeployRegistrationFromReveal(args: {
  repoRoot: string;
  appNetwork: AppNetworkKey;
  ca: string;
  deployer: string;
  tokenName: string;
  decRaw: string;
  maxRaw: string;
  preRaw: string;
  resolveKrc20TokenMetadata?: (
    input: ResolveKrc20TokenMetadataInput
  ) => Promise<ResolveKrc20TokenMetadataResult>;
}): Promise<
  | {
      ok: true;
      netKey: AppNetworkKey;
      caKey: string;
      confirmationStatus: "pending_external_confirmation" | "resolved";
      cacheUpdated: boolean;
    }
  | { ok: false; reason: string }
> {
  const caKey = String(args.ca || "").trim().toLowerCase();
  const dep = String(args.deployer || "").trim();
  const nm = cleanName(typeof args.tokenName === "string" ? args.tokenName : "");

  if (!caKey) return { ok: false, reason: "missing_ca" };
  if (!dep) return { ok: false, reason: "missing_deployer" };

  const cfg0 = readWrappedConfigV7(args.repoRoot);
  const netKey: AppNetworkKey = args.appNetwork;

  const next0 = JSON.parse(JSON.stringify(cfg0 || {}));
  next0.issuance = next0.issuance || {};
  next0.issuance.deployerByNetwork = next0.issuance.deployerByNetwork || {};
  next0.issuance.deployerByNetwork[netKey] = next0.issuance.deployerByNetwork[netKey] || {};
  next0.issuance.deployerByNetwork[netKey][caKey] = dep;

  next0.issuance.metaByNetwork = next0.issuance.metaByNetwork || {};
  next0.issuance.metaByNetwork[netKey] = next0.issuance.metaByNetwork[netKey] || {};

  const nowMs = Date.now();
  const current0Raw = next0.issuance.metaByNetwork[netKey][caKey];
  const current0 =
    current0Raw && typeof current0Raw === "object"
      ? (current0Raw as Partial<IssuanceMetaEntry>)
      : null;

  next0.issuance.metaByNetwork[netKey][caKey] = {
    name: nm || current0?.name || null,
    tick: current0?.tick ?? null,
    decimals: validDigits(args.decRaw) ? Number.parseInt(args.decRaw, 10) : (current0?.decimals ?? null),
    max: validDigits(args.maxRaw) ? args.maxRaw : (current0?.max ?? null),
    lim: current0?.lim ?? null,
    pre: args.preRaw && validDigits(args.preRaw) ? args.preRaw : (current0?.pre ?? null),

    source: "deploy",
    status: "active",

    confirmationStatus: "pending_external_confirmation",

    ownerAddress: dep,

    commitTxId: current0?.commitTxId ?? null,
    revealTxId: caKey,

    createdAtMs:
      typeof current0?.createdAtMs === "number" && Number.isFinite(current0.createdAtMs) && current0.createdAtMs >= 0
        ? Math.trunc(current0.createdAtMs)
        : nowMs,
    updatedAtMs: nowMs,
    confirmedAtMs: null
  } satisfies IssuanceMetaEntry;

  writeWrappedConfigV7(args.repoRoot, next0);

  if (!args.resolveKrc20TokenMetadata) {
    return { ok: true, netKey, caKey, confirmationStatus: "pending_external_confirmation", cacheUpdated: false };
  }

  let resolved: CanonicalKrc20TokenMetadata | null = null;
  try {
    const r = await args.resolveKrc20TokenMetadata({
      networkId: netKey,
      lookup: { kind: "ca", value: caKey },
      options: { timeoutMs: 8000 }
    });
    if (r.ok) {
      resolved = r.data;
    }
  } catch {
    resolved = null;
  }

  if (!resolved) {
    return { ok: true, netKey, caKey, confirmationStatus: "pending_external_confirmation", cacheUpdated: false };
  }

  const quality = validateIssueModeKrc20Metadata({
    networkId: netKey,
    ca: caKey,
    metadata: resolved,
    expectedOwnerAddress: dep
  });

  if (!quality.ok) {
    return { ok: true, netKey, caKey, confirmationStatus: "pending_external_confirmation", cacheUpdated: false };
  }

  upsertTokenMetadataCacheEntry(args.repoRoot, {
    networkId: netKey,
    ca: caKey,
    metadata: resolved
  });

  const cfg1 = readWrappedConfigV7(args.repoRoot);
  const next1 = JSON.parse(JSON.stringify(cfg1 || {}));
  next1.issuance = next1.issuance || {};
  next1.issuance.deployerByNetwork = next1.issuance.deployerByNetwork || {};
  next1.issuance.deployerByNetwork[netKey] = next1.issuance.deployerByNetwork[netKey] || {};
  next1.issuance.deployerByNetwork[netKey][caKey] = dep;

  next1.issuance.metaByNetwork = next1.issuance.metaByNetwork || {};
  next1.issuance.metaByNetwork[netKey] = next1.issuance.metaByNetwork[netKey] || {};

  const current1Raw = next1.issuance.metaByNetwork[netKey][caKey];
  const current1 =
    current1Raw && typeof current1Raw === "object"
      ? (current1Raw as Partial<IssuanceMetaEntry>)
      : null;

  const confirmedAtMs = Date.now();

  next1.issuance.metaByNetwork[netKey][caKey] = issuanceMetaFromIssueModeMetadata({
    existing: current1 as IssuanceMetaEntry | null,
    metadata: resolved,
    source: "deploy",
    ownerAddress: dep,
    nowMs: confirmedAtMs
  });

  writeWrappedConfigV7(args.repoRoot, next1);

  return { ok: true, netKey, caKey, confirmationStatus: "resolved", cacheUpdated: true };
}

export function registerKrc20DeployRoutes(app: Express, ctx: Krc20DeployCtx): void {
  app.post("/api/v1/krc20/deploy", async (req: Request, res: Response) => {
    try {
      await ctx.ensureKaspaReady(ctx.repoRoot);

      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = ctx.readWalletStore(ctx.repoRoot, userId);
      const active = store && store.active_id
        ? (store.items || []).find((w: any) => w.id === store.active_id) ?? null
        : null;

      if (!active) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      }
      if (String(active.state || "") !== "READY") {
        return res.status(409).json({ ok: false, reason: "wallet_not_ready" });
      }

      const walletType = String(active.wallet_type || "").trim();
      const appNetwork = normalizeAppNetworkKey(String(active.network || ""));
      if (!appNetwork) {
        return res.status(409).json({ ok: false, reason: "unsupported_active_wallet_network" });
      }
      const walletNetwork: WalletNetworkType = walletNetworkTypeFor(appNetwork);
      const networkId: RpcNetworkId = rpcNetworkIdFor(appNetwork);

      const body = getBody(req);

      const stage = typeof body.stage === "string" ? body.stage.trim() : "";
      if (
        stage !== "krc_commit_build" &&
        stage !== "krc_commit_submit" &&
        stage !== "krc_reveal_wait" &&
        stage !== "krc_reveal_submit"
      ) {
        return res.status(400).json({
          ok: false,
          reason: "deploy_stage_required",
          error:
            "Deploy stage required (krc_commit_build | krc_commit_submit | krc_reveal_wait | krc_reveal_submit)"
        });
      }

      const name = cleanName(typeof body.name === "string" ? body.name : "");
      const dec = typeof body.dec === "string" ? body.dec.trim() : "";
      const max = typeof body.max === "string" ? body.max.trim() : "";
      const preRaw = typeof body.pre === "string" ? body.pre.trim() : "";
      const toRaw = typeof body.to === "string" ? body.to.trim() : "";
      const deployKind = typeof body.deployKind === "string" ? body.deployKind.trim() : "new";
      const energyLockRequested = parseEnergyLockRequested(body.energyLockRequested);

      const wrappedAssetRef = typeof body.wrappedAssetRef === "string" ? body.wrappedAssetRef.trim() : "";
      const wrappedVaultChain = typeof body.wrappedVaultChain === "string" ? body.wrappedVaultChain.trim() : "";
      const wrappedVaultAddress = typeof body.wrappedVaultAddress === "string" ? body.wrappedVaultAddress.trim() : "";
      const wrappedVaultAddressSepolia =
        typeof body.wrappedVaultAddressSepolia === "string" ? body.wrappedVaultAddressSepolia.trim() : "";

      const isWrapped = deployKind === "wrapped";
      const pre = isWrapped ? "0" : preRaw;
      const to = isWrapped ? "" : toRaw;

      if (!validName(name)) {
        return res.status(400).json({ ok: false, reason: "name_invalid", detail: "name must be 4–6 uppercase letters" });
      }
      if (!validDigits(max)) {
        return res.status(400).json({ ok: false, reason: "max_invalid", detail: "max must be digits only" });
      }
      if (isWrapped) {
        if (String(pre) !== "0") {
          return res.status(400).json({ ok: false, reason: "wrapped_pre_must_be_0" });
        }
        if (!wrappedVaultAddress) {
          return res.status(400).json({ ok: false, reason: "wrapped_vault_address_required" });
        }
        if (networkId === "mainnet") {
          const tok = requireAdminToken(req);
          if (!tok.ok) {
            return res.status(tok.status).type("text/plain").send(tok.reason);
          }
        }
      } else {
        if (pre && !validDigits(pre)) {
          return res.status(400).json({ ok: false, reason: "pre_invalid", detail: "pre must be digits only" });
        }
        if (pre && String(pre) !== "0" && !validKaspaAddrForRpcNetwork(networkId, to)) {
          return res.status(400).json({ ok: false, reason: "to_required_when_pre_gt_0" });
        }
      }

      const action: any = {
        p: "krc-20",
        op: "deploy",
        mod: "issue",
        name,
        max,
        dec
      };
      if (pre && String(pre) !== "0") action.pre = pre;
      if (to) action.to = to;

      const payloadJson = JSON.stringify(action);

      const cfg = ctx.getAppConfig(ctx.repoRoot);
      const feeRateMin = Number(cfg && cfg.fee_rate_min ? cfg.fee_rate_min : 1);
      const feeRate = Number.isFinite(feeRateMin) && feeRateMin > 0 ? feeRateMin : 1;

      const timeoutMs = parseTimeoutMs(body.timeout);

      const multScaled = parseMultiplierScaled1e8(body.priorityFee);
      const baseSompi = kaspaToSompi("1000");
      if (baseSompi === undefined || baseSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "base_deploy_fee_parse_failed" });
      }
      const revealPriorityFeeSompi = (baseSompi * multScaled) / 100000000n;

      const fromAddress = String(active.address0 || "").trim();
      if (!fromAddress) {
        return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
      }

      const lic = await ctx.requireMainnetLicenseOrReject({ networkId: networkId as any, userId });
      if (!lic.ok) {
        const out: any = { ok: false, reason: lic.reason, tick: lic.tick, ca: lic.ca };
        if ("error" in lic && lic.error) out.error = lic.error;
        return res.status(lic.status).json(out);
      }

      const rpc = await ctx.getSharedRpc(networkId);

      if (walletType !== "standard" && walletType !== "compliance") {
        return res.status(500).json({ ok: false, reason: "wallet_type_invalid" });
      }

      const buildWrappedEntry = (ca: string) => {
        const entry: any = {
          ca,
          name,
          decimals: Number(dec),
          assetRef: wrappedAssetRef,
          vault: { chain: (wrappedVaultChain || "unknown").trim() || "unknown", address: wrappedVaultAddress },
          delivery: "transfer_preferred"
        };
        if (wrappedVaultAddressSepolia) {
          entry.vaultTestnet = { chain: entry.vault.chain, address: wrappedVaultAddressSepolia, net: "sepolia" };
        }
        return entry;
      };

      const isBcwBrokerCustody = walletType === "compliance" && String(active.custody_model || "").trim() === "broker_1of1";

      if (isBcwBrokerCustody) {
        if (isWrapped) {
          return res.status(400).json({ ok: false, reason: "bcw_wrapped_deploy_not_supported" });
        }

        const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
        const bcwPre = pre && String(pre) !== "" ? pre : "0";
        const bcwTo = BigInt(bcwPre) > 0n ? to : "";

        if (!brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_broker_custody_key_ref" });
        }
        if (!userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_user_auth_pubkey" });
        }

        const decNum = Number.parseInt(dec, 10);
        if (!/^[0-9]{1,2}$/.test(dec) || !Number.isFinite(decNum) || decNum < 0 || decNum > 18) {
          return res.status(400).json({ ok: false, reason: "dec_invalid", detail: "dec must be an integer between 0 and 18" });
        }

        if (stage === "krc_commit_build") {
          const createdAt = new Date();
          const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
          const intent: BcwKrc20DeployIntentV1 = {
            v: 1,
            purpose: "bcw_krc20_deploy",
            wallet_id: String(active.id || "").trim(),
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: walletNetwork,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: fromAddress,
            name,
            max,
            dec,
            pre: bcwPre,
            to_address: bcwTo,
            user_auth_pubkey: userAuthPubkey,
            created_at: createdAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            nonce: `BCWDEPLOYREQ_${randomBytes(16).toString("hex")}`
          };

          return res.json({
            ok: true,
            stage: "bcw_krc20_deploy_intent",
            networkId,
            fromAddress,
            custody_model: "broker_1of1",
            intent,
            intent_message: canonicalBcwKrc20DeployIntentMessage(intent)
          });
        }

        if (stage === "krc_commit_submit") {
          const intent = normalizeBcwKrc20DeployIntent((body as any).bcw_krc20_deploy_intent);
          const authSignature = typeof (body as any).bcw_auth_signature === "string" ? String((body as any).bcw_auth_signature).trim() : "";

          if (!intent) {
            return res.status(400).json({ ok: false, reason: "bcw_krc20_deploy_intent_invalid" });
          }
          if (!authSignature) {
            return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required" });
          }

          if (intent.wallet_id !== String(active.id || "").trim()) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_wallet_mismatch" });
          }
          if (intent.wallet_type !== "compliance" || intent.custody_model !== "broker_1of1") {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_custody_mismatch" });
          }
          if (intent.network !== walletNetwork) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_network_mismatch" });
          }
          if (intent.broker_custody_key_ref !== brokerCustodyKeyRef) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_key_ref_mismatch" });
          }
          if (intent.from_address !== fromAddress) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_from_mismatch" });
          }
          if (intent.user_auth_pubkey !== userAuthPubkey) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_auth_pubkey_mismatch" });
          }
          if (intent.name !== name || intent.max !== max || intent.dec !== dec || intent.pre !== bcwPre || intent.to_address !== bcwTo) {
            return res.status(409).json({ ok: false, reason: "bcw_krc20_deploy_intent_payload_mismatch" });
          }

          const cn = await postBcwKrc20DeployToCn({
            repoRoot: ctx.repoRoot,
            getAppConfig: ctx.getAppConfig,
            intent,
            authSignature
          });

          if (!cn.ok) {
            const errMsg = cn.data && (cn.data.error || cn.data.reason) ? String(cn.data.error || cn.data.reason) : "CN rejected";
            return res.status(cn.status || 502).json({
              ok: false,
              reason: "bcw_krc20_deploy_cn_rejected",
              error: errMsg,
              cn: cn.data
            });
          }

          const cnData = cn.data || {};
          const commitTxids = Array.isArray(cnData.commitTxids)
            ? cnData.commitTxids.filter((x: any) => typeof x === "string" && x.trim()).map((x: any) => String(x).trim())
            : [];
          const revealTxids = Array.isArray(cnData.revealTxids)
            ? cnData.revealTxids.filter((x: any) => typeof x === "string" && x.trim()).map((x: any) => String(x).trim())
            : [];
          const revealTxId = typeof cnData.txid === "string" && cnData.txid.trim() ? String(cnData.txid).trim() : (revealTxids[0] || "");

          if (!revealTxId) {
            return res.status(502).json({ ok: false, reason: "bcw_krc20_deploy_cn_missing_reveal_txid", cn: cnData });
          }

          const reg = await upsertDeployRegistrationFromReveal({
            repoRoot: ctx.repoRoot,
            appNetwork,
            ca: revealTxId,
            deployer: fromAddress,
            tokenName: name,
            decRaw: dec,
            maxRaw: max,
            preRaw: bcwPre,
            resolveKrc20TokenMetadata: ctx.resolveKrc20TokenMetadata
          });

          let energyLock: any = undefined;
          if (energyLockRequested) {
            energyLock = applyDirectEnergyLockAfterDeploy({
              repoRoot: ctx.repoRoot,
              userId,
              appNetwork,
              ca: revealTxId
            });
          }

          return res.json({
            ok: true,
            stage: "bcw_krc20_deploy_submit",
            networkId,
            fromAddress,
            custody_model: "broker_1of1",
            txid: revealTxId,
            txids: revealTxids.length > 0 ? revealTxids : [revealTxId],
            commitTxids,
            revealTxids: revealTxids.length > 0 ? revealTxids : [revealTxId],
            ca: revealTxId,
            payloadJson: typeof cnData.payloadJson === "string" ? cnData.payloadJson : payloadJson,
            deployRegistration: reg,
            energyLock,
            cn: cnData
          });
        }

        return res.status(400).json({
          ok: false,
          reason: "bcw_krc20_deploy_stage_invalid",
          error: "BCW deploy uses krc_commit_build followed by krc_commit_submit"
        });
      }

      if (walletType === "standard") {
        if (stage === "krc_commit_build") {
          const utxos = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
          const entries = utxos && Array.isArray((utxos as any).entries) ? (utxos as any).entries : [];

          if (!entries || entries.length === 0) {
            return res.json({
              ok: false,
              reason: "no_utxos",
              error: "No UTXOs available (fund the wallet first)"
            });
          }

          const krc20DeployCommitCovenantExclusion = await applyKrc20DeployCommitCovenantExclusion({
            networkId,
            address: fromAddress,
            entries
          });
          const krc20DeployCommitEntries = krc20DeployCommitCovenantExclusion.entries;

          if (!krc20DeployCommitEntries.length) {
            return res.json({
              ok: false,
              reason: "krc20_deploy_commit_only_covenant_utxos",
              error: "Only covenant-bearing UTXOs are available. KRC20 deploy commit funding is blocked for those outputs.",
              covenant_exclusion: krc20DeployCommitCovenantExclusion.exclusion
            });
          }

          const safeEntries = krc20DeployCommitEntries.map((e: any) => ({
            outpoint:
              e && e.outpoint && typeof e.outpoint.toJSON === "function" ? e.outpoint.toJSON() : (e ? e.outpoint : null),
            amount: e && typeof e.amount === "bigint" ? e.amount.toString() : String(e && e.amount !== undefined ? e.amount : ""),
            scriptPublicKey:
              e && e.scriptPublicKey && typeof e.scriptPublicKey.toJSON === "function"
                ? e.scriptPublicKey.toJSON()
                : (e ? e.scriptPublicKey : null),
            blockDaaScore:
              e && typeof e.blockDaaScore === "bigint"
                ? e.blockDaaScore.toString()
                : String(e && e.blockDaaScore !== undefined ? e.blockDaaScore : ""),
            isCoinbase: !!(e && e.isCoinbase),
          }));

          const maxMass = maximumStandardTransactionMass();
          const feeRateInt = Math.max(1, Math.floor(feeRate));
          const revealNetworkFeeBudgetSompi = BigInt(feeRateInt) * maxMass;

          const minDeployFeeSompi0 = kaspaToSompi("1000");
          if (minDeployFeeSompi0 === undefined) {
            return res.status(500).json({ ok: false, reason: "kaspa_to_sompi_failed" });
          }
          const minDeployFeeSompi = minDeployFeeSompi0;
          const commitAmountSompi = minDeployFeeSompi + revealNetworkFeeBudgetSompi;

          return res.json({
            ok: true,
            stage: "krc_commit_build",
            networkId,
            feeRate,
            fromAddress,
            commitAmountSompi: commitAmountSompi.toString(),
            minDeployFeeSompi: minDeployFeeSompi.toString(),
            payloadJson,
            revealPriorityFeeSompi: revealPriorityFeeSompi.toString(),
            timeoutMs,
            entries: safeEntries,
            covenant_exclusion: krc20DeployCommitCovenantExclusion.exclusion
          });
        }

        if (stage === "krc_commit_submit" || stage === "krc_reveal_submit") {
          const signed = Array.isArray((body as any).signed_txs) ? (body as any).signed_txs : null;
          if (!signed || signed.length === 0) {
            return res.status(400).json({ ok: false, reason: "missing_signed_txs" });
          }

          const txids: string[] = [];
          for (const txSafe of signed) {
            if (typeof txSafe !== "string" || !txSafe.trim()) continue;
            const tx = Transaction.deserializeFromSafeJSON(txSafe);
            const r = await rpc.submitTransaction({ transaction: tx });
            txids.push(r.transactionId);
          }

          if (txids.length === 0) {
            return res.status(400).json({ ok: false, reason: "missing_txids" });
          }

          let wrappedRegistration: any = undefined;
          let wrappedRegistrationInput: any = undefined;
          let energyLock: any = undefined;

          if (stage === "krc_reveal_submit") {
            const revealTxId = txids[0] || "";

            if (!isWrapped) {
              await upsertDeployRegistrationFromReveal({
                repoRoot: ctx.repoRoot,
                appNetwork,
                ca: revealTxId,
                deployer: fromAddress,
                tokenName: name,
                decRaw: dec,
                maxRaw: max,
                preRaw: pre,
                resolveKrc20TokenMetadata: ctx.resolveKrc20TokenMetadata
              });

              if (energyLockRequested) {
                energyLock = applyDirectEnergyLockAfterDeploy({
                  repoRoot: ctx.repoRoot,
                  userId,
                  appNetwork,
                  ca: revealTxId
                });
              }
            }

            if (isWrapped) {
              wrappedRegistrationInput = buildWrappedEntry(revealTxId);

              try {
                const cfg0 = readWrappedConfigV7(ctx.repoRoot);
                const next = JSON.parse(JSON.stringify(cfg0 || {}));

                const netKey: AppNetworkKey = appNetwork;

                const caKey = String(revealTxId || "").trim().toLowerCase();
                next.controlledAssetsByNetwork = next.controlledAssetsByNetwork || {};
                next.controlledAssetsByNetwork[netKey] = next.controlledAssetsByNetwork[netKey] || {};

                next.vaults = next.vaults || {};
                const vault0 = wrappedRegistrationInput && wrappedRegistrationInput.vault && typeof wrappedRegistrationInput.vault === "object"
                  ? wrappedRegistrationInput.vault
                  : null;

                const chain = vault0 ? String(vault0.chain || "").trim().toLowerCase() : "";
                const addr = vault0 ? String(vault0.address || "").trim() : "";

                let mode = "unknown";
                let vaultId = "";

                if (chain === "ethereum" || chain === "etherium") {
                  mode = "evm_erc20";
                  vaultId = String(next?.defaults?.evmVaultId || "evm_mainnet_default");
                  if (!next.vaults[vaultId]) {
                    next.vaults[vaultId] = { chain: "ethereum", network: "mainnet", address: addr || "0x161B5B6706EA0F8B6ea6aE0BdC9457AC2724e833" };
                  }
                } else if (chain && addr) {
                  mode = "utxo";
                  vaultId = `${chain}_mainnet_vault`;
                  if (!next.vaults[vaultId]) {
                    next.vaults[vaultId] = { chain, network: "mainnet", address: addr };
                  }
                }

                const assetRef = String(wrappedRegistrationInput?.assetRef || "").trim();
                const controlled: any = {
                  ca: revealTxId,
                  name: String(wrappedRegistrationInput?.name || "").trim(),
                  decimals: Number(wrappedRegistrationInput?.decimals || 0),
                  assetRef,
                  mode
                };

                if (vaultId) controlled.vaultId = vaultId;
                if (mode === "evm_erc20" && assetRef) controlled.erc20Symbol = assetRef;
                if (wrappedRegistrationInput?.delivery) controlled.delivery = wrappedRegistrationInput.delivery;
                if (wrappedRegistrationInput?.fees) controlled.fees = wrappedRegistrationInput.fees;
                if (wrappedRegistrationInput?.vaultTestnet) controlled.vaultTestnet = wrappedRegistrationInput.vaultTestnet;

                next.controlledAssetsByNetwork[netKey][caKey] = controlled;

                writeWrappedConfigV7(ctx.repoRoot, next);
                wrappedRegistration = { ok: true, network: netKey, ca: revealTxId };
              } catch (e: any) {
                wrappedRegistration = { ok: false, reason: e?.message || String(e) };
              }
            }
          }

          return res.json({
            ok: true,
            stage,
            networkId,
            txids,
            commitTxids: stage === "krc_commit_submit" ? txids : undefined,
            revealTxids: stage === "krc_reveal_submit" ? txids : undefined,
            wrappedRegistration,
            wrappedRegistrationInput,
            energyLock
          });
        }

        if (stage === "krc_reveal_wait") {
          const expectedPrefix = kaspaAddressPrefixForRpcNetwork(networkId);
          const p2shAddress = typeof (body as any).p2shAddress === "string" ? String((body as any).p2shAddress).trim() : "";
          const commitTxidsRaw = Array.isArray((body as any).commitTxids) ? (body as any).commitTxids : [];
          const commitTxids = commitTxidsRaw
            .filter((x: any) => typeof x === "string" && x.trim())
            .map((x: any) => String(x).trim());

          if (!validP2shAddressForRpcNetwork(networkId, p2shAddress)) {
            return res.status(400).json({
              ok: false,
              reason: "invalid_p2sh_address",
              error: "Invalid P2SH address"
            });
          }

          if (!p2shAddress.startsWith(expectedPrefix)) {
            return res.json({
              ok: false,
              reason: "invalid_p2sh_network",
              error: `P2SH address must start with ${expectedPrefix}`
            });
          }

          if (commitTxids.length === 0) {
            return res.status(400).json({
              ok: false,
              reason: "missing_commit_txids",
              error: "Missing commitTxids[]"
            });
          }

          const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

          let match: any = null;
          const loops = Math.max(10, Math.min(600, Math.ceil(timeoutMs / 1000)));
          for (let i = 0; i < loops; i++) {
            const u = await rpc.getUtxosByAddresses({ addresses: [p2shAddress] });
            const entries = u && Array.isArray((u as any).entries) ? (u as any).entries : [];
            match =
              entries.find(
                (e: any) =>
                  e &&
                  e.outpoint &&
                  typeof e.outpoint.transactionId === "string" &&
                  commitTxids.includes(e.outpoint.transactionId)
              ) || null;

            if (match) break;
            await sleepMs(1000);
          }

          if (!match) {
            return res.status(409).json({
              ok: false,
              reason: "commit_utxo_not_found",
              error: "Commit UTXO not found yet"
            });
          }

          const commitEntry = {
            outpoint:
              match && match.outpoint && typeof match.outpoint.toJSON === "function"
                ? match.outpoint.toJSON()
                : (match ? match.outpoint : null),
            amount: match && typeof match.amount === "bigint" ? match.amount.toString() : String(match && match.amount !== undefined ? match.amount : ""),
            scriptPublicKey:
              match && match.scriptPublicKey && typeof match.scriptPublicKey.toJSON === "function"
                ? match.scriptPublicKey.toJSON()
                : (match ? match.scriptPublicKey : null),
            blockDaaScore:
              match && typeof match.blockDaaScore === "bigint"
                ? match.blockDaaScore.toString()
                : String(match && match.blockDaaScore !== undefined ? match.blockDaaScore : ""),
            isCoinbase: !!(match && match.isCoinbase),
          };

          return res.json({
            ok: true,
            stage: "krc_reveal_wait",
            networkId,
            commitEntry
          });
        }

        return res.status(400).json({
          ok: false,
          reason: "deploy_stage_required",
          error:
            "Deploy stage required (krc_commit_build | krc_commit_submit | krc_reveal_wait | krc_reveal_submit)"
        });
      }

      if (walletType === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_krc20_deploy_removed",
          error: "Legacy 2-of-2 Compliance Wallet deploy has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "deploy_exception", error: String(err) });
    }
  });
}
