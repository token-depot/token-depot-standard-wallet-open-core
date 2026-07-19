import type { Express, Request, Response } from "express";
import { randomBytes } from "crypto";
import { Transaction, kaspaToSompi, RpcClient as ToccataRpcClient } from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";
import { readWrappedConfigV7, writeWrappedConfigV7 } from "../storage/wrappedConfigStore";
import type { AppNetworkKey, RpcNetworkId, WalletNetworkType } from "../types";

export type Krc20ChownCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<any>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  getAppConfig: (repoRootPath: string) => any;
};

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

const KRC20_CHOWN_TN10_COVENANT_RPC_URL = "ws://tn10.token-depot.co:17210";

type Krc20ChownCommitCovenantExclusion = {
  inspection_kind: "krc20_chown_commit_covenant_exclusion_v1";
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

function krc20ChownPrintable(value: any): string | null {
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

function krc20ChownReferenceEntry(reference: any): any | null {
  return reference && typeof reference === "object" && reference.entry ? reference.entry : null;
}

function krc20ChownCovenantIdFromReference(reference: any): string | null {
  const entry = krc20ChownReferenceEntry(reference);
  const canonical = entry ? entry.covenantId : undefined;
  return canonical === null || canonical === undefined ? null : krc20ChownPrintable(canonical);
}

function krc20ChownOutpointKeyFromValue(outpoint: any): string {
  if (!outpoint) return "";
  if (typeof outpoint === "string") return outpoint;
  if (outpoint && typeof outpoint.toJSON === "function") return krc20ChownOutpointKeyFromValue(outpoint.toJSON());
  const transactionId = krc20ChownPrintable(outpoint.transactionId ?? outpoint.transaction_id ?? outpoint.txid);
  const rawIndex = outpoint.index ?? outpoint.outputIndex ?? outpoint.output_index;
  const index = rawIndex === null || rawIndex === undefined ? null : Number(rawIndex);
  return transactionId && Number.isFinite(index) ? `${transactionId}:${index}` : "";
}

function krc20ChownOutpointKeyFromReference(reference: any): string {
  const entry = krc20ChownReferenceEntry(reference);
  const candidates = [
    reference && reference.outpoint,
    entry && entry.outpoint,
    reference && reference.utxo && reference.utxo.outpoint,
    reference && reference.utxoEntry && reference.utxoEntry.outpoint
  ];

  for (const candidate of candidates) {
    const key = krc20ChownOutpointKeyFromValue(candidate);
    if (key) return key;
  }
  return "";
}

function krc20ChownEntriesFromResponse(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.entries)) return response.entries;
  if (response && Array.isArray(response.utxos)) return response.utxos;
  if (response && Array.isArray(response.result)) return response.result;
  return [];
}

async function applyKrc20ChownCommitCovenantExclusion(args: {
  networkId: RpcNetworkId;
  address: string;
  entries: any[];
}): Promise<{ entries: any[]; exclusion: Krc20ChownCommitCovenantExclusion }> {
  const totalEntries = Array.isArray(args.entries) ? args.entries.length : 0;
  const covenantOutpoints = new Set<string>();

  for (const entry of args.entries) {
    const covenantId = krc20ChownCovenantIdFromReference(entry);
    const key = covenantId ? krc20ChownOutpointKeyFromReference(entry) : "";
    if (key) covenantOutpoints.add(key);
  }

  if (args.networkId === "testnet-10") {
    let rpc: InstanceType<typeof ToccataRpcClient> | null = null;
    try {
      rpc = new ToccataRpcClient({ url: KRC20_CHOWN_TN10_COVENANT_RPC_URL, networkId: args.networkId });
      await rpc.connect();
      const response = await rpc.getUtxosByAddresses({ addresses: [args.address] });
      const toccataEntries = krc20ChownEntriesFromResponse(response);
      for (const entry of toccataEntries) {
        const covenantId = krc20ChownCovenantIdFromReference(entry);
        const key = covenantId ? krc20ChownOutpointKeyFromReference(entry) : "";
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
    const key = krc20ChownOutpointKeyFromReference(entry);
    return !key || !covenantOutpoints.has(key);
  });
  const excludedOutpoints = Array.from(covenantOutpoints).sort();

  return {
    entries: spendableEntries,
    exclusion: {
      inspection_kind: "krc20_chown_commit_covenant_exclusion_v1",
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

type BcwKrc20ChownIntentV1 = {
  v: 1;
  purpose: "bcw_krc20_chown";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "testnet" | "mainnet";
  broker_custody_key_ref: string;
  from_address: string;
  ca: string;
  to_address: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwChownRouteString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBcwChownRouteIso(value: unknown): string {
  const s = normalizeBcwChownRouteString(value);
  const ms = Date.parse(s);
  if (!s || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function normalizeBcwKrc20ChownIntent(raw: unknown): BcwKrc20ChownIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network = input.network === "testnet" || input.network === "mainnet" ? input.network : null;
  if (!network) return null;

  const intent: BcwKrc20ChownIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_krc20_chown" ? "bcw_krc20_chown" : "" as "bcw_krc20_chown",
    wallet_id: normalizeBcwChownRouteString(input.wallet_id),
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: normalizeBcwChownRouteString(input.broker_custody_key_ref),
    from_address: normalizeBcwChownRouteString(input.from_address),
    ca: normalizeBcwChownRouteString(input.ca).toLowerCase(),
    to_address: normalizeBcwChownRouteString(input.to_address),
    user_auth_pubkey: normalizeBcwChownRouteString(input.user_auth_pubkey),
    created_at: normalizeBcwChownRouteIso(input.created_at),
    expires_at: normalizeBcwChownRouteIso(input.expires_at),
    nonce: normalizeBcwChownRouteString(input.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_krc20_chown") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.to_address) return null;
  if (!/^[a-f0-9]{64}$/.test(intent.ca)) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;
  if (!/^BCWCHOWNREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;

  return intent;
}

function canonicalBcwKrc20ChownIntentMessage(intent: BcwKrc20ChownIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    ca: intent.ca,
    to_address: intent.to_address,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

async function postBcwKrc20ChownToCn(params: {
  repoRoot: string;
  getAppConfig: (repoRootPath: string) => any;
  intent: BcwKrc20ChownIntentV1;
  authSignature: string;
}): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = params.getAppConfig(params.repoRoot);
  const cnUrl = String(cfg && cfg.cn_url ? cfg.cn_url : "").trim().replace(/\/+$/, "");
  if (!cnUrl) return { ok: false, status: 500, data: { ok: false, reason: "cn_url_missing" } };

  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) return { ok: false, status: 500, data: { ok: false, reason: "td_admin_token_missing" } };

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") return { ok: false, status: 500, data: { ok: false, reason: "fetch_unavailable" } };

  const resp = await fetchFn(`${cnUrl}/api/cn/bcw/krc20/chown`, {
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

export function registerKrc20ChownRoutes(app: Express, ctx: Krc20ChownCtx): void {
  app.post("/api/v1/krc20/chown", async (req: Request, res: Response) => {
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
      const walletNetwork = walletNetworkTypeFor(appNetwork);
      const networkId = rpcNetworkIdFor(appNetwork);

      const body = req.body && typeof req.body === "object" ? (req.body as any) : {};
      const stage = typeof body.stage === "string" ? String(body.stage).trim() : "";
      const netReqRaw = String(body.netId || "").trim();
      const ca = String(body.ca || "").trim();
      const to = String(body.to || "").trim();

      if (!netReqRaw) {
        return res.status(400).json({ ok: false, reason: "net_required" });
      }
      if (!ca) {
        return res.status(400).json({ ok: false, reason: "ca_required" });
      }
      if (
        stage !== "chown_commit_build" &&
        stage !== "chown_commit_submit" &&
        stage !== "chown_reveal_wait" &&
        stage !== "chown_reveal_submit"
      ) {
        return res.status(400).json({
          ok: false,
          reason: "chown_stage_required",
          error: "stage required (chown_commit_build | chown_commit_submit | chown_reveal_wait | chown_reveal_submit)"
        });
      }

      const expectedPrefix = kaspaAddressPrefixForRpcNetwork(networkId);
      if (!to || !validKaspaAddrForRpcNetwork(networkId, to)) {
        return res.status(400).json({ ok: false, reason: "to_invalid", detail: `to must start with ${expectedPrefix}` });
      }

      const cfg = readWrappedConfigV7(ctx.repoRoot);
      const reqNetId = normalizeAppNetworkKey(netReqRaw);
      if (!reqNetId) {
        return res.status(400).json({ ok: false, reason: "net_invalid", netReqRaw });
      }
      const walletNetId: AppNetworkKey = appNetwork;
      if (reqNetId !== walletNetId) {
        return res.status(409).json({ ok: false, reason: "net_mismatch", walletNetId, reqNetId });
      }
      const netId: AppNetworkKey = reqNetId;

      const caKey = String(ca || "").trim().toLowerCase();
      const bucket = (cfg as any) && (cfg as any).issuance && (cfg as any).issuance.deployerByNetwork ? (cfg as any).issuance.deployerByNetwork[netId] : null;
      if (!bucket || typeof bucket !== "object") {
        return res.status(403).json({ ok: false, reason: "unknown_ca_deployer" });
      }

      const expectedDeployer = String((bucket as any)[caKey] || (bucket as any)[String(ca || "").trim()] || "").trim().toLowerCase();
      if (!expectedDeployer) {
        return res.status(403).json({ ok: false, reason: "unknown_ca_deployer" });
      }

      function tryApplyChownAutomation(netId0: AppNetworkKey, ca0: string, to0: string): { ok: boolean; reason?: string } {
        try {
          const caKey = String(ca0 || "").trim().toLowerCase();
          if (!caKey) return { ok: false, reason: "ca_missing" };

          const cfg0 = readWrappedConfigV7(ctx.repoRoot);
          const next = JSON.parse(JSON.stringify(cfg0 || {}));

          next.issuance = next.issuance || {};
          next.issuance.deployerByNetwork = next.issuance.deployerByNetwork || {};
          next.issuance.deployerByNetwork[netId0] = next.issuance.deployerByNetwork[netId0] || {};
          next.issuance.deployerByNetwork[netId0][caKey] = String(to0 || "").trim();

          const controlled0 =
            next.controlledAssetsByNetwork &&
            next.controlledAssetsByNetwork[netId0] &&
            (next.controlledAssetsByNetwork[netId0][caKey] || next.controlledAssetsByNetwork[netId0][String(ca0 || "").trim().toLowerCase()]);

          const nm = controlled0 && typeof controlled0 === "object"
            ? String(controlled0.name || controlled0.assetRef || "").trim()
            : "";

          if (nm) {
            next.issuance = next.issuance || {};
            next.issuance.metaByNetwork = next.issuance.metaByNetwork || {};
            next.issuance.metaByNetwork[netId0] = next.issuance.metaByNetwork[netId0] || {};
            const cur = next.issuance.metaByNetwork[netId0][caKey];
            if (!cur || typeof cur !== "object" || !String(cur.name || "").trim()) {
              next.issuance.metaByNetwork[netId0][caKey] = { name: nm };
            }
          }

          writeWrappedConfigV7(ctx.repoRoot, next);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, reason: e?.message || String(e) };
        }
      }

      const action = {
        p: "krc-20",
        op: "chown",
        ca,
        to
      };

      const payloadJson = JSON.stringify(action);

      const cfgApp = ctx.getAppConfig(ctx.repoRoot);
      const feeRateMin = Number(cfgApp && cfgApp.fee_rate_min ? cfgApp.fee_rate_min : 1);
      const feeRate = Number.isFinite(feeRateMin) && feeRateMin > 0 ? feeRateMin : 1;

      const timeoutMs = 120_000;

      const revealPriorityFeeSompi = kaspaToSompi("1");
      if (revealPriorityFeeSompi === undefined || revealPriorityFeeSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "chown_priority_fee_parse_failed" });
      }

      const fromAddress = String(active.address0 || "").trim();
      if (!fromAddress) {
        return res.status(500).json({ ok: false, reason: "wallet_missing_address0" });
      }

      if (expectedDeployer !== String(fromAddress || "").trim().toLowerCase()) {
        return res.status(403).json({ ok: false, reason: "issuer_mismatch" });
      }

      const isBcwBrokerCustody =
        walletType === "compliance" &&
        String(active.custody_model || "").trim() === "broker_1of1";

      if (isBcwBrokerCustody) {
        if (stage !== "chown_commit_build" && stage !== "chown_commit_submit") {
          return res.status(400).json({ ok: false, reason: "bcw_krc20_chown_stage_invalid" });
        }

        const walletId = String(active.id || "").trim();
        const brokerCustodyKeyRef = String(active.broker_custody_key_ref || "").trim();
        const userAuthPubkey = String(active.user_auth_pubkey || "").trim();

        if (!walletId) {
          return res.status(409).json({ ok: false, reason: "wallet_id_missing" });
        }
        if (!brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_broker_custody_key_ref_missing" });
        }
        if (!userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_user_auth_pubkey_missing" });
        }

        if (stage === "chown_commit_build") {
          const now = new Date();
          const expires = new Date(now.getTime() + 10 * 60 * 1000);
          const intent: BcwKrc20ChownIntentV1 = {
            v: 1,
            purpose: "bcw_krc20_chown",
            wallet_id: walletId,
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: walletNetwork,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: fromAddress,
            ca: caKey,
            to_address: to,
            user_auth_pubkey: userAuthPubkey,
            created_at: now.toISOString(),
            expires_at: expires.toISOString(),
            nonce: `BCWCHOWNREQ_${randomBytes(16).toString("hex")}`
          };

          return res.json({
            ok: true,
            stage: "bcw_krc20_chown_intent",
            networkId,
            fromAddress,
            ca: caKey,
            toAddress: to,
            custody_model: "broker_1of1",
            intent,
            intent_message: canonicalBcwKrc20ChownIntentMessage(intent)
          });
        }

        const submittedIntent = normalizeBcwKrc20ChownIntent((body as any).bcw_krc20_chown_intent);
        const authSignature =
          typeof (body as any).bcw_auth_signature === "string"
            ? String((body as any).bcw_auth_signature).trim()
            : "";

        if (!submittedIntent) {
          return res.status(400).json({ ok: false, reason: "bcw_krc20_chown_intent_invalid" });
        }
        if (!authSignature) {
          return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required" });
        }
        if (submittedIntent.wallet_id !== walletId) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_wallet_id_mismatch" });
        }
        if (submittedIntent.wallet_type !== "compliance") {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_wallet_type_mismatch" });
        }
        if (submittedIntent.custody_model !== "broker_1of1") {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_custody_model_mismatch" });
        }
        if (submittedIntent.network !== walletNetwork) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_network_mismatch" });
        }
        if (submittedIntent.broker_custody_key_ref !== brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_key_ref_mismatch" });
        }
        if (submittedIntent.from_address !== fromAddress) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_from_address_mismatch" });
        }
        if (submittedIntent.ca !== caKey) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_ca_mismatch" });
        }
        if (submittedIntent.to_address !== to) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_to_address_mismatch" });
        }
        if (submittedIntent.user_auth_pubkey !== userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_krc20_chown_auth_pubkey_mismatch" });
        }

        const cn = await postBcwKrc20ChownToCn({
          repoRoot: ctx.repoRoot,
          getAppConfig: ctx.getAppConfig,
          intent: submittedIntent,
          authSignature
        });

        if (!cn.ok) {
          const errMsg = cn.data && (cn.data.error || cn.data.reason) ? String(cn.data.error || cn.data.reason) : "bcw_krc20_chown_cn_rejected";
          return res.status(cn.status || 502).json({ ok: false, reason: "bcw_krc20_chown_cn_rejected", error: errMsg, cn: cn.data });
        }

        const txids = Array.isArray(cn.data && cn.data.revealTxids)
          ? cn.data.revealTxids.map((x: any) => String(x || "").trim()).filter(Boolean)
          : [];

        if (txids.length === 0) {
          return res.status(502).json({ ok: false, reason: "bcw_krc20_chown_missing_reveal_txid", cn: cn.data });
        }

        const configUpdate = tryApplyChownAutomation(netId, caKey, to);
        return res.json({
          ok: true,
          stage: "bcw_krc20_chown_submit",
          custody_model: "broker_1of1",
          revealTxids: txids,
          txid: typeof cn.data.txid === "string" ? cn.data.txid : txids[0],
          txids,
          cn: cn.data,
          configUpdate
        });
      }

      const rpc = await ctx.getSharedRpc(networkId);

      if (walletType !== "standard" && walletType !== "compliance") {
        return res.status(500).json({ ok: false, reason: "wallet_type_invalid" });
      }

      if (walletType === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_krc20_chown_removed",
          error: "Legacy 2-of-2 Compliance Wallet chown has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }

      const baseCommitSompi = kaspaToSompi("0.3");
      if (baseCommitSompi === undefined || baseCommitSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "chown_commit_amount_parse_failed" });
      }

      const commitAmountSompi = baseCommitSompi;

      const safeEntriesFrom = (entries: any[]) => (entries || []).map((e: any) => ({
        outpoint: e && e.outpoint && typeof e.outpoint.toJSON === "function" ? e.outpoint.toJSON() : (e ? e.outpoint : null),
        amount: e && typeof e.amount === "bigint" ? e.amount.toString() : String(e && e.amount !== undefined ? e.amount : ""),
        scriptPublicKey: e && e.scriptPublicKey && typeof e.scriptPublicKey.toJSON === "function" ? e.scriptPublicKey.toJSON() : (e ? e.scriptPublicKey : null),
        blockDaaScore: e && typeof e.blockDaaScore === "bigint" ? e.blockDaaScore.toString() : String(e && e.blockDaaScore !== undefined ? e.blockDaaScore : ""),
        isCoinbase: !!(e && e.isCoinbase)
      }));

      const sleepMs = async (ms: number) => await new Promise((r) => setTimeout(r, ms));

      if (stage === "chown_commit_build") {
        const utxos = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
        const entries = utxos && Array.isArray((utxos as any).entries) ? (utxos as any).entries : [];
        if (!entries || entries.length === 0) {
          return res.json({ ok: false, reason: "no_utxos", error: "No UTXOs available (fund the wallet first)" });
        }

        const krc20ChownCommitCovenantExclusion = await applyKrc20ChownCommitCovenantExclusion({
          networkId,
          address: fromAddress,
          entries
        });
        const krc20ChownCommitEntries = krc20ChownCommitCovenantExclusion.entries;
        if (!krc20ChownCommitEntries.length && entries.length) {
          return res.status(409).json({
            ok: false,
            reason: "krc20_chown_commit_only_covenant_utxos",
            covenant_exclusion: krc20ChownCommitCovenantExclusion.exclusion,
            signing_enabled: false,
            broadcasting_enabled: false,
            minting_enabled: false
          });
        }

        return res.json({
          ok: true,
          stage: "chown_commit_build",
          networkId,
          feeRate,
          fromAddress,
          changeAddress: fromAddress,
          commitAmountSompi: commitAmountSompi.toString(),
          payloadJson,
          entries: safeEntriesFrom(krc20ChownCommitEntries),
          revealPriorityFeeSompi: revealPriorityFeeSompi.toString(),
          covenant_exclusion: krc20ChownCommitCovenantExclusion.exclusion
        });
      }

      const signed = Array.isArray((body as any).signed_txs) ? (body as any).signed_txs : null;

      if (stage === "chown_commit_submit" || stage === "chown_reveal_submit") {
        if (!signed || signed.length === 0) {
          return res.status(400).json({ ok: false, reason: "missing_signed_txs" });
        }
      }

      if (stage === "chown_commit_submit") {
        const txids: string[] = [];
        for (const txSafe of signed || []) {
          if (typeof txSafe !== "string" || !txSafe.trim()) continue;
          const tx = Transaction.deserializeFromSafeJSON(txSafe);
          const r = await rpc.submitTransaction({ transaction: tx });
          txids.push(r.transactionId);
        }
        if (txids.length === 0) return res.status(400).json({ ok: false, reason: "no_valid_txs" });
        return res.json({ ok: true, stage: "chown_commit_submit", commitTxids: txids });
      }

      if (stage === "chown_reveal_wait") {
        const p2shAddress = typeof (body as any).p2shAddress === "string" ? String((body as any).p2shAddress).trim() : "";
        const commitTxids = Array.isArray((body as any).commitTxids) ? (body as any).commitTxids : null;

        if (!p2shAddress) return res.status(400).json({ ok: false, reason: "missing_p2shAddress" });
        if (!commitTxids || commitTxids.length === 0) return res.status(400).json({ ok: false, reason: "missing_commitTxids" });

        const wanted = new Set(commitTxids.map((t: any) => String(t || "").trim()).filter(Boolean));
        if (wanted.size === 0) return res.status(400).json({ ok: false, reason: "missing_commitTxids" });

        const startMs = Date.now();
        const deadlineMs = startMs + Math.max(10_000, Math.min(600_000, timeoutMs));

        while (Date.now() < deadlineMs) {
          let commitEntry: any = null;
          try {
            const p2sh = await rpc.getUtxosByAddresses({ addresses: [p2shAddress] });
            const list = p2sh && Array.isArray((p2sh as any).entries) ? (p2sh as any).entries : [];
            if (list.length > 0) {
              const match = list.find((e: any) => {
                const tid = e && e.outpoint ? e.outpoint.transactionId : "";
                return tid && wanted.has(tid);
              });
              commitEntry = match || null;
            }
          } catch {
            commitEntry = null;
          }

          if (!commitEntry) {
            await sleepMs(500);
            continue;
          }

          const ceSafe = safeEntriesFrom([commitEntry])[0];

          const ownerUtxos2 = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
          const ownerEntries2 = ownerUtxos2 && Array.isArray((ownerUtxos2 as any).entries) ? (ownerUtxos2 as any).entries : [];

          return res.json({
            ok: true,
            stage: "chown_reveal_wait",
            networkId,
            feeRate,
            fromAddress,
            commitEntry: ceSafe,
            entries: safeEntriesFrom(ownerEntries2),
            revealPriorityFeeSompi: revealPriorityFeeSompi.toString()
          });
        }

        return res.status(408).json({ ok: false, reason: "reveal_timeout" });
      }

      if (stage === "chown_reveal_submit") {
        if (!signed || signed.length === 0) return res.status(400).json({ ok: false, reason: "missing_signed_txs" });

        const txids: string[] = [];
        for (const txSafe of signed || []) {
          if (typeof txSafe !== "string" || !txSafe.trim()) continue;
          const tx = Transaction.deserializeFromSafeJSON(txSafe);
          const r = await rpc.submitTransaction({ transaction: tx });
          txids.push(r.transactionId);
        }
        if (txids.length === 0) return res.status(400).json({ ok: false, reason: "no_valid_txs" });

        const configUpdate = tryApplyChownAutomation(netId, ca, to);
        return res.json({ ok: true, stage: "chown_reveal_submit", revealTxids: txids, configUpdate });
      }

      return res.status(400).json({ ok: false, reason: "unknown_stage" });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "chown_exception", error: String(err) });
    }
  });
}
