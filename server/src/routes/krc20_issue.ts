import { randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import { Transaction, kaspaToSompi, RpcClient as ToccataRpcClient } from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";
import { readWrappedConfigV7 } from "../storage/wrappedConfigStore";
import { readTokenMetadataCacheStore } from "../storage/tokenMetadataCacheStore";
import { isIncompleteIssueModeKrc20Metadata, refreshIssueModeKrc20MetadataForCa } from "../krc20MetadataReconciler";
import { readEnergyStore } from "../storage/energyStore";
import type { AppNetworkKey, EnergyNetworkId, RpcNetworkId, WalletNetworkType } from "../types";

export type Krc20IssueCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<any>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  getAppConfig: (repoRootPath: string) => any;

  resolveKrc20TokenMetadata?: (
    input: {
      networkId: AppNetworkKey;
      lookup: { kind: "ca" | "tick"; value: string };
      options?: { timeoutMs?: number };
    }
  ) => Promise<
    | { ok: true; data: import("../storage/tokenMetadataCacheStore").CanonicalKrc20TokenMetadata }
    | { ok: false; reason: string }
  >;

  krc20CommitRevealIssueModeDeploy: (params: {
    rpc: any;
    networkId: string;
    feeRate: number;
    fromAddress: string;
    priv0: any;
    payloadJson: string;
    revealPriorityFeeSompi: bigint;
    timeoutMs: number;
  }) => Promise<{ commitTxids: string[]; revealTxids: string[] }>;

  requireMainnetLicenseOrReject: (args: {
    networkId: RpcNetworkId;
    userId: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; status: number; reason: string; tick: string; ca: string; error?: string }
  >;
};

function validDigits(s: string): boolean {
  return /^\d{1,64}$/.test(String(s || "").trim());
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

const KRC20_ISSUE_TN10_COVENANT_RPC_URL = "ws://tn10.token-depot.co:17210";

type Krc20IssueCommitCovenantExclusion = {
  inspection_kind: "krc20_issue_commit_covenant_exclusion_v1";
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

function krc20IssuePrintable(value: any): string | null {
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

function krc20IssueReferenceEntry(reference: any): any | null {
  return reference && typeof reference === "object" && reference.entry ? reference.entry : null;
}

function krc20IssueCovenantIdFromReference(reference: any): string | null {
  const entry = krc20IssueReferenceEntry(reference);
  const canonical = entry ? entry.covenantId : undefined;
  return canonical === null || canonical === undefined ? null : krc20IssuePrintable(canonical);
}

function krc20IssueOutpointKeyFromValue(outpoint: any): string {
  if (!outpoint) return "";
  if (typeof outpoint === "string") return outpoint;
  if (outpoint && typeof outpoint.toJSON === "function") return krc20IssueOutpointKeyFromValue(outpoint.toJSON());
  const transactionId = krc20IssuePrintable(outpoint.transactionId ?? outpoint.transaction_id ?? outpoint.txid);
  const rawIndex = outpoint.index ?? outpoint.outputIndex ?? outpoint.output_index;
  const index = rawIndex === null || rawIndex === undefined ? null : Number(rawIndex);
  return transactionId && Number.isFinite(index) ? `${transactionId}:${index}` : "";
}

function krc20IssueOutpointKeyFromReference(reference: any): string {
  const entry = krc20IssueReferenceEntry(reference);
  const candidates = [
    reference && reference.outpoint,
    entry && entry.outpoint,
    reference && reference.utxo && reference.utxo.outpoint,
    reference && reference.utxoEntry && reference.utxoEntry.outpoint
  ];

  for (const candidate of candidates) {
    const key = krc20IssueOutpointKeyFromValue(candidate);
    if (key) return key;
  }
  return "";
}

function krc20IssueEntriesFromResponse(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.entries)) return response.entries;
  if (response && Array.isArray(response.utxos)) return response.utxos;
  if (response && Array.isArray(response.result)) return response.result;
  return [];
}

async function applyKrc20IssueCommitCovenantExclusion(args: {
  networkId: RpcNetworkId;
  address: string;
  entries: any[];
}): Promise<{ entries: any[]; exclusion: Krc20IssueCommitCovenantExclusion }> {
  const totalEntries = Array.isArray(args.entries) ? args.entries.length : 0;
  const covenantOutpoints = new Set<string>();

  for (const entry of args.entries) {
    const covenantId = krc20IssueCovenantIdFromReference(entry);
    const key = covenantId ? krc20IssueOutpointKeyFromReference(entry) : "";
    if (key) covenantOutpoints.add(key);
  }

  if (args.networkId === "testnet-10") {
    let rpc: InstanceType<typeof ToccataRpcClient> | null = null;
    try {
      rpc = new ToccataRpcClient({ url: KRC20_ISSUE_TN10_COVENANT_RPC_URL, networkId: args.networkId });
      await rpc.connect();
      const response = await rpc.getUtxosByAddresses({ addresses: [args.address] });
      const toccataEntries = krc20IssueEntriesFromResponse(response);
      for (const entry of toccataEntries) {
        const covenantId = krc20IssueCovenantIdFromReference(entry);
        const key = covenantId ? krc20IssueOutpointKeyFromReference(entry) : "";
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
    const key = krc20IssueOutpointKeyFromReference(entry);
    return !key || !covenantOutpoints.has(key);
  });
  const excludedOutpoints = Array.from(covenantOutpoints).sort();

  return {
    entries: spendableEntries,
    exclusion: {
      inspection_kind: "krc20_issue_commit_covenant_exclusion_v1",
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

function isWrappedCa(cfg: any, netId: AppNetworkKey, ca: string): boolean {
  const c = String(ca || "").trim().toLowerCase();
  if (!c) return false;

  const bucket = cfg && cfg.controlledAssetsByNetwork ? cfg.controlledAssetsByNetwork[netId] : null;
  if (!bucket || typeof bucket !== "object") return false;

  if ((bucket as any)[ca]) return true;
  if ((bucket as any)[c]) return true;

  for (const v of Object.values(bucket)) {
    if (!v || typeof v !== "object") continue;
    const vca = String((v as any).ca || "").trim().toLowerCase();
    if (vca && vca === c) return true;
  }
  return false;
}

function expectedDeployerForCa(cfg: any, netId: AppNetworkKey, ca: string): string {
  const c = String(ca || "").trim();
  const lc = c.toLowerCase();
  if (!c) return "";

  const bucket = (cfg as any)?.issuance?.deployerByNetwork ? (cfg as any).issuance.deployerByNetwork[netId] : null;
  if (!bucket || typeof bucket !== "object") return "";

  if ((bucket as any)[c]) return String((bucket as any)[c] || "").trim();
  if ((bucket as any)[lc]) return String((bucket as any)[lc] || "").trim();

  return "";
}

function expectedDeployerForEnergyCa(repoRoot: string, networkId: EnergyNetworkId, ca: string): string {
  const c = String(ca || "").trim().toLowerCase();
  if (!c) return "";

  const store = readTokenMetadataCacheStore(repoRoot);
  const entry = store.byNetwork[networkId][c] || null;
  return entry && entry.metadata && entry.metadata.issuance && typeof entry.metadata.issuance.toAddress === "string"
    ? String(entry.metadata.issuance.toAddress || "").trim()
    : "";
}

function isValidCaKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(String(value || "").trim().toLowerCase());
}

async function refreshIssueModeMetadataForActiveWallet(args: {
  repoRoot: string;
  netId: AppNetworkKey;
  ca: string;
  activeAddr0: string;
  expectedDeployer: string;
  resolveKrc20TokenMetadata?: Krc20IssueCtx["resolveKrc20TokenMetadata"];
}): Promise<{ refreshed: boolean }> {
  const caKey = String(args.ca || "").trim().toLowerCase();
  if (!isValidCaKey(caKey)) return { refreshed: false };
  if (!args.resolveKrc20TokenMetadata) return { refreshed: false };

  const expectedOwnerAddress = String(args.expectedDeployer || args.activeAddr0 || "").trim();
  if (!expectedOwnerAddress) return { refreshed: false };

  const cache = readTokenMetadataCacheStore(args.repoRoot);
  const entry = cache.byNetwork[args.netId]?.[caKey] || null;
  const cacheIncomplete = isIncompleteIssueModeKrc20Metadata({
    networkId: args.netId,
    ca: caKey,
    metadata: entry?.metadata || null,
    expectedOwnerAddress
  });

  if (args.expectedDeployer && !cacheIncomplete) return { refreshed: false };

  const refreshed = await refreshIssueModeKrc20MetadataForCa({
    repoRoot: args.repoRoot,
    networkId: args.netId,
    ca: caKey,
    resolveKrc20TokenMetadata: args.resolveKrc20TokenMetadata,
    expectedOwnerAddress,
    source: "deploy",
    timeoutMs: 10_000
  });

  return { refreshed: refreshed.ok === true && refreshed.updated === true };
}

function parseEnergySiteId(body: any): string {
  return String(
    body?.energy_site_id ??
    body?.energySiteId ??
    body?.site_id ??
    body?.siteId ??
    ""
  ).trim();
}

type BcwKrc20IssueBurnIntentV1 = {
  v: 1;
  purpose: "bcw_krc20_issue_burn";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "testnet" | "mainnet";
  broker_custody_key_ref: string;
  from_address: string;
  mode: "issue" | "burn";
  ca: string;
  amt: string;
  to_address: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwIssueBurnString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBcwIssueBurnIso(value: unknown): string {
  const s = normalizeBcwIssueBurnString(value);
  const ms = Date.parse(s);
  if (!s || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function normalizeBcwKrc20IssueBurnIntent(raw: unknown): BcwKrc20IssueBurnIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network = input.network === "testnet" || input.network === "mainnet" ? input.network : null;
  if (!network) return null;

  const modeRaw = normalizeBcwIssueBurnString(input.mode).toLowerCase();
  const mode = modeRaw === "issue" || modeRaw === "burn" ? modeRaw : "";
  const networkId = network === "mainnet" ? "mainnet" : "testnet-10";

  const intent: BcwKrc20IssueBurnIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_krc20_issue_burn" ? "bcw_krc20_issue_burn" : "" as "bcw_krc20_issue_burn",
    wallet_id: normalizeBcwIssueBurnString(input.wallet_id),
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: normalizeBcwIssueBurnString(input.broker_custody_key_ref),
    from_address: normalizeBcwIssueBurnString(input.from_address),
    mode: mode as "issue" | "burn",
    ca: normalizeBcwIssueBurnString(input.ca).toLowerCase(),
    amt: normalizeBcwIssueBurnString(input.amt),
    to_address: normalizeBcwIssueBurnString(input.to_address),
    user_auth_pubkey: normalizeBcwIssueBurnString(input.user_auth_pubkey),
    created_at: normalizeBcwIssueBurnIso(input.created_at),
    expires_at: normalizeBcwIssueBurnIso(input.expires_at),
    nonce: normalizeBcwIssueBurnString(input.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_krc20_issue_burn") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!validKaspaAddrForRpcNetwork(networkId as RpcNetworkId, intent.from_address)) return null;
  if (intent.mode !== "issue" && intent.mode !== "burn") return null;
  if (!/^[a-f0-9]{64}$/.test(intent.ca)) return null;
  if (!validDigits(intent.amt) || BigInt(intent.amt) <= 0n) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;
  if (!/^BCWISSUEREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;
  if (intent.mode === "issue" && !validKaspaAddrForRpcNetwork(networkId as RpcNetworkId, intent.to_address)) return null;
  if (intent.mode === "burn" && intent.to_address) return null;

  return intent;
}

function canonicalBcwKrc20IssueBurnIntentMessage(intent: BcwKrc20IssueBurnIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    mode: intent.mode,
    ca: intent.ca,
    amt: intent.amt,
    to_address: intent.to_address,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

async function postBcwKrc20IssueBurnToCn(params: {
  repoRoot: string;
  getAppConfig: (repoRootPath: string) => any;
  intent: BcwKrc20IssueBurnIntentV1;
  authSignature: string;
}): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = params.getAppConfig(params.repoRoot);
  const cnUrl = String(cfg && cfg.cn_url ? cfg.cn_url : "").trim().replace(/\/+$/, "");
  if (!cnUrl) return { ok: false, status: 500, data: { ok: false, reason: "cn_url_missing" } };

  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) return { ok: false, status: 500, data: { ok: false, reason: "td_admin_token_missing" } };

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") return { ok: false, status: 500, data: { ok: false, reason: "fetch_unavailable" } };

  const resp = await fetchFn(`${cnUrl}/api/cn/bcw/krc20/issue-burn`, {
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

export function registerKrc20IssueRoutes(app: Express, ctx: Krc20IssueCtx): void {
  const ensureAuthedActiveWalletOrReject = async (req: Request, res: Response) => {
    await ctx.ensureKaspaReady(ctx.repoRoot);

    const userId = String((res.locals as any).td_user_id || "").trim();
    if (!userId) {
      res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      return null;
    }

    const store = ctx.readWalletStore(ctx.repoRoot, userId);
    const active = store && store.active_id
      ? (store.items || []).find((w: any) => w.id === store.active_id) ?? null
      : null;

    if (!active) {
      res.status(409).json({ ok: false, reason: "no_active_wallet" });
      return null;
    }
    if (String(active.state || "") !== "READY") {
      res.status(409).json({ ok: false, reason: "wallet_not_ready" });
      return null;
    }

    const walletType = String(active.wallet_type || "").trim();
    const appNetwork = normalizeAppNetworkKey(String(active.network || ""));
    if (!appNetwork) {
      res.status(409).json({ ok: false, reason: "unsupported_active_wallet_network" });
      return null;
    }
    const walletNetwork = walletNetworkTypeFor(appNetwork);
    const networkId = rpcNetworkIdFor(appNetwork);

    const body = req.body && typeof req.body === "object" ? (req.body as any) : {};
    const modeRaw = String(body.mode || "issue").trim().toLowerCase();
    const mode = modeRaw === "burn" ? "burn" : "issue";
    const ca = String(body.ca || "").trim();
    const amt = String(body.amt || "").trim();
    const to = mode === "burn" ? "" : String(body.to || "").trim();

    if (!ca) {
      res.status(400).json({ ok: false, reason: "ca_required" });
      return null;
    }
    if (!validDigits(amt)) {
      res.status(400).json({ ok: false, reason: "amt_invalid", detail: "amt must be digits only" });
      return null;
    }
    if (mode !== "burn" && (!to || !validKaspaAddrForRpcNetwork(networkId, to))) {
      res.status(400).json({ ok: false, reason: "to_invalid", detail: "to must be a valid address for the active network" });
      return null;
    }

    let cfg = readWrappedConfigV7(ctx.repoRoot);
    const netId: AppNetworkKey = appNetwork;
    const energyNetworkId: EnergyNetworkId = appNetwork === "mainnet" ? "mainnet" : "tn10";
    const energyStore = readEnergyStore(ctx.repoRoot);
    const energyLocksForNetwork = energyStore.energy_locks_by_network[energyNetworkId] || {};
    const energyLock = energyLocksForNetwork[String(ca || "").trim().toLowerCase()] || null;
    const energySiteId = parseEnergySiteId(body);

    const activeAddr0 = String(active.address0 || "").trim();
    if (!activeAddr0) {
      res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
      return null;
    }

    let expectedDeployer = expectedDeployerForCa(cfg, netId, ca);
    const refresh = await refreshIssueModeMetadataForActiveWallet({
      repoRoot: ctx.repoRoot,
      netId,
      ca,
      activeAddr0,
      expectedDeployer,
      resolveKrc20TokenMetadata: ctx.resolveKrc20TokenMetadata
    });
    if (refresh.refreshed) {
      cfg = readWrappedConfigV7(ctx.repoRoot);
      expectedDeployer = expectedDeployerForCa(cfg, netId, ca);
    }

    if (!expectedDeployer && energyLock && energyLock.is_active === true) {
      expectedDeployer = expectedDeployerForEnergyCa(ctx.repoRoot, energyNetworkId, ca);
    }

    if (!expectedDeployer) {
      res.status(403).json({
        ok: false,
        reason: "unknown_ca_deployer",
        network: netId,
        ca,
        active: activeAddr0
      });
      return null;
    }
    if (String(expectedDeployer).toLowerCase() !== String(activeAddr0).toLowerCase()) {
      res.status(403).json({
        ok: false,
        reason: "issuer_mismatch",
        network: netId,
        ca,
        expected: expectedDeployer,
        active: activeAddr0
      });
      return null;
    }

    if (energyLock && energyLock.is_active === true) {
      if (!energySiteId) {
        res.status(403).json({
          ok: false,
          reason: "energy_issue_locked",
          network: energyNetworkId,
          ca
        });
        return null;
      }

      const energySite = energyStore.sites_by_id[energySiteId] || null;
      if (!energySite || energySite.owner_user_id !== userId || energySite.is_active !== true) {
        res.status(403).json({
          ok: false,
          reason: "energy_issue_site_invalid",
          network: energyNetworkId,
          ca,
          site_id: energySiteId
        });
        return null;
      }
    }

    const action = mode === "burn"
      ? { p: "krc-20", op: "burn", ca, amt }
      : { p: "krc-20", op: "issue", ca, amt, to };
    const payloadJson = JSON.stringify(action);

    const cfgApp = ctx.getAppConfig(ctx.repoRoot);
    const feeRateMin = Number(cfgApp && cfgApp.fee_rate_min ? cfgApp.fee_rate_min : 1);
    const feeRate = Number.isFinite(feeRateMin) && feeRateMin > 0 ? feeRateMin : 1;

    const timeoutMs = 120_000;

    const revealPriorityFeeSompi = kaspaToSompi("1");
    if (revealPriorityFeeSompi === undefined || revealPriorityFeeSompi <= 0n) {
      res.status(500).json({ ok: false, reason: "issue_priority_fee_parse_failed" });
      return null;
    }

    const fromAddress = String(active.address0 || "").trim();
    if (!fromAddress) {
      res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
      return null;
    }

    const lic = await ctx.requireMainnetLicenseOrReject({ networkId, userId });
    if (!lic.ok) {
      const out: any = { ok: false, reason: lic.reason, tick: lic.tick, ca: lic.ca };
      if ("error" in lic && lic.error) out.error = lic.error;
      res.status(lic.status).json(out);
      return null;
    }

    const rpc = await ctx.getSharedRpc(networkId);

    return {
      userId,
      active,
      walletType,
      walletNetwork,
      networkId,
      netId,
      cfgApp,
      feeRate,
      timeoutMs,
      revealPriorityFeeSompi,
      fromAddress,
      mode,
      ca,
      amt,
      to,
      payloadJson,
      rpc,
      body
    };
  };

  app.post("/api/v1/krc20/issue/build-commit", async (req: Request, res: Response) => {
    try {
      const base = await ensureAuthedActiveWalletOrReject(req, res);
      if (!base) return;

      const { walletType, walletNetwork, networkId, feeRate, timeoutMs, revealPriorityFeeSompi, fromAddress, rpc, cfgApp } = base;

      if (walletType !== "standard" && walletType !== "compliance") {
        return res.status(500).json({ ok: false, reason: "wallet_type_invalid" });
      }

      const utxos = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
      const entries = utxos && Array.isArray((utxos as any).entries) ? (utxos as any).entries : [];

      if (!entries || entries.length === 0) {
        return res.json({ ok: false, reason: "no_utxos", error: "No UTXOs available (fund the wallet first)" });
      }

      const payloadJson = String((base as any).payloadJson || "");
      if (!payloadJson) {
        return res.status(500).json({ ok: false, reason: "payload_missing" });
      }

      const isBcwBrokerCustody = walletType === "compliance" && String((base as any).active.custody_model || "").trim() === "broker_1of1";

      if (isBcwBrokerCustody) {
        const active = (base as any).active || {};
        const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
        const mode = String((base as any).mode || "issue") === "burn" ? "burn" : "issue";
        const ca = String((base as any).ca || "").trim().toLowerCase();
        const amt = String((base as any).amt || "").trim();
        const toAddress = mode === "issue" ? String((base as any).to || "").trim() : "";

        if (!brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_broker_custody_key_ref" });
        }
        if (!userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_user_auth_pubkey" });
        }

        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
        const intent: BcwKrc20IssueBurnIntentV1 = {
          v: 1,
          purpose: "bcw_krc20_issue_burn",
          wallet_id: String(active.id || "").trim(),
          wallet_type: "compliance",
          custody_model: "broker_1of1",
          network: walletNetwork,
          broker_custody_key_ref: brokerCustodyKeyRef,
          from_address: fromAddress,
          mode,
          ca,
          amt,
          to_address: toAddress,
          user_auth_pubkey: userAuthPubkey,
          created_at: createdAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          nonce: `BCWISSUEREQ_${randomBytes(16).toString("hex")}`
        };

        return res.json({
          ok: true,
          stage: "bcw_krc20_issue_burn_intent",
          networkId,
          fromAddress,
          mode,
          ca,
          amt,
          toAddress,
          custody_model: "broker_1of1",
          intent,
          intent_message: canonicalBcwKrc20IssueBurnIntentMessage(intent)
        });
      }

      if (walletType === "standard") {
        const commitAmountSompi = kaspaToSompi("0.3");
        if (commitAmountSompi === undefined || commitAmountSompi <= 0n) {
          return res.status(500).json({ ok: false, reason: "invalid_commit_amount" });
        }

        const krc20IssueCommitCovenantExclusion = await applyKrc20IssueCommitCovenantExclusion({
          networkId,
          address: fromAddress,
          entries
        });
        const krc20IssueCommitEntries = krc20IssueCommitCovenantExclusion.entries;
        if (!krc20IssueCommitEntries.length && entries.length) {
          return res.status(409).json({
            ok: false,
            reason: "krc20_issue_commit_only_covenant_utxos",
            covenant_exclusion: krc20IssueCommitCovenantExclusion.exclusion,
            signing_enabled: false,
            broadcasting_enabled: false,
            minting_enabled: false
          });
        }

        const safeEntries = krc20IssueCommitEntries.map((e: any) => ({
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

        return res.json({
          ok: true,
          stage: "krc_commit_build",
          networkId,
          feeRate,
          fromAddress,
          commitAmountSompi: commitAmountSompi.toString(),
          payloadJson,
          revealPriorityFeeSompi: revealPriorityFeeSompi.toString(),
          timeoutMs,
          entries: safeEntries,
          covenant_exclusion: krc20IssueCommitCovenantExclusion.exclusion
        });
      }

      if (walletType === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_krc20_issue_burn_removed",
          error: "Legacy 2-of-2 Compliance Wallet issue/burn has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "issue_build_commit_exception", error: String(err) });
    }
  });

  app.post("/api/v1/krc20/issue/submit-commit", async (req: Request, res: Response) => {
    try {
      const base = await ensureAuthedActiveWalletOrReject(req, res);
      if (!base) return;

      const { walletType, walletNetwork, networkId, fromAddress, rpc } = base;

      const body = (base as any).body || {};
      const isBcwBrokerCustody = walletType === "compliance" && String((base as any).active.custody_model || "").trim() === "broker_1of1";

      if (isBcwBrokerCustody) {
        const active = (base as any).active || {};
        const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
        const mode = String((base as any).mode || "issue") === "burn" ? "burn" : "issue";
        const ca = String((base as any).ca || "").trim().toLowerCase();
        const amt = String((base as any).amt || "").trim();
        const toAddress = mode === "issue" ? String((base as any).to || "").trim() : "";
        const intent = normalizeBcwKrc20IssueBurnIntent((body as any).bcw_krc20_issue_burn_intent);
        const authSignature = typeof (body as any).bcw_auth_signature === "string" ? String((body as any).bcw_auth_signature).trim() : "";

        if (!brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_broker_custody_key_ref" });
        }
        if (!userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_missing_user_auth_pubkey" });
        }
        if (!intent) {
          return res.status(400).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_invalid" });
        }
        if (!authSignature) {
          return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required" });
        }

        if (intent.wallet_id !== String(active.id || "").trim()) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_wallet_mismatch" });
        }
        if (intent.wallet_type !== "compliance" || intent.custody_model !== "broker_1of1") {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_custody_mismatch" });
        }
        if (intent.network !== walletNetwork) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_network_mismatch" });
        }
        if (intent.broker_custody_key_ref !== brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_key_ref_mismatch" });
        }
        if (intent.from_address !== fromAddress) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_from_mismatch" });
        }
        if (intent.user_auth_pubkey !== userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_auth_pubkey_mismatch" });
        }
        if (intent.mode !== mode || intent.ca !== ca || intent.amt !== amt || intent.to_address !== toAddress) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_issue_burn_intent_payload_mismatch" });
        }

        const cn = await postBcwKrc20IssueBurnToCn({
          repoRoot: ctx.repoRoot,
          getAppConfig: ctx.getAppConfig,
          intent,
          authSignature
        });

        if (!cn.ok) {
          const errMsg = cn.data && (cn.data.error || cn.data.reason) ? String(cn.data.error || cn.data.reason) : "CN rejected";
          return res.status(cn.status || 502).json({
            ok: false,
            reason: "bcw_krc20_issue_burn_cn_rejected",
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
          return res.status(502).json({ ok: false, reason: "bcw_krc20_issue_burn_cn_missing_reveal_txid", cn: cnData });
        }

        return res.json({
          ok: true,
          stage: "bcw_krc20_issue_burn_submit",
          networkId,
          fromAddress,
          custody_model: "broker_1of1",
          mode,
          ca,
          amt,
          toAddress,
          txid: revealTxId,
          txids: revealTxids.length > 0 ? revealTxids : [revealTxId],
          commitTxids,
          revealTxids: revealTxids.length > 0 ? revealTxids : [revealTxId],
          payloadJson: typeof cnData.payloadJson === "string" ? cnData.payloadJson : String((base as any).payloadJson || ""),
          cn: cnData
        });
      }

      const signed = Array.isArray((body as any).signed_txs) ? (body as any).signed_txs : null;
      if (!signed || signed.length === 0) {
        return res.status(400).json({ ok: false, reason: "missing_signed_txs" });
      }

      if (walletType === "standard") {
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

        return res.json({
          ok: true,
          stage: "krc_commit_submit",
          networkId,
          fromAddress,
          txids,
          commitTxids: txids
        });
      }

      if (walletType === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_krc20_issue_burn_removed",
          error: "Legacy 2-of-2 Compliance Wallet issue/burn has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "issue_submit_commit_exception", error: String(err) });
    }
  });

  app.post("/api/v1/krc20/issue/wait-reveal", async (req: Request, res: Response) => {
    try {
      const base = await ensureAuthedActiveWalletOrReject(req, res);
      if (!base) return;

      const { walletType, walletNetwork, networkId, timeoutMs, fromAddress, rpc } = base;

      const body = (base as any).body || {};
      const expectedPrefix = kaspaAddressPrefixForRpcNetwork(networkId);
      const p2shAddress = typeof (body as any).p2shAddress === "string" ? String((body as any).p2shAddress).trim() : "";
      const commitTxidsRaw = Array.isArray((body as any).commitTxids) ? (body as any).commitTxids : [];
      const commitTxids = commitTxidsRaw
        .filter((x: any) => typeof x === "string" && x.trim())
        .map((x: any) => String(x).trim());

      if (!validP2shAddressForRpcNetwork(networkId, p2shAddress)) {
        return res.status(400).json({ ok: false, reason: "invalid_p2sh_address", error: "Invalid P2SH address" });
      }

      if (!p2shAddress.startsWith(expectedPrefix)) {
        return res.json({ ok: false, reason: "invalid_p2sh_network", error: `P2SH address must start with ${expectedPrefix}` });
      }

      if (commitTxids.length === 0) {
        return res.status(400).json({ ok: false, reason: "missing_commit_txids", error: "Missing commitTxids[]" });
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
        return res.status(409).json({ ok: false, reason: "commit_utxo_not_found", error: "Commit UTXO not found yet" });
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

      let revealEntries: any[] = [];
      if (walletType === "standard") {
        const u2 = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
        const list2 = u2 && Array.isArray((u2 as any).entries) ? (u2 as any).entries : [];
        revealEntries = list2.map((e: any) => ({
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
      }

      return res.json({
        ok: true,
        stage: "krc_reveal_wait",
        networkId,
        commitEntry,
        entries: revealEntries
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "issue_wait_reveal_exception", error: String(err) });
    }
  });

  app.post("/api/v1/krc20/issue/submit-reveal", async (req: Request, res: Response) => {
    try {
      const base = await ensureAuthedActiveWalletOrReject(req, res);
      if (!base) return;

      const { walletType, networkId, fromAddress, rpc } = base;

      const body = (base as any).body || {};
      const signed = Array.isArray((body as any).signed_txs) ? (body as any).signed_txs : null;
      if (!signed || signed.length === 0) {
        return res.status(400).json({ ok: false, reason: "missing_signed_txs" });
      }

      if (walletType === "standard") {
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

        return res.json({
          ok: true,
          stage: "krc_reveal_submit",
          networkId,
          fromAddress,
          txids,
          revealTxids: txids
        });
      }

      if (walletType === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_krc20_issue_burn_removed",
          error: "Legacy 2-of-2 Compliance Wallet issue/burn has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "issue_submit_reveal_exception", error: String(err) });
    }
  });
}
