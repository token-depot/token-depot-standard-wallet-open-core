import { randomBytes } from "crypto";
import type { Request, Response } from "express";
import type { RpcNetworkId } from "../types";

// NOTE: wasm import path is one level deeper than server.ts (routes/ => ../../../)
import {
  RpcClient,
  createTransactions,
  kaspaToSompi,
  ScriptBuilder,
  Opcodes,
  payToScriptHashScript,
  payToAddressScript,
  addressFromScriptPublicKey,
  FeeSource,
  calculateTransactionFee,
  calculateTransactionMass,
  updateTransactionMass,
  maximumStandardTransactionMass,
  createInputSignature,
  Transaction,
  PSKB,
  PSKT,
  SighashType
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

import { readBridgeQueueStore, updateBridgePurchase } from "../storage/bridgeQueueStore";
import { readUserProfile } from "../storage/userStore";
import { sendNotificationEmail } from "../email/smtp";
import {
  addressPrefixFromAppNetworkKey,
  appNetworkKeyFromWalletNetwork,
  kasplexBaseUrlFromAppNetworkKey,
  normalizeAppNetworkKey,
  rpcNetworkIdFromAppNetworkKey
} from "../networks";
import {
  getBridgeFulfillmentResultArtifact,
  upsertBridgeFulfillmentResultArtifact
} from "../storage/bridgeFulfillmentResultStore";

function normalizeExecutionGuardHex(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

function claimPreparedBridgePurchaseExecution(params: {
  repoRoot: string;
  active: any;
  stage: string;
  caHex: string;
  to: string;
  amountRaw: string;
  body: any;
}): { ok: true } | { ok: false; status: number; reason: string; error: string } {
  const stage = String(params.stage || "").trim();
  if (stage !== "krc_commit_build") return { ok: true };

  const purchaseId = String(params.body && params.body.purchaseId ? params.body.purchaseId : "").trim();
  const fulfillmentBatchId = normalizeExecutionGuardHex(params.body && params.body.fulfillmentBatchId);
  const fulfillmentExecutionNonce = normalizeExecutionGuardHex(params.body && params.body.fulfillmentExecutionNonce);

  if (!purchaseId && !fulfillmentBatchId && !fulfillmentExecutionNonce) return { ok: true };
  if (!purchaseId || !fulfillmentBatchId || !fulfillmentExecutionNonce) {
    return {
      ok: false,
      status: 400,
      reason: "bridge_purchase_execution_guard_missing",
      error: "Execution guard fields required"
    };
  }

  const store = readBridgeQueueStore(params.repoRoot);
  const row =
    store && Array.isArray(store.purchases)
      ? store.purchases.find((it: any) => it && it.id === purchaseId) || null
      : null;

  if (!row) {
    return {
      ok: false,
      status: 404,
      reason: "bridge_purchase_execution_purchase_not_found",
      error: "Prepared purchase not found"
    };
  }

  const status = String((row as any).status || "").trim().toLowerCase();
  if (status !== "fulfillment_prepared") {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_not_prepared",
      error: "Purchase is not in fulfillment_prepared state"
    };
  }

  const expectedNetworkId = params.active ? appNetworkKeyFromWalletNetwork(params.active.network) : "tn10";
  const rowNetworkId = String((row as any).networkId || "").trim().toLowerCase();
  if (rowNetworkId !== expectedNetworkId) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_network_mismatch",
      error: "Prepared purchase network mismatch"
    };
  }

  const rowCa = String((row as any).ca || "").trim().toLowerCase();
  if (rowCa !== params.caHex) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_ca_mismatch",
      error: "Prepared purchase CA mismatch"
    };
  }

  const activeAddress0 = String(params.active && params.active.address0 ? params.active.address0 : "").trim();
  const rowSourceWallet = String((row as any).fulfillSourceKaspaAddressSnapshot || "").trim();
  if (!rowSourceWallet || rowSourceWallet !== activeAddress0) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_source_wallet_mismatch",
      error: "Prepared purchase source wallet mismatch"
    };
  }

  const rowTo = String((row as any).userKrcReceiveAddress || "").trim();
  if (rowTo !== params.to) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_destination_mismatch",
      error: "Prepared purchase destination mismatch"
    };
  }

  const rowAmountRaw = String((row as any).settlementWrappedAmountRaw || "").trim();
  if (rowAmountRaw !== params.amountRaw) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_amount_mismatch",
      error: "Prepared purchase amount mismatch"
    };
  }

  const rowBatchId = normalizeExecutionGuardHex((row as any).fulfillmentBatchId);
  if (rowBatchId !== fulfillmentBatchId) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_batch_mismatch",
      error: "Prepared purchase batch mismatch"
    };
  }

  const rowExecutionNonce = normalizeExecutionGuardHex((row as any).fulfillmentExecutionNonce);
  if (rowExecutionNonce !== fulfillmentExecutionNonce) {
    return {
      ok: false,
      status: 409,
      reason: "bridge_purchase_execution_nonce_mismatch",
      error: "Prepared purchase execution nonce mismatch"
    };
  }

  updateBridgePurchase(params.repoRoot, purchaseId, {
    status: "fulfillment_executing"
  });

  return { ok: true };
}

function normalizeWalletWhitelistAddress(raw: unknown): string {
  return String(raw || "").trim().toLowerCase();
}

type BcwKasSendIntentV1 = {
  v: 1;
  purpose: "bcw_kas_send";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "testnet" | "mainnet";
  broker_custody_key_ref: string;
  from_address: string;
  to_address: string;
  amount_sompi: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwRouteString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBcwRouteIso(value: unknown): string {
  const s = normalizeBcwRouteString(value);
  const ms = Date.parse(s);
  if (!s || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function normalizeBcwKasSendIntent(raw: unknown): BcwKasSendIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network =
    input.network === "testnet" || input.network === "mainnet"
      ? input.network
      : null;
  if (!network) return null;

  const intent: BcwKasSendIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_kas_send" ? "bcw_kas_send" : "" as "bcw_kas_send",
    wallet_id: normalizeBcwRouteString(input.wallet_id),
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: normalizeBcwRouteString(input.broker_custody_key_ref),
    from_address: normalizeBcwRouteString(input.from_address),
    to_address: normalizeBcwRouteString(input.to_address),
    amount_sompi: normalizeBcwRouteString(input.amount_sompi),
    user_auth_pubkey: normalizeBcwRouteString(input.user_auth_pubkey),
    created_at: normalizeBcwRouteIso(input.created_at),
    expires_at: normalizeBcwRouteIso(input.expires_at),
    nonce: normalizeBcwRouteString(input.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_kas_send") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.to_address) return null;
  if (!intent.amount_sompi || !/^[0-9]+$/.test(intent.amount_sompi)) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;

  return intent;
}

function canonicalBcwKasSendIntentMessage(intent: BcwKasSendIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    to_address: intent.to_address,
    amount_sompi: intent.amount_sompi,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

async function postBcwKasSendToCn(params: {
  repoRoot: string;
  getAppConfig: (repoRootPath: string) => any;
  intent: BcwKasSendIntentV1;
  authSignature: string;
}): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = params.getAppConfig(params.repoRoot);
  const cnUrl = String(cfg && cfg.cn_url ? cfg.cn_url : "").trim().replace(/\/+$/, "");
  if (!cnUrl) return { ok: false, status: 500, data: { ok: false, reason: "cn_url_missing" } };

  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) return { ok: false, status: 500, data: { ok: false, reason: "td_admin_token_missing" } };

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") return { ok: false, status: 500, data: { ok: false, reason: "fetch_unavailable" } };

  const resp = await fetchFn(`${cnUrl}/api/cn/bcw/kas/send`, {
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

type BcwKrc20TokenKind = "ca" | "tick";

type BcwKrc20TransferIntentV1 = {
  v: 1;
  purpose: "bcw_krc20_transfer";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "testnet" | "mainnet";
  broker_custody_key_ref: string;
  from_address: string;
  to_address: string;
  token_kind: BcwKrc20TokenKind;
  ca: string;
  tick: string;
  amount_raw: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwKrc20TokenKind(value: unknown): BcwKrc20TokenKind | null {
  return value === "ca" || value === "tick" ? value : null;
}

function normalizeBcwKrc20TransferIntent(raw: unknown): BcwKrc20TransferIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network =
    input.network === "testnet" || input.network === "mainnet"
      ? input.network
      : null;
  const tokenKind = normalizeBcwKrc20TokenKind(input.token_kind);
  if (!network || !tokenKind) return null;

  const intent: BcwKrc20TransferIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_krc20_transfer" ? "bcw_krc20_transfer" : "" as "bcw_krc20_transfer",
    wallet_id: normalizeBcwRouteString(input.wallet_id),
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: normalizeBcwRouteString(input.broker_custody_key_ref),
    from_address: normalizeBcwRouteString(input.from_address),
    to_address: normalizeBcwRouteString(input.to_address),
    token_kind: tokenKind,
    ca: normalizeBcwRouteString(input.ca).toLowerCase(),
    tick: normalizeBcwRouteString(input.tick).toUpperCase(),
    amount_raw: normalizeBcwRouteString(input.amount_raw),
    user_auth_pubkey: normalizeBcwRouteString(input.user_auth_pubkey),
    created_at: normalizeBcwRouteIso(input.created_at),
    expires_at: normalizeBcwRouteIso(input.expires_at),
    nonce: normalizeBcwRouteString(input.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_krc20_transfer") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.to_address) return null;
  if (!intent.amount_raw || !/^[0-9]+$/.test(intent.amount_raw)) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;

  if (intent.token_kind === "ca") {
    if (!/^[0-9a-f]{64}$/.test(intent.ca)) return null;
    if (intent.tick) return null;
  } else {
    if (!/^[A-Z0-9]{1,16}$/.test(intent.tick)) return null;
    if (intent.ca) return null;
  }

  return intent;
}

function canonicalBcwKrc20TransferIntentMessage(intent: BcwKrc20TransferIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    to_address: intent.to_address,
    token_kind: intent.token_kind,
    ca: intent.ca,
    tick: intent.tick,
    amount_raw: intent.amount_raw,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

async function postBcwKrc20TransferToCn(params: {
  repoRoot: string;
  getAppConfig: (repoRootPath: string) => any;
  intent: BcwKrc20TransferIntentV1;
  authSignature: string;
}): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = params.getAppConfig(params.repoRoot);
  const cnUrl = String(cfg && cfg.cn_url ? cfg.cn_url : "").trim().replace(/\/+$/, "");
  if (!cnUrl) return { ok: false, status: 500, data: { ok: false, reason: "cn_url_missing" } };

  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) return { ok: false, status: 500, data: { ok: false, reason: "td_admin_token_missing" } };

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") return { ok: false, status: 500, data: { ok: false, reason: "fetch_unavailable" } };

  const resp = await fetchFn(`${cnUrl}/api/cn/bcw/krc20/transfer`, {
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

function entrySelectionKeyFromOutpoint(outpoint: any): string {
  const txid =
    outpoint && typeof outpoint.transactionId === "string"
      ? String(outpoint.transactionId).trim().toLowerCase()
      : "";
  const indexValue =
    outpoint && (typeof outpoint.index === "number" || typeof outpoint.index === "string")
      ? Number(outpoint.index)
      : NaN;

  if (!/^[0-9a-f]{64}$/.test(txid)) return "";
  if (!Number.isInteger(indexValue) || indexValue < 0) return "";
  return `${txid}:${indexValue}`;
}

function normalizeSelectedEntryKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const v of raw) {
    const s = String(v || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}:\d+$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }

  return out;
}

function walletWhitelistGateForSend(params: {
  active: any;
  to: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: string; error: string } {
  const whitelist =
    params.active &&
    params.active.whitelist &&
    params.active.whitelist.by_network
      ? params.active.whitelist.by_network
      : null;

  const bucketEntries =
    params.active && params.active.network === "mainnet"
      ? whitelist && whitelist.mainnet && Array.isArray(whitelist.mainnet.entries)
        ? whitelist.mainnet.entries
        : []
      : whitelist && whitelist.testnet && Array.isArray(whitelist.testnet.entries)
        ? whitelist.testnet.entries
        : [];

  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now();

  const maturityMs = 24 * 60 * 60 * 1000;
  const normalizedTo = normalizeWalletWhitelistAddress(params.to);

  const currentRows = bucketEntries
    .filter((row: any) => row && normalizeWalletWhitelistAddress(row.address))
    .filter((row: any) => {
      const removedAt = String(row.removed_at || "").trim();
      if (!removedAt) return true;

      const removedMs = Date.parse(removedAt);
      if (!Number.isFinite(removedMs)) return true;

      return nowMs - removedMs < maturityMs;
    });

  if (currentRows.length < 1) {
    return { ok: true };
  }

  const allowedRows = currentRows.filter((row: any) => {
    const addedAt = String(row.added_at || "").trim();
    const addedMs = Date.parse(addedAt);
    if (!Number.isFinite(addedMs)) return false;

    return nowMs - addedMs >= maturityMs;
  });

  if (allowedRows.some((row: any) => normalizeWalletWhitelistAddress(row.address) === normalizedTo)) {
    return { ok: true };
  }

  if (allowedRows.length < 1) {
    return {
      ok: false,
      reason: "wallet_whitelist_pending_maturity",
      error: "Whitelist is active, but no listed address has matured for 24 hours yet."
    };
  }

  return {
    ok: false,
    reason: "wallet_whitelist_destination_not_allowed",
    error: "Destination is not allowed by the active wallet whitelist."
  };
}

function queueFundsSentNotification(params: {
  repoRoot: string;
  userId: string;
  active: any;
  networkId: string;
  to: string;
  asset: string;
  amountRaw: string;
  txid: string;
}): void {
  try {
    const profile = readUserProfile(params.repoRoot, params.userId);
    const destination =
      typeof profile.notification_destination === "string"
        ? profile.notification_destination.trim()
        : "";

    if (!destination) return;
    if (!profile.notifications || profile.notifications.funds_sent !== true) return;

    void sendNotificationEmail({
      to: destination,
      subject: "Token Depot — Funds sent",
      text: [
        "Funds were sent.",
        "",
        `Wallet ID: ${String(params.active && params.active.id ? params.active.id : "").trim()}`,
        `Network: ${String(params.networkId || "").trim()}`,
        `From: ${String(params.active && params.active.address0 ? params.active.address0 : "").trim()}`,
        `To: ${String(params.to || "").trim()}`,
        `Asset: ${String(params.asset || "").trim()}`,
        `Amount (RAW): ${String(params.amountRaw || "").trim()}`,
        `Txid: ${String(params.txid || "").trim()}`
      ].join("\n")
    }).catch(() => {});
  } catch {
    return;
  }
}

function persistPreparedBridgePurchaseExecutionResult(params: {
  repoRoot: string;
  active: any;
  stage: string;
  tokenId: string;
  caHex: string;
  body: any;
  txid: string;
}): void {
  const stage = String(params.stage || "").trim();
  if (stage !== "krc_reveal_submit") return;

  const purchaseId = String(params.body && params.body.purchaseId ? params.body.purchaseId : "").trim();
  const fulfillmentBatchId = normalizeExecutionGuardHex(params.body && params.body.fulfillmentBatchId);
  const fulfillmentExecutionNonce = normalizeExecutionGuardHex(params.body && params.body.fulfillmentExecutionNonce);
  const txid = String(params.txid || "").trim();

  if (!purchaseId || !fulfillmentBatchId || !fulfillmentExecutionNonce || !txid) return;

  const store = readBridgeQueueStore(params.repoRoot);
  const row =
    store && Array.isArray(store.purchases)
      ? store.purchases.find((it: any) => it && it.id === purchaseId) || null
      : null;

  if (!row) return;

  const networkId = params.active ? appNetworkKeyFromWalletNetwork(params.active.network) : "tn10";
  const sourceWalletAddress = String(params.active && params.active.address0 ? params.active.address0 : "").trim();
  const to = String((row as any).userKrcReceiveAddress || "").trim();
  const amountRaw = String((row as any).settlementWrappedAmountRaw || "").trim();
  const ca = String((row as any).ca || params.caHex || "").trim().toLowerCase();

  if (!sourceWalletAddress || !to || !amountRaw || !ca) return;

  const current = getBridgeFulfillmentResultArtifact(params.repoRoot, fulfillmentBatchId);
  const currentRows = current && Array.isArray(current.rows) ? current.rows : [];
  const rows = currentRows.filter((it) => String(it && it.purchaseId ? it.purchaseId : "").trim() !== purchaseId);

  rows.push({
    purchaseId,
    to,
    amountRaw,
    fulfillmentExecutionNonce,
    result: "Submitted",
    txid,
    error: ""
  });

  const assetName =
    current && typeof current.assetName === "string" && current.assetName.trim()
      ? current.assetName.trim()
      : (/^CA:/i.test(String(params.tokenId || "").trim()) ? undefined : String(params.tokenId || "").trim() || undefined);

  upsertBridgeFulfillmentResultArtifact(params.repoRoot, {
    version: 1,
    kind: "bridge_fulfillment_result",
    networkId,
    sourceWalletAddress,
    assetName,
    ca,
    fulfillmentBatchId,
    executedAt: new Date().toISOString(),
    executionRule: "stop_on_first_failure",
    rows
  });
}

export type WalletSendCtx = {
  // Core environment / wiring
  repoRoot: string;
  HOST: string;
  PORT: number;

  // Functions pulled from server.ts scope (passed in to avoid circular imports)
  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<RpcClient>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  readOffersStore: (repoRootPath: string) => any;
  writeOffersStore: (repoRootPath: string, store: any) => void;

  // Helpers referenced by name inside the handler
  decodePskbPayloadArray: (pskb: string) => any[];
  diagPushOnlyScriptHex: (tag: string, scriptHex: any) => void;
  disasmPushOnlyScriptHex: (scriptHex: string) =>
    | { ok: true; pushes: Array<{ op: number; len: number; dataHex: string }> }
    | { ok: false; error: string };

  normalizeSignaturePayload65OrThrow: (signatureScriptHex: string) => string;

  pickFirstHexField: (obj: any, keys: string[]) => string;

  krc20CommitRevealTransfer: (params: {
    rpc: RpcClient;
    networkId: string;
    feeRate: number;
    fromAddress: string;
    priv0: any;
    payloadJson: string;
  }) => Promise<{ commitTxids: string[]; revealTxids: string[] }>;

  safeLowerHex: (s: any) => string;

  isPositiveAmountString: (s: string) => boolean;

  getAppConfig: (repoRootPath: string) => any;
  cnFeePolicyForNetwork: (cfg: any, networkId: RpcNetworkId) => any;
  maxSendableSompiForFeePolicy: (maxSompi: bigint, policy: any) => bigint;
};

export async function handleWalletSend(req: Request, res: Response, ctx: WalletSendCtx): Promise<any> {
  // Bind server.ts-scope dependencies into local names so the pasted body remains unchanged.
  const {
    repoRoot,
    HOST,
    PORT,
    ensureKaspaReady,
    getSharedRpc,
    readWalletStore,
    readOffersStore,
    writeOffersStore,
    decodePskbPayloadArray,
    diagPushOnlyScriptHex,
    disasmPushOnlyScriptHex,
    normalizeSignaturePayload65OrThrow,
    pickFirstHexField,
    krc20CommitRevealTransfer,
    safeLowerHex,
    isPositiveAmountString,
    getAppConfig,
    cnFeePolicyForNetwork,
    maxSendableSompiForFeePolicy
  } = ctx;

  // PASTE HERE:
  // Copy the entire original route BODY from server.ts:
  //   starting at:   let rpc: RpcClient | null = null;
  //   ending at:     } finally { ... }   (just before the closing "});")
  //
  // Do NOT include the outer:
  //   app.post("/api/wallet/send", async (req, res) => {
  // and do NOT include the final:
  //   });
  let rpc: RpcClient | null = null;

  // DIAG: capture last submit txid + summary so catch() can compare with remote rejection
  let diag_last_submit_txid = "";
  let diag_last_submit_summary = "";

  try {
    await ensureKaspaReady(repoRoot);

    const body: any = (req as any).body ?? {};

    const mode = typeof body.mode === "string" ? body.mode.trim() : "";
    if (mode === "krc20_pskt_swap") {
      let stage = "swap_mode_start";

      try {
        const fetchFn: any = (globalThis as any).fetch;
        if (typeof fetchFn !== "function") {
          return res.status(500).json({ ok: false, reason: "swap_mode_fetch_unavailable", stage });
        }

        const psktRequest: any = body.psktRequest && typeof body.psktRequest === "object" ? body.psktRequest : null;
        const sendContext: any = body.sendContext && typeof body.sendContext === "object" ? body.sendContext : null;
        const password = typeof body.password === "string" ? body.password : "";

        const swapStage = typeof body.swapStage === "string" ? body.swapStage.trim() : "";
        const acceptRid = typeof body.acceptRid === "string" ? body.acceptRid.trim() : "";
        const takerInputSigs = Array.isArray(body.takerInputSigs) ? body.takerInputSigs : null;
        const takerResignInputSigs = Array.isArray(body.takerResignInputSigs) ? body.takerResignInputSigs : null;
        const bcwDirectSwapFinalizeIntent =
          body.bcw_direct_swap_finalize_intent && typeof body.bcw_direct_swap_finalize_intent === "object"
            ? body.bcw_direct_swap_finalize_intent
            : null;
        const bcwAuthSignature = typeof body.bcw_auth_signature === "string" ? body.bcw_auth_signature.trim() : "";

        if (!psktRequest || !sendContext) {
          return res.status(400).json({ ok: false, reason: "swap_mode_missing_preview", stage });
        }

        const offerId = typeof psktRequest.offerId === "string" ? psktRequest.offerId.trim() : "";
        if (!offerId) {
          return res.status(400).json({ ok: false, reason: "swap_mode_missing_offerId", stage });
        }

        stage = "swap_mode_load_offer";
        const storeO = readOffersStore(repoRoot);
        const offer: any = storeO.items.find((o: any) => o && o.offerId === offerId) ?? null;
        if (!offer) {
          return res.status(404).json({ ok: false, reason: "offer_not_found", stage });
        }

        if (String(offer.state || "").toLowerCase() !== "open") {
          return res.status(409).json({ ok: false, reason: "offer_not_open", stage });
        }


        const fillSizeStr = typeof psktRequest.fillSize === "string" ? psktRequest.fillSize.trim() : "";
        const expectedSell = String(offer.sellAmount ?? "").trim();
        if (!fillSizeStr || !expectedSell || fillSizeStr !== expectedSell) {
          return res.status(400).json({
            ok: false,
            reason: "partial_fills_disabled",
            stage,
            expectedSell,
            fillSize: fillSizeStr
          });
        }

        const kind = typeof offer.swapKind === "string" ? offer.swapKind.trim() : "";
        const tokenId = typeof offer.tokenId === "string" ? offer.tokenId.trim() : "";
        const p2shAddress = typeof offer.swapP2shAddress === "string" ? offer.swapP2shAddress.trim() : "";
        const pskbOffer = typeof offer.swapPskb === "string" ? offer.swapPskb.trim() : "";

        if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
          return res.status(500).json({ ok: false, reason: "offer_bad_swapKind", stage });
        }
        if (!tokenId || !p2shAddress || !pskbOffer) {
          return res.status(500).json({ ok: false, reason: "offer_missing_swap_fields", stage });
        }

        stage = "swap_mode_direct_load_wallet";
        const userId = String((res.locals as any).td_user_id || "").trim();
        if (!userId) {
          return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html", stage });
        }
        const storeW = readWalletStore(repoRoot, userId);
        const active = storeW.active_id ? (storeW.items.find((w: any) => w.id === storeW.active_id) ?? null) : null;
        if (!active) {
          return res.status(409).json({ ok: false, reason: "wallet_not_loaded", stage });
        }

        if (!!offer.complianceOnly && active.wallet_type !== "compliance") {
          return res.status(409).json({
            ok: false,
            reason: "compliance_wallet_required",
            stage,
            offerId
          });
        }

        const baseUrl = `http://${HOST}:${PORT}`;

        stage = "swap_mode_call_accept";

        const acceptStage =
          swapStage === "bcw_direct_swap_finalize_submit"
            ? "submit"
            : (swapStage === "prepare" || swapStage === "submit" || swapStage === "resign_submit" ? swapStage : "prepare");

        const acceptBody: any = {
          stage: acceptStage,
          acceptRid,
          kind,
          tokenId,
          offerId,
          p2shAddress,
          pskb: pskbOffer
        };

        const offerCommitTxidsAny: any = (offer as any).swapCommitTxids;
        if (Array.isArray(offerCommitTxidsAny)) {
          const offerCommitTxids = offerCommitTxidsAny
            .map((x: any) => (typeof x === "string" ? x.trim() : ""))
            .filter((x: string) => !!x);
          if (offerCommitTxids.length) {
            acceptBody.swapCommitTxids = offerCommitTxids;
          }
        }

        if (swapStage === "bcw_direct_swap_finalize_submit") {
          acceptBody.bcw_direct_swap_finalize_intent = bcwDirectSwapFinalizeIntent;
          acceptBody.bcw_auth_signature = bcwAuthSignature;
        } else if (acceptStage === "submit") {
          acceptBody.takerInputSigs = takerInputSigs;
        } else if (acceptStage === "resign_submit") {
          acceptBody.takerInputSigs = takerInputSigs;
          acceptBody.takerResignInputSigs = takerResignInputSigs;
        }

        const rAccept = await fetchFn(`${baseUrl}/api/swaps/accept`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof req.headers.cookie === "string" && req.headers.cookie ? { cookie: req.headers.cookie } : {}),
            ...(typeof req.headers.authorization === "string" && req.headers.authorization
              ? { authorization: req.headers.authorization }
              : {})
          },
          body: JSON.stringify(acceptBody)
        });

        const jAccept: any = await rAccept.json();
        if (!jAccept || !jAccept.ok) {
          return res.status(rAccept.status).json({ ok: false, reason: "swap_accept_failed", stage, accept: jAccept });
        }

        if (jAccept.stage === "bcw_direct_swap_finalize_intent" && jAccept.bcw_direct_swap_finalize_intent && typeof jAccept.intent_message === "string") {
          return res.json({
            ok: true,
            stage: "swap_direct_bcw_finalize_intent",
            acceptRid: String(jAccept.acceptRid || ""),
            custody_model: "broker_1of1",
            bcw_direct_swap_finalize_intent: jAccept.bcw_direct_swap_finalize_intent,
            intent_message: jAccept.intent_message,
            broker_fee_sompi: typeof jAccept.broker_fee_sompi === "string" ? jAccept.broker_fee_sompi : undefined,
            broker_fee_destination: typeof jAccept.broker_fee_destination === "string" ? jAccept.broker_fee_destination : undefined
          });
        }

        if (jAccept.stage === "prepare" && typeof jAccept.txToSignSafeJson === "string" && jAccept.txToSignSafeJson && Array.isArray(jAccept.inputsToSign)) {
          return res.json({
            ok: true,
            stage: "swap_accept_prepare",
            acceptRid: String(jAccept.acceptRid || ""),
            txToSignSafeJson: jAccept.txToSignSafeJson,
            inputsToSign: jAccept.inputsToSign,
            sign_mode: typeof (jAccept as any).sign_mode === "string" ? (jAccept as any).sign_mode : undefined
          });
        }

        if (jAccept.stage === "resign_prepare" && typeof jAccept.txToResignSafeJson === "string" && jAccept.txToResignSafeJson && Array.isArray(jAccept.inputsToSign)) {
          return res.json({
            ok: true,
            stage: "swap_accept_resign_prepare",
            acceptRid: String(jAccept.acceptRid || ""),
            txToResignSafeJson: jAccept.txToResignSafeJson,
            inputsToSign: jAccept.inputsToSign,
            sign_mode: typeof (jAccept as any).sign_mode === "string" ? (jAccept as any).sign_mode : undefined
          });
        }

        let jFinal: any = null;
        let txid = "";

        if (jAccept.stage === "bcw_direct_swap_finalize_submit" && typeof jAccept.txid === "string" && jAccept.txid.trim()) {
          jFinal = jAccept;
          txid = jAccept.txid.trim();

          const idx = storeO.items.findIndex((o: any) => o && o.offerId === offerId);
          if (idx >= 0 && String(storeO.items[idx]?.state || "").toLowerCase() === "open") {
            storeO.items[idx] = {
              ...storeO.items[idx],
              state: "filled"
            };
            writeOffersStore(repoRoot, storeO);
            console.log(`[swap_mode] bcw direct offer marked filled offerId=${offerId} txid=${txid}`);
          }
        } else {
          if (typeof jAccept.pskb !== "string" || !jAccept.pskb.trim()) {
            return res.status(500).json({ ok: false, reason: "swap_accept_bad_response", stage, accept: jAccept });
          }

          const acceptedPskb = jAccept.pskb.trim();

          stage = "swap_mode_call_finalize";
          const rFinal = await fetchFn(`${baseUrl}/api/swaps/finalize`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(typeof req.headers.cookie === "string" && req.headers.cookie ? { cookie: req.headers.cookie } : {}),
              ...(typeof req.headers.authorization === "string" && req.headers.authorization
                ? { authorization: req.headers.authorization }
                : {})
            },
            body: JSON.stringify({
              kind,
              pskb: acceptedPskb
            })
          });

          jFinal = await rFinal.json();
          if (!jFinal || !jFinal.ok || typeof jFinal.txid !== "string" || !jFinal.txid.trim()) {
            return res.status(500).json({ ok: false, reason: "swap_finalize_failed", stage, finalize: jFinal });
          }

          txid = jFinal.txid.trim();

          const idx = storeO.items.findIndex((o: any) => o && o.offerId === offerId);
          if (idx >= 0 && String(storeO.items[idx]?.state || "").toLowerCase() === "open") {
            storeO.items[idx] = {
              ...storeO.items[idx],
              state: "filled"
            };
            writeOffersStore(repoRoot, storeO);
            console.log(`[swap_mode] direct offer marked filled after submitted txid offerId=${offerId} txid=${txid}`);
          }
        }

        stage = "swap_mode_krc20_verify_op";
        const finalNet = typeof jFinal.network === "string" ? jFinal.network : "";
        const finalAppNetworkKey = normalizeAppNetworkKey(finalNet) ?? "tn10";
        const kasplexBaseUrl = kasplexBaseUrlFromAppNetworkKey(finalAppNetworkKey);
        const opUrl = `${kasplexBaseUrl}/krc20/op/${txid}`;

        const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        let jOp: any = null;
        let opStatus: any = null;
        let opMessage: any = null;

        const maxTries = finalAppNetworkKey === "mainnet" ? 3 : 10;

        for (let i = 0; i < maxTries; i++) {
          try {
            const rOp: any = await fetchFn(opUrl, {
              method: "GET",
              headers: {
                accept: "*/*",
                "user-agent": "Mozilla/5.0"
              }
            });

            opStatus = rOp ? rOp.status : null;

            const opText = rOp ? await rOp.text() : "";
            if (opText) {
              try {
                const parsed: any = JSON.parse(opText);
                if (parsed && typeof parsed.message === "string") opMessage = parsed.message;
                if (rOp && rOp.ok) {
                  jOp = parsed;
                  break;
                }
              } catch {
                opMessage = opText;
              }
            }
          } catch (e) {
            opMessage = String(e);
          }

          if (i < maxTries - 1) {
            await sleepMs(1000);
          }
        }

        if (!jOp) {
          return res.status(200).json({
            ok: true,
            mode,
            offerId,
            kind,
            network: typeof jFinal.network === "string" ? jFinal.network : null,
            txid,
            verify: {
              ok: false,
              reason: "krc20_op_pending",
              stage,
              status: opStatus,
              message: opMessage ?? null
            }
          });
        }

        const opRow =
          jOp && Array.isArray(jOp.result) && jOp.result.length > 0
            ? jOp.result[0]
            : null;

        const opAccept = opRow && opRow.opAccept !== undefined ? String(opRow.opAccept) : "";

        if (opAccept !== "1") {
          return res.status(200).json({
            ok: true,
            mode,
            offerId,
            kind,
            network: typeof jFinal.network === "string" ? jFinal.network : null,
            txid,
            verify: {
              ok: false,
              reason: opAccept ? "krc20_op_rejected" : "krc20_op_pending",
              stage,
              op: opRow
            }
          });
        }

        stage = "swap_mode_model_b_load_wallet";
        const fillUserId = String((res.locals as any).td_user_id || "").trim();
        if (!fillUserId) {
          return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html", stage });
        }

        console.log(`[swap_mode] direct offer verified after submitted txid offerId=${offerId} txid=${txid}`);

        stage = "swap_mode_ok";
        return res.json({
          ok: true,
          mode,
          offerId,
          kind,
          network: typeof jFinal.network === "string" ? jFinal.network : null,
          txid
        });
      } catch (err) {
        // DIAG: compare remote rejected txid vs local txid we believed we submitted
        const errAny: any = err as any;
        try {
          const keys = errAny && typeof errAny === "object" ? Object.keys(errAny) : [];
          console.log(`[diag] rpc_submit_error_keys=[${keys.join(",")}]`);
          if (errAny && typeof errAny === "object") {
            if (errAny.code !== undefined) console.log(`[diag] rpc_submit_error_code=${String(errAny.code)}`);
            if (errAny.data !== undefined) {
              let s = "";
              try {
                s = JSON.stringify(errAny.data);
              } catch {
                try {
                  s = String(errAny.data);
                } catch {
                  s = "[unstringifiable]";
                }
              }
              console.log(`[diag] rpc_submit_error_data=${s}`);
            }

            if (errAny.details !== undefined) {
              let s = "";
              try {
                s = JSON.stringify(errAny.details);
              } catch {
                try {
                  s = String(errAny.details);
                } catch {
                  s = "[unstringifiable]";
                }
              }
              console.log(`[diag] rpc_submit_error_details=${s}`);
            }
          }
        } catch {}
        const errStr = String(err);
        const m = errStr.match(/Rejected transaction\s+([0-9a-f]{64})/i);
        const txidRemote = m && m[1] ? m[1].trim().toLowerCase() : "";
        if (txidRemote || diag_last_submit_txid) {
          console.log(
            `[diag] swap_mode_error_txid_compare stage=${stage} local=${diag_last_submit_txid || "na"} remote=${txidRemote || "na"} match=${!!diag_last_submit_txid && !!txidRemote && diag_last_submit_txid === txidRemote} ${diag_last_submit_summary || ""}`
          );
        }

        return res.status(500).json({ ok: false, reason: `swap_mode_failed:${stage}`, stage, error: errStr });
      }
    }

    const tokenRaw = typeof body.token === "string" ? body.token.trim() : "";
    const tokenId = tokenRaw ? tokenRaw : "KAS";
    const isKas = tokenId.toUpperCase() === "KAS";
    const isCa = /^CA:/i.test(tokenId);
    const caHex = isCa ? tokenId.slice(3).trim().toLowerCase() : "";

    const to = typeof body.to === "string" ? body.to.trim() : "";

    if (!to || !/^(kaspa:|kaspatest:)/.test(to)) {
      return res.json({
        ok: false,
        reason: "invalid_destination",
        error: "Invalid destination address"
      });
    }

    const amountStr =
      typeof body.amount === "string" || typeof body.amount === "number"
        ? String(body.amount).trim()
        : "";

    const stage = typeof body.stage === "string" ? body.stage.trim() : "";
    const useMax = !!body.use_max;
    const consolidateOnly = !!body.consolidate_only;
    const selectedEntryKeys = normalizeSelectedEntryKeys((body as any).selected_entry_keys);

    // Token/CA amount format is validated here; KAS continues to use kaspaToSompi later.
    if (!isKas) {
      if (!isPositiveAmountString(amountStr)) {
        return res.json({
          ok: false,
          reason: "invalid_amount",
          error: "Invalid amount"
        });
      }

      if (isCa) {
        if (!/^[0-9a-f]{64}$/.test(caHex)) {
          return res.json({
            ok: false,
            reason: "invalid_token",
            error: "Invalid CA (expected 64 hex)"
          });
        }
      } else {
        // tick: basic sanity. Protocol-level enforcement is Kasplex-side.
        if (!/^[A-Za-z0-9]{1,16}$/.test(tokenId)) {
          return res.json({
            ok: false,
            reason: "invalid_token",
            error: "Invalid token ticker"
          });
        }
      }
    }

    const userId = String((res.locals as any).td_user_id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const store = readWalletStore(repoRoot, userId);
    const active = store.active_id
      ? store.items.find((w: any) => w.id === store.active_id) ?? null
      : null;

    if (!active) {
      return res.status(409).json({
        ok: false,
        reason: "no_active_wallet",
        error: "No active wallet selected"
      });
    }

    if (active.state !== "READY") {
      return res.status(409).json({
        ok: false,
        reason: "wallet_not_ready",
        error: "Wallet is not ready"
      });
    }

    const isComplianceWallet = active.wallet_type === "compliance";

    if (selectedEntryKeys.length > 0 && !consolidateOnly) {
      return res.status(400).json({
        ok: false,
        reason: "selected_entries_requires_consolidate_only",
        error: "selected_entry_keys is only supported for consolidate_only builds"
      });
    }

    if (selectedEntryKeys.length > 0 && !consolidateOnly) {
      return res.status(400).json({
        ok: false,
        reason: "selected_entries_requires_consolidate_only",
        error: "selected_entry_keys is only supported for consolidate_only builds"
      });
    }

    if (consolidateOnly) {
      if (!isKas || !isComplianceWallet) {
        return res.status(400).json({
          ok: false,
          reason: "consolidate_only_invalid_wallet",
          error: "consolidate_only is only supported for compliance KAS sends"
        });
      }
      if (!useMax) {
        return res.status(400).json({
          ok: false,
          reason: "consolidate_only_requires_use_max",
          error: "consolidate_only requires use_max"
        });
      }
      if (to !== active.address0) {
        return res.status(400).json({
          ok: false,
          reason: "consolidate_only_requires_self_destination",
          error: "consolidate_only requires destination to equal the active wallet address"
        });
      }
    }

    if (isKas) {
      if (stage !== "build" && stage !== "submit") {
        return res.status(400).json({
          ok: false,
          reason: "send_stage_required",
          error: "Send stage required (build | submit)"
        });
      }
    } else {
      if (
        stage !== "krc_commit_build" &&
        stage !== "krc_commit_submit" &&
        stage !== "krc_reveal_wait" &&
        stage !== "krc_reveal_submit"
      ) {
        return res.status(400).json({
          ok: false,
          reason: "send_stage_required",
          error:
            "Send stage required (krc_commit_build | krc_commit_submit | krc_reveal_wait | krc_reveal_submit)"
        });
      }
    }

    const expectedPrefix = `${addressPrefixFromAppNetworkKey(appNetworkKeyFromWalletNetwork(active.network))}:`;
    if (!to.startsWith(expectedPrefix)) {
      return res.json({
        ok: false,
        reason: "invalid_destination_network",
        error: `Destination must start with ${expectedPrefix}`
      });
    }

    if (!consolidateOnly) {
      const whitelistGate = walletWhitelistGateForSend({
        active,
        to
      });
      if (!whitelistGate.ok) {
        return res.json({
          ok: false,
          reason: whitelistGate.reason,
          error: whitelistGate.error
        });
      }
    }

    const executionClaim = claimPreparedBridgePurchaseExecution({
      repoRoot,
      active,
      stage,
      caHex,
      to,
      amountRaw: amountStr,
      body
    });
    if (!executionClaim.ok) {
      return res.status(executionClaim.status).json({
        ok: false,
        reason: executionClaim.reason,
        error: executionClaim.error
      });
    }

    const appNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
    const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
    rpc = await getSharedRpc(networkId);

    const fee = await rpc.getFeeEstimate();
    const feeRate =
      fee &&
      fee.estimate &&
      Array.isArray(fee.estimate.normalBuckets) &&
      fee.estimate.normalBuckets.length > 0 &&
      typeof fee.estimate.normalBuckets[0].feerate === "number"
        ? fee.estimate.normalBuckets[0].feerate
        : null;

    if (!feeRate || !Number.isFinite(feeRate) || feeRate <= 0) {
      return res.status(500).json({
        ok: false,
        reason: "fee_rate_unavailable",
        error: "Fee estimate unavailable"
      });
    }

    if (isKas) {
      const normalizedAmountStr = amountStr.startsWith(".") ? `0${amountStr}` : amountStr;
      const amountSompi = kaspaToSompi(normalizedAmountStr);
      if (amountSompi === undefined || amountSompi <= 0n) {
        return res.json({
          ok: false,
          reason: "invalid_amount",
          error: "Invalid amount"
        });
      }

      const utxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
      const entries = utxos.entries;

      if (!entries || entries.length === 0) {
        return res.json({
          ok: false,
          reason: "no_utxos",
          error: "No UTXOs available (fund the wallet first)"
        });
      }

      const priorityFee = useMax ? { amount: 0n, source: FeeSource.ReceiverPays } : 0n;

      if (active.wallet_type === "compliance" && active.custody_model === "broker_1of1") {
        if (stage !== "build" && stage !== "submit") {
          return res.status(400).json({
            ok: false,
            reason: "send_stage_required",
            error: "Send stage required (build | submit)"
          });
        }

        if (useMax) {
          return res.status(400).json({
            ok: false,
            reason: "bcw_kas_send_use_max_not_supported",
            error: "BCW KAS send does not support MAX yet."
          });
        }

        if (consolidateOnly) {
          return res.status(400).json({
            ok: false,
            reason: "bcw_kas_send_consolidate_not_supported",
            error: "BCW KAS send does not support consolidate_only."
          });
        }

        const walletId = typeof active.id === "string" ? active.id.trim() : "";
        const network = active.network === "mainnet" ? "mainnet" : "testnet";
        const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
        const fromAddress = typeof active.address0 === "string" ? active.address0.trim() : "";

        if (!walletId) {
          return res.status(409).json({ ok: false, reason: "wallet_missing_id", error: "BCW wallet is missing id" });
        }
        if (!brokerCustodyKeyRef) {
          return res.status(409).json({ ok: false, reason: "wallet_missing_broker_custody_key_ref", error: "BCW wallet is missing broker custody key reference" });
        }
        if (!userAuthPubkey) {
          return res.status(409).json({ ok: false, reason: "wallet_missing_user_auth_pubkey", error: "BCW wallet is missing authorization pubkey" });
        }
        if (!fromAddress) {
          return res.status(409).json({ ok: false, reason: "wallet_missing_address0", error: "BCW wallet is missing custody address" });
        }

        if (stage === "build") {
          const createdAt = new Date();
          const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
          const intent: BcwKasSendIntentV1 = {
            v: 1,
            purpose: "bcw_kas_send",
            wallet_id: walletId,
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: fromAddress,
            to_address: to,
            amount_sompi: amountSompi.toString(),
            user_auth_pubkey: userAuthPubkey,
            created_at: createdAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            nonce: `BCWREQ_${randomBytes(16).toString("hex")}`
          };

          return res.json({
            ok: true,
            stage: "bcw_intent",
            token: "KAS",
            custody_model: "broker_1of1",
            intent,
            intent_message: canonicalBcwKasSendIntentMessage(intent)
          });
        }

        const intent = normalizeBcwKasSendIntent((body as any).bcw_intent);
        const authSignature = normalizeBcwRouteString((body as any).bcw_auth_signature);

        if (!intent) {
          return res.status(400).json({ ok: false, reason: "bcw_kas_send_intent_invalid", error: "BCW KAS send intent is invalid" });
        }
        if (!authSignature) {
          return res.status(400).json({ ok: false, reason: "bcw_kas_send_auth_signature_required", error: "BCW KAS send authorization signature is required" });
        }

        if (
          intent.wallet_id !== walletId ||
          intent.wallet_type !== "compliance" ||
          intent.custody_model !== "broker_1of1" ||
          intent.network !== network ||
          intent.broker_custody_key_ref !== brokerCustodyKeyRef ||
          intent.from_address !== fromAddress ||
          intent.to_address !== to ||
          intent.amount_sompi !== amountSompi.toString() ||
          intent.user_auth_pubkey !== userAuthPubkey
        ) {
          return res.status(409).json({ ok: false, reason: "bcw_kas_send_intent_mismatch", error: "BCW KAS send intent does not match active wallet request" });
        }

        const cn = await postBcwKasSendToCn({
          repoRoot,
          getAppConfig,
          intent,
          authSignature
        });

        if (!cn.ok) {
          const errMsg =
            cn.data && (cn.data.error || cn.data.reason) ? String(cn.data.error || cn.data.reason) : "CN rejected BCW KAS send";
          return res.status(cn.status || 502).json({ ok: false, reason: "bcw_cn_rejected", error: errMsg, cn: cn.data });
        }

        const txids = Array.isArray(cn.data.txids)
          ? cn.data.txids.map((v: any) => String(v || "").trim()).filter((v: string) => !!v)
          : [];

        const txid = typeof cn.data.txid === "string" && cn.data.txid.trim()
          ? cn.data.txid.trim()
          : txids[txids.length - 1];

        if (!txid) {
          return res.status(502).json({ ok: false, reason: "bcw_cn_missing_txid", error: "CN did not return a BCW KAS txid" });
        }

        queueFundsSentNotification({
          repoRoot,
          userId,
          active,
          networkId,
          to,
          asset: "KAS",
          amountRaw: amountSompi.toString(),
          txid
        });

        return res.json({
          ok: true,
          txid,
          txids: txids.length > 0 ? txids : [txid],
        });
      }

      if (active.wallet_type === "compliance") {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_kas_send_removed",
          error: "Legacy 2-of-2 Compliance Wallet KAS send has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }

      if (stage === "build") {
        const safeEntries = entries.map((e: any) => ({
          outpoint: e && e.outpoint && typeof e.outpoint.toJSON === "function" ? e.outpoint.toJSON() : (e ? e.outpoint : null),
          amount: e && typeof e.amount === "bigint" ? e.amount.toString() : String(e && e.amount !== undefined ? e.amount : ""),
          scriptPublicKey:
            e && e.scriptPublicKey && typeof e.scriptPublicKey.toJSON === "function"
              ? e.scriptPublicKey.toJSON()
              : (e ? e.scriptPublicKey : null),
          blockDaaScore: e && typeof e.blockDaaScore === "bigint" ? e.blockDaaScore.toString() : String(e && e.blockDaaScore !== undefined ? e.blockDaaScore : ""),
          isCoinbase: !!(e && e.isCoinbase),
        }));

        return res.json({
          ok: true,
          stage: "build",
          networkId,
          feeRate,
          useMax,
          changeAddress: active.address0,
          to,
          amountSompi: amountSompi.toString(),
          entries: safeEntries,
        });
      }

      if (stage === "submit") {
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
          return res.status(400).json({ ok: false, reason: "no_valid_signed_txs" });
        }

        queueFundsSentNotification({
          repoRoot,
          userId,
          active,
          networkId,
          to,
          asset: "KAS",
          amountRaw: amountSompi.toString(),
          txid: txids[txids.length - 1]
        });

        return res.json({
          ok: true,
          txid: txids[txids.length - 1],
          txids,
        });
      }

      return res.status(400).json({
        ok: false,
        reason: "send_stage_required",
        error: "Send stage required (build | submit)"
      });
    }

    // KRC-20 transfer (tick or CA): commit + reveal
    const payload = (() => {
      if (isCa) {
        return {
          p: "krc-20",
          op: "transfer",
          ca: caHex,
          amt: amountStr,
          to
        };
      }
      return {
        p: "krc-20",
        op: "transfer",
        tick: tokenId,
        amt: amountStr,
        to
      };
    })();

    if (isComplianceWallet && active.custody_model === "broker_1of1") {
      if (stage !== "krc_commit_build" && stage !== "krc_commit_submit") {
        return res.status(400).json({
          ok: false,
          reason: "send_stage_required",
          error: "Send stage required (krc_commit_build | krc_commit_submit)"
        });
      }

      const walletId = typeof active.id === "string" ? active.id.trim() : "";
      const network = active.network === "mainnet" ? "mainnet" : "testnet";
      const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
      const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
      const fromAddress = typeof active.address0 === "string" ? active.address0.trim() : "";
      const tokenKind: BcwKrc20TokenKind = isCa ? "ca" : "tick";
      const tokenCa = isCa ? caHex : "";
      const tokenTick = isCa ? "" : tokenId.toUpperCase();

      if (!walletId) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_id", error: "BCW wallet is missing id" });
      }
      if (!brokerCustodyKeyRef) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_broker_custody_key_ref", error: "BCW wallet is missing broker custody key reference" });
      }
      if (!userAuthPubkey) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_user_auth_pubkey", error: "BCW wallet is missing authorization pubkey" });
      }
      if (!fromAddress) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_address0", error: "BCW wallet is missing custody address" });
      }

      if (stage === "krc_commit_build") {
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
        const intent: BcwKrc20TransferIntentV1 = {
          v: 1,
          purpose: "bcw_krc20_transfer",
          wallet_id: walletId,
          wallet_type: "compliance",
          custody_model: "broker_1of1",
          network,
          broker_custody_key_ref: brokerCustodyKeyRef,
          from_address: fromAddress,
          to_address: to,
          token_kind: tokenKind,
          ca: tokenCa,
          tick: tokenTick,
          amount_raw: amountStr,
          user_auth_pubkey: userAuthPubkey,
          created_at: createdAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          nonce: `BCWKRCREQ_${randomBytes(16).toString("hex")}`
        };

        return res.json({
          ok: true,
          stage: "bcw_krc20_intent",
          token: tokenId,
          custody_model: "broker_1of1",
          intent,
          intent_message: canonicalBcwKrc20TransferIntentMessage(intent)
        });
      }

      const intent = normalizeBcwKrc20TransferIntent((body as any).bcw_krc20_intent);
      const authSignature = normalizeBcwRouteString((body as any).bcw_auth_signature);

      if (!intent) {
        return res.status(400).json({ ok: false, reason: "bcw_krc20_transfer_intent_invalid", error: "BCW KRC-20 transfer intent is invalid" });
      }
      if (!authSignature) {
        return res.status(400).json({ ok: false, reason: "bcw_krc20_transfer_auth_signature_required", error: "BCW KRC-20 transfer authorization signature is required" });
      }

      if (
        intent.wallet_id !== walletId ||
        intent.wallet_type !== "compliance" ||
        intent.custody_model !== "broker_1of1" ||
        intent.network !== network ||
        intent.broker_custody_key_ref !== brokerCustodyKeyRef ||
        intent.from_address !== fromAddress ||
        intent.to_address !== to ||
        intent.token_kind !== tokenKind ||
        intent.ca !== tokenCa ||
        intent.tick !== tokenTick ||
        intent.amount_raw !== amountStr ||
        intent.user_auth_pubkey !== userAuthPubkey
      ) {
        return res.status(409).json({ ok: false, reason: "bcw_krc20_transfer_intent_mismatch", error: "BCW KRC-20 transfer intent does not match active wallet request" });
      }

      const cn = await postBcwKrc20TransferToCn({
        repoRoot,
        getAppConfig,
        intent,
        authSignature
      });

      if (!cn.ok) {
        const errMsg =
          cn.data && (cn.data.error || cn.data.reason) ? String(cn.data.error || cn.data.reason) : "CN rejected BCW KRC-20 transfer";
        return res.status(cn.status || 502).json({ ok: false, reason: "bcw_krc20_cn_rejected", error: errMsg, cn: cn.data });
      }

      const revealTxids = Array.isArray(cn.data.revealTxids)
        ? cn.data.revealTxids.map((v: any) => String(v || "").trim()).filter((v: string) => !!v)
        : [];

      const commitTxids = Array.isArray(cn.data.commitTxids)
        ? cn.data.commitTxids.map((v: any) => String(v || "").trim()).filter((v: string) => !!v)
        : [];

      const txid = typeof cn.data.txid === "string" && cn.data.txid.trim()
        ? cn.data.txid.trim()
        : revealTxids[revealTxids.length - 1];

      if (!txid) {
        return res.status(502).json({ ok: false, reason: "bcw_krc20_cn_missing_txid", error: "CN did not return a BCW KRC-20 reveal txid" });
      }

      queueFundsSentNotification({
        repoRoot,
        userId,
        active,
        networkId,
        to,
        asset: isCa ? caHex : tokenId,
        amountRaw: amountStr,
        txid
      });

      return res.json({
        ok: true,
        txid,
        txids: revealTxids.length > 0 ? revealTxids : [txid],
        commitTxids,
        revealTxids: revealTxids.length > 0 ? revealTxids : [txid]
      });
    }

    if (isComplianceWallet) {
      return res.status(409).json({
        ok: false,
        reason: "legacy_compliance_krc20_send_removed",
        error: "Legacy 2-of-2 Compliance Wallet KRC-20 transfer has been removed. Create or select a broker-custody Compliance Wallet."
      });
    }

    if (stage === "krc_commit_build") {
      const utxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
      const entries = utxos && Array.isArray((utxos as any).entries) ? (utxos as any).entries : [];

      if (!entries || entries.length === 0) {
        return res.json({
          ok: false,
          reason: "no_utxos",
          error: "No UTXOs available (fund the wallet first)"
        });
      }

      const safeEntries = entries.map((e: any) => ({
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

      const commitAmountSompi = 30000000n; // 0.3 KAS

      return res.json({
        ok: true,
        stage: "krc_commit_build",
        networkId,
        feeRate,
        fromAddress: active.address0,
        commitAmountSompi: commitAmountSompi.toString(),
        payloadJson: JSON.stringify(payload),
        entries: safeEntries
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
        return res.status(400).json({ ok: false, reason: "no_valid_signed_txs" });
      }

      try {
        persistPreparedBridgePurchaseExecutionResult({
          repoRoot,
          active,
          stage,
          tokenId,
          caHex,
          body,
          txid: txids[txids.length - 1]
        });
      } catch (err) {
        console.error("[bridge_fulfillment_result] persist_failed", err);
      }

      if (stage === "krc_reveal_submit") {
        queueFundsSentNotification({
          repoRoot,
          userId,
          active,
          networkId,
          to,
          asset: isCa ? caHex : tokenId,
          amountRaw: amountStr,
          txid: txids[txids.length - 1]
        });
      }

      return res.json({
        ok: true,
        stage,
        txid: txids[txids.length - 1],
        txids,
        commitTxids: stage === "krc_commit_submit" ? txids : undefined,
        revealTxids: stage === "krc_reveal_submit" ? txids : undefined
      });
    }

    if (stage === "krc_reveal_wait") {
      const p2shAddress = typeof (body as any).p2shAddress === "string" ? String((body as any).p2shAddress).trim() : "";
      const commitTxidsRaw = Array.isArray((body as any).commitTxids) ? (body as any).commitTxids : [];
      const commitTxids = commitTxidsRaw
        .filter((x: any) => typeof x === "string" && x.trim())
        .map((x: any) => String(x).trim());

      if (!p2shAddress || !/^(kaspa:|kaspatest:)/.test(p2shAddress)) {
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
      for (let i = 0; i < 30; i++) {
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
      reason: "send_stage_required",
      error:
        "Send stage required (krc_commit_build | krc_commit_submit | krc_reveal_wait | krc_reveal_submit)"
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      reason: "send_failed",
      error: String(err)
    });
  } finally {
    // keep shared RPC connected
  }
}

export async function handleWalletEstimate(req: Request, res: Response, ctx: WalletSendCtx): Promise<any> {
  const {
    repoRoot,
    ensureKaspaReady,
    getSharedRpc,
    readWalletStore
  } = ctx;

  let rpc: RpcClient | null = null;

  const formatKas = (sompi: bigint): string => {
    const whole = sompi / 100000000n;
    const frac = sompi % 100000000n;
    const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  };

  const readFeeRate = (fee: any): number | null => {
    return fee &&
      fee.estimate &&
      Array.isArray(fee.estimate.normalBuckets) &&
      fee.estimate.normalBuckets.length > 0 &&
      typeof fee.estimate.normalBuckets[0].feerate === "number"
      ? fee.estimate.normalBuckets[0].feerate
      : null;
  };

  try {
    await ensureKaspaReady(repoRoot);

    const tokenRaw = typeof req.query.token === "string" ? req.query.token.trim() : "";
    const tokenId = tokenRaw ? tokenRaw : "KAS";
    const isKas = tokenId.toUpperCase() === "KAS";
    const isCa = /^CA:/i.test(tokenId);
    const caHex = isCa ? tokenId.slice(3).trim().toLowerCase() : "";

    if (isCa) {
      if (!/^[0-9a-f]{64}$/.test(caHex)) {
        return res.json({ ok: false, reason: "invalid_token", error: "Invalid CA (expected 64 hex)" });
      }
    } else if (!isKas) {
      if (!/^[A-Za-z0-9]{1,16}$/.test(tokenId)) {
        return res.json({ ok: false, reason: "invalid_token", error: "Invalid token ticker" });
      }
    }

    const userId = String((res.locals as any).td_user_id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const store = readWalletStore(repoRoot, userId);
    const active = store.active_id
      ? store.items.find((w: any) => w.id === store.active_id) ?? null
      : null;

    if (!active) {
      return res.status(409).json({ ok: false, reason: "no_active_wallet", error: "No active wallet selected" });
    }

    if (!isKas) {
      return res.json({
        ok: true,
        kind: "minimum_kas_required",
        token: isCa ? `CA:${caHex}` : tokenId,
        minimumKasRequiredSompi: "33000000",
        minimumKasRequiredKas: "0.33"
      });
    }

    const useMaxRaw = typeof req.query.useMax === "string"
      ? req.query.useMax
      : (typeof req.query.max === "string" ? req.query.max : "");
    const useMax = /^(1|true|yes|on)$/i.test(String(useMaxRaw || "").trim());
    if (useMax) {
      return res.json({
        ok: true,
        kind: "recipient_pays_max",
        token: "KAS",
        message: "Fees are paid by the recipient on MAX sends."
      });
    }

    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
    const amountStr = typeof req.query.amount === "string" ? req.query.amount.trim() : "";
    const appNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
    const expectedPrefix = `${addressPrefixFromAppNetworkKey(appNetworkKey)}:`;

    if (!to) {
      return res.json({ ok: true, kind: "needs_input", token: "KAS", message: "Enter recipient to view estimated KAS required." });
    }
    if (!to.startsWith(expectedPrefix)) {
      return res.json({ ok: false, reason: "invalid_destination_network", error: `Destination must start with ${expectedPrefix}` });
    }
    if (!amountStr) {
      return res.json({ ok: true, kind: "needs_input", token: "KAS", message: "Enter amount to view estimated KAS required." });
    }

    const normalizedAmountStr = amountStr.startsWith(".") ? `0${amountStr}` : amountStr;
    const amountSompi = kaspaToSompi(normalizedAmountStr);
    if (amountSompi === undefined || amountSompi <= 0n) {
      return res.json({ ok: false, reason: "invalid_amount", error: "Invalid amount" });
    }

    const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
    rpc = await getSharedRpc(networkId);

    const feeRateResp = await rpc.getFeeEstimate();
    const feeRate = readFeeRate(feeRateResp);
    if (!feeRate || !Number.isFinite(feeRate) || feeRate <= 0) {
      return res.status(500).json({ ok: false, reason: "fee_rate_unavailable", error: "Fee estimate unavailable" });
    }

    const utxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
    const entries = utxos.entries;
    if (!entries || entries.length === 0) {
      return res.json({ ok: false, reason: "no_utxos", error: "No UTXOs available (fund the wallet first)" });
    }

    if (active.wallet_type === "compliance" && active.custody_model !== "broker_1of1") {
      return res.status(409).json({
        ok: false,
        reason: "legacy_compliance_wallet_estimate_removed",
        error: "Legacy 2-of-2 Compliance Wallet estimate has been removed. Create or select a broker-custody Compliance Wallet."
      });
    }

    const policyFeeSompi = 0n;
    const outputs: Array<{ address: string; amount: bigint }> = [{ address: to, amount: amountSompi }];
    const txOpts: any = {
      outputs,
      changeAddress: active.address0,
      feeRate,
      priorityFee: 0n,
      entries,
      networkId
    };

    let built: any = null;
    try {
      built = await createTransactions(txOpts);
    } catch (_) {
      const availableSompi = entries.reduce((sum: bigint, e: any) => {
        try {
          const amt = typeof e.amount === "bigint" ? e.amount : BigInt(String(e.amount ?? 0));
          return sum + amt;
        } catch {
          return sum;
        }
      }, 0n);
      const probeReservesSompi = [1n, 10000n, 1000000n, 10000000n, 100000000n];
      for (const reserveSompi of probeReservesSompi) {
        let probeAmountSompi = availableSompi - reserveSompi;
        if (probeAmountSompi <= 0n) continue;
        if (probeAmountSompi > amountSompi) probeAmountSompi = amountSompi;
        const probeOutputs = outputs.map((o: any, idx: number) =>
          idx === 0 ? { address: o.address, amount: probeAmountSompi } : o
        );
        try {
          built = await createTransactions({ ...txOpts, outputs: probeOutputs });
          const probeTx0 = built && Array.isArray(built.transactions) ? built.transactions[0] : null;
          const probeTx = probeTx0 && probeTx0.transaction ? probeTx0.transaction : null;
          if (probeTx) break;
        } catch (_) {}
      }
    }

    const tx0 = built && Array.isArray(built.transactions) ? built.transactions[0] : null;
    const tx = tx0 && tx0.transaction ? tx0.transaction : null;
    if (!tx) {
      return res.status(500).json({ ok: false, reason: "estimate_tx_missing", error: "Estimated transaction not created" });
    }

    const feeAny = calculateTransactionFee(networkId, tx);
    const networkFeeSompi = typeof feeAny === "bigint"
      ? feeAny
      : BigInt(String(feeAny !== undefined ? feeAny : 0));
    const estimatedTotalSompi = amountSompi + networkFeeSompi + policyFeeSompi;

    return res.json({
      ok: true,
      kind: "estimated_kas_required",
      token: "KAS",
      networkId,
      amountSompi: amountSompi.toString(),
      amountKas: formatKas(amountSompi),
      estimatedNetworkFeeSompi: networkFeeSompi.toString(),
      estimatedNetworkFeeKas: formatKas(networkFeeSompi),
      policyFeeSompi: policyFeeSompi.toString(),
      policyFeeKas: formatKas(policyFeeSompi),
      estimatedTotalSompi: estimatedTotalSompi.toString(),
      estimatedTotalKas: formatKas(estimatedTotalSompi),
      feeRate
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      reason: "wallet_estimate_failed",
      error: String(err)
    });
  } finally {
    // keep shared RPC connected
  }
}
