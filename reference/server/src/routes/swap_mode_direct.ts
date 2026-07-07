import type { Express } from "express";
import crypto from "node:crypto";
import type { AppNetworkKey, RpcNetworkId, WalletNetworkType } from "../types";
import { readWalletStore as readWalletStoreByUser } from "../storage/walletStore";
import { listUsers, readUserProfile, type UserNotificationSettings } from "../storage/userStore";
import { sendNotificationEmail } from "../email/smtp";
import {
  addressPrefixFromAppNetworkKey,
  appNetworkKeyFromWalletNetwork,
  applyKrc20ToccataFeeRateFloor,
  kasplexNetworkIdFromAppNetworkKey,
  krc20ToccataFeeRateFloorFromAppNetworkKey,
  rpcNetworkIdFromAppNetworkKey,
  walletNetworkTypeFromAppNetworkKey
} from "../networks";

// NOTE: wasm import path is one level deeper than server.ts (routes/ => ../../../)
import {
  RpcClient,
  createTransactions,
  kaspaToSompi,
  ScriptBuilder,
  Opcodes,
  payToAddressScript,
  addressFromScriptPublicKey,
  FeeSource,
  calculateTransactionFee,
  calculateTransactionMass,
  updateTransactionMass,
  maximumStandardTransactionMass,
  Transaction,
  PSKB,
  PSKT,
  SighashType,
  PublicKey,
  createAddress
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

export type SwapModeDirectCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<RpcClient>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  readOffersStore: (repoRootPath: string) => any;
  writeOffersStore: (repoRootPath: string, store: any) => void;

  kasplexGetAddressTokenList: (network: string, address: string) => Promise<any>;
  isPositiveAmountString: (s: string) => boolean;
  readSompi: (v: any) => bigint | null;

  sleepMs: (ms: number) => Promise<void>;

  decodePskbPayloadArray: (pskb: string) => any[];
  encodePskbPayloadArray: (arr: any[]) => string;

  validateSwapPskb: (
    repoRootPath: string,
    args: { phase: "offer" | "accept" | "finalize"; kind: "tick_to_kas" | "ca_to_kas"; pskb: string }
  ) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;

  normalizeOpCheckSigSignature64: (sig: any, tag: string) => Uint8Array;
  encodePushOnlyP2shSigScript: (sig: Uint8Array, sighashType: number, redeemScriptHex: string) => string;

  getAppConfig: (repoRootPath: string) => any;
  cnRecipientGatesFromPolicy: (cfg: any) => { regulated_cas: string[]; recipient_allowlist: string[] };

  bcwDirectSwapMakerSubmit?: (params: {
    repoRootPath: string;
    intent: unknown;
    authSignature: string;
  }) => Promise<{ ok: boolean; status: number; data: any }>;

  bcwDirectSwapFinalizeSubmit?: (params: {
    repoRootPath: string;
    intent: unknown;
    authSignature: string;
    txSafeJson: string;
  }) => Promise<{ ok: boolean; status: number; data: any }>;
};

type SwapOfferPrepCacheEntry = {
  createdAtMs: number;
  networkId: string;
  feeRate: number;

  userId: string;
  walletId: string;
  address0: string;
  userPubkey: string;

  commitPtxs: any[];
  commitTxids?: string[];
  txToSignSafeJson?: string;

  commitAmountSompi: bigint;
  p2shAddress: string;
  redeemScriptHex: string;

  kind: string;
  makerTokenTick: string;
  makerTokenAmtRaw: bigint;
  makerKasReceiveAddress: string;
  takerTokenReceiveAddress: string;
  expiry: number;
};

const swapOfferPrepCache = new Map<string, SwapOfferPrepCacheEntry>();

type BcwDirectSwapFinalizePrepCacheEntry = {
  createdAtMs: number;
  userId: string;
  walletId: string;
  networkId: RpcNetworkId;
  kind: "tick_to_kas" | "ca_to_kas";
  offerId: string;
  txSafeJson: string;
  makerOutputSpk: any;
  intent: BcwDirectSwapFinalizeIntentV1;
  intentMessage: string;
};

const bcwDirectSwapFinalizePrepCache = new Map<string, BcwDirectSwapFinalizePrepCacheEntry>();

function appNetworkKeyFromDirectSwapRpcNetworkId(networkId: RpcNetworkId): AppNetworkKey {
  return networkId === "testnet-10" ? "tn10" : "mainnet";
}

function directSwapToccataFeeRateFloor(networkId: RpcNetworkId): number {
  return krc20ToccataFeeRateFloorFromAppNetworkKey(appNetworkKeyFromDirectSwapRpcNetworkId(networkId));
}

function directSwapHexByteLength(hex: unknown, errorReason: string): bigint {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(errorReason);
  }
  return BigInt(hex.length / 2);
}

function directSwapSerializableTransaction(tx: any, errorReason: string): any {
  if (tx && typeof tx === "object" && Array.isArray(tx.inputs)) return tx;

  const inner = tx && typeof tx === "object" ? tx.transaction : null;
  if (inner && typeof inner === "object" && Array.isArray(inner.inputs)) return inner;

  if (tx && typeof tx.serializeToSafeJSON === "function") {
    const raw = tx.serializeToSafeJSON();
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.inputs)) return parsed;
    }
  }

  throw new Error(errorReason);
}

function directSwapTransactionMassWithSignatureScripts(tx: any, errorReason: string): bigint {
  const txObj = directSwapSerializableTransaction(tx, errorReason);
  const rawMass = txObj && typeof txObj === "object" ? txObj.mass : null;

  let baseMass: bigint;
  if (typeof rawMass === "bigint") {
    baseMass = rawMass;
  } else if (typeof rawMass === "number" && Number.isSafeInteger(rawMass) && rawMass >= 0) {
    baseMass = BigInt(rawMass);
  } else if (typeof rawMass === "string" && /^\d+$/.test(rawMass)) {
    baseMass = BigInt(rawMass);
  } else {
    throw new Error(errorReason);
  }

  const inputs = Array.isArray(txObj.inputs) ? txObj.inputs : [];
  const signatureScriptBytes = inputs.reduce((sum: bigint, input: any) => {
    const script = input && typeof input === "object" ? input.signatureScript : "";
    if (script === undefined || script === null || script === "") return sum;
    return sum + directSwapHexByteLength(script, errorReason);
  }, 0n);

  return baseMass + signatureScriptBytes;
}

function directSwapToccataRequiredFee(networkId: RpcNetworkId, tx: any, errorReason: string): bigint {
  return directSwapTransactionMassWithSignatureScripts(tx, errorReason) * BigInt(directSwapToccataFeeRateFloor(networkId));
}

type BcwDirectSwapFinalizeIntentV1 = {
  v: 1;
  purpose: "bcw_direct_swap_finalize";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "mainnet" | "testnet";
  broker_custody_key_ref: string;
  from_address: string;
  offer_id: string;
  kind: "tick_to_kas" | "ca_to_kas";
  tx_safe_json_sha256: string;
  sign_input_indexes: number[];
  expected_output_spk_hexes: string[];
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function walletNetworkToBcwDirectSwapNetwork(networkId: WalletNetworkType): "mainnet" | "testnet" | null {
  if (networkId === "mainnet") return "mainnet";
  if (networkId === "testnet") return "testnet";
  return null;
}

function sha256Utf8Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function newBcwDirectSwapFinalizeNonce(): string {
  return `BCWDIRECTREQ_${Date.now().toString(36)}_${crypto.randomBytes(16).toString("hex")}`;
}

function newBcwDirectSwapMakerNonce(): string {
  return `BCWDIRECTMAKERREQ_${Date.now().toString(36)}_${crypto.randomBytes(16).toString("hex")}`;
}

type BcwDirectSwapMakerIntentV1 = {
  v: 1;
  purpose: "bcw_direct_swap_maker";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: "mainnet" | "testnet";
  broker_custody_key_ref: string;
  from_address: string;
  maker_kas_receive_address: string;
  taker_token_receive_address: string;
  kind: "tick_to_kas" | "ca_to_kas";
  tick: string;
  ca: string;
  sell_amount_raw: string;
  buy_amount_sompi: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function normalizeBcwDirectSwapMakerIntent(raw: any): BcwDirectSwapMakerIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;

  const readString = (v: any): string => (typeof v === "string" ? v.trim() : "");
  const network = readString(raw.network);
  const kind = readString(raw.kind);

  if (network !== "mainnet" && network !== "testnet") return null;
  if (kind !== "tick_to_kas" && kind !== "ca_to_kas") return null;

  const intent: BcwDirectSwapMakerIntentV1 = {
    v: raw.v === 1 ? 1 : 0 as 1,
    purpose: raw.purpose === "bcw_direct_swap_maker" ? "bcw_direct_swap_maker" : "" as "bcw_direct_swap_maker",
    wallet_id: readString(raw.wallet_id),
    wallet_type: raw.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: raw.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network,
    broker_custody_key_ref: readString(raw.broker_custody_key_ref),
    from_address: readString(raw.from_address),
    maker_kas_receive_address: readString(raw.maker_kas_receive_address),
    taker_token_receive_address: readString(raw.taker_token_receive_address),
    kind,
    tick: readString(raw.tick).toUpperCase(),
    ca: readString(raw.ca).toLowerCase(),
    sell_amount_raw: readString(raw.sell_amount_raw),
    buy_amount_sompi: readString(raw.buy_amount_sompi),
    user_auth_pubkey: readString(raw.user_auth_pubkey),
    created_at: readString(raw.created_at),
    expires_at: readString(raw.expires_at),
    nonce: readString(raw.nonce)
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_direct_swap_maker") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.maker_kas_receive_address || !intent.taker_token_receive_address) return null;
  if (!/^[0-9]+$/.test(intent.sell_amount_raw) || BigInt(intent.sell_amount_raw) <= 0n) return null;
  if (!/^[0-9]+$/.test(intent.buy_amount_sompi) || BigInt(intent.buy_amount_sompi) <= 0n) return null;
  if (!intent.user_auth_pubkey || !intent.created_at || !intent.expires_at || !intent.nonce) return null;
  if (!/^BCWDIRECTMAKERREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;

  if (intent.kind === "ca_to_kas") {
    if (!/^[0-9a-f]{64}$/.test(intent.ca)) return null;
    if (intent.tick) return null;
  } else {
    if (!/^[A-Z0-9]{1,16}$/.test(intent.tick)) return null;
    if (intent.ca) return null;
  }

  return intent;
}

function canonicalBcwDirectSwapMakerIntentMessage(intent: BcwDirectSwapMakerIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    maker_kas_receive_address: intent.maker_kas_receive_address,
    taker_token_receive_address: intent.taker_token_receive_address,
    kind: intent.kind,
    tick: intent.tick,
    ca: intent.ca,
    sell_amount_raw: intent.sell_amount_raw,
    buy_amount_sompi: intent.buy_amount_sompi,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

function canonicalBcwDirectSwapFinalizeIntentMessage(intent: BcwDirectSwapFinalizeIntentV1): string {
  return JSON.stringify({
    v: intent.v,
    purpose: intent.purpose,
    wallet_id: intent.wallet_id,
    wallet_type: intent.wallet_type,
    custody_model: intent.custody_model,
    network: intent.network,
    broker_custody_key_ref: intent.broker_custody_key_ref,
    from_address: intent.from_address,
    offer_id: intent.offer_id,
    kind: intent.kind,
    tx_safe_json_sha256: intent.tx_safe_json_sha256,
    sign_input_indexes: intent.sign_input_indexes,
    expected_output_spk_hexes: intent.expected_output_spk_hexes,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

function sweepSwapOfferPrepCache(nowMs: number) {
  const ttlMs = 3 * 60 * 1000;
  for (const [rid, e] of swapOfferPrepCache.entries()) {
    if (nowMs - e.createdAtMs > ttlMs) swapOfferPrepCache.delete(rid);
  }
}

function sweepBcwDirectSwapFinalizePrepCache(nowMs: number) {
  const ttlMs = 3 * 60 * 1000;
  for (const [rid, e] of bcwDirectSwapFinalizePrepCache.entries()) {
    if (nowMs - e.createdAtMs > ttlMs) bcwDirectSwapFinalizePrepCache.delete(rid);
  }
}

function queueUserNotification(
  repoRoot: string,
  userId: string,
  eventKey: keyof UserNotificationSettings,
  subject: string,
  text: string
): void {
  try {
    const profile = readUserProfile(repoRoot, userId);
    const destination =
      typeof profile.notification_destination === "string"
        ? profile.notification_destination.trim()
        : "";

    if (!destination) return;
    if (!profile.notifications || profile.notifications[eventKey] !== true) return;

    void sendNotificationEmail({
      to: destination,
      subject,
      text
    }).catch(() => {});
  } catch {
    return;
  }
}

function findUserIdByWalletAddress(
  repoRoot: string,
  networkId: RpcNetworkId,
  walletAddress: string
): string {
  const want = String(walletAddress || "").trim().toLowerCase();
  if (!want) return "";

  const walletNetwork = walletNetworkTypeFromAppNetworkKey(
    networkId === "mainnet" ? "mainnet" : "tn10"
  );

  try {
    const users = listUsers(repoRoot);
    for (const user of users) {
      try {
        const store = readWalletStoreByUser(repoRoot, user.id);
        const items = Array.isArray(store && store.items) ? store.items : [];
        const hit = items.find((w: any) => {
          const addr = typeof w?.address0 === "string" ? w.address0.trim().toLowerCase() : "";
          const net = typeof w?.network === "string" ? w.network.trim().toLowerCase() : "";
          return addr === want && net === walletNetwork;
        });
        if (hit) return String(user.id || "").trim();
      } catch {
        continue;
      }
    }
  } catch {
    return "";
  }

  return "";
}

function queueDirectMakerFilledNotification(
  repoRoot: string,
  networkId: RpcNetworkId,
  kind: "tick_to_kas" | "ca_to_kas",
  txid: string,
  makerOutputSpk: any
): void {
  try {
    const makerAddressObj = addressFromScriptPublicKey(makerOutputSpk, networkId);
    const makerAddress = makerAddressObj ? String(makerAddressObj) : "";
    if (!makerAddress) return;

    const makerUserId = findUserIdByWalletAddress(repoRoot, networkId, makerAddress);
    if (!makerUserId) return;

    queueUserNotification(
      repoRoot,
      makerUserId,
      "maker_offer_filled",
      "Token Depot — Maker offer filled",
      [
        "A direct maker offer was filled.",
        "",
        `Network: ${networkId}`,
        `Kind: ${kind}`,
        `Maker receive address: ${makerAddress}`,
        `TxID: ${txid}`
      ].join("\n")
    );
  } catch {
    return;
  }
}

export function registerSwapModeDirectRoutes(app: Express, ctx: SwapModeDirectCtx): void {
  // Bind server.ts-scope dependencies into local names so the pasted bodies remain unchanged.
  const {
    repoRoot,
    ensureKaspaReady,
    getSharedRpc,
    readWalletStore,
    readOffersStore,
    writeOffersStore,
    kasplexGetAddressTokenList,
    isPositiveAmountString,
    readSompi,
    sleepMs,
    decodePskbPayloadArray,
    encodePskbPayloadArray,
    validateSwapPskb,
    normalizeOpCheckSigSignature64,
    encodePushOnlyP2shSigScript,
    getAppConfig,
    cnRecipientGatesFromPolicy,
    bcwDirectSwapMakerSubmit,
    bcwDirectSwapFinalizeSubmit
  } = ctx;
  app.post("/api/swaps/validate", async (req, res) => {
    try {
      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }
  
      const phase = body.phase;
      const kind = body.kind;
      const pskb = body.pskb;
  
      if (phase !== "offer" && phase !== "accept" && phase !== "finalize") {
        return res.status(400).json({ ok: false, reason: "invalid_phase" });
      }
      if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
        return res.status(400).json({ ok: false, reason: "invalid_kind" });
      }
      if (typeof pskb !== "string" || !pskb) {
        return res.status(400).json({ ok: false, reason: "missing_pskb" });
      }
  
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = readWalletStore(repoRoot, userId);
      const active = store.active_id ? (store.items.find((w: any) => w.id === store.active_id) ?? null) : null;
      if (!active) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      }
  
      const r = await validateSwapPskb(repoRoot, { phase, kind, pskb });
      return res.json(r);
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "swap_validate_failed", error: String(err) });
    }
  });

  app.post("/api/swaps/offer/expire", async (req, res) => {
    try {
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }

      const offerId = typeof body.offerId === "string" ? body.offerId.trim() : "";
      if (!offerId) {
        return res.status(400).json({ ok: false, reason: "missing_offer_id" });
      }

      const walletStore = readWalletStore(repoRoot, userId);
      const activeWalletId = typeof walletStore.active_id === "string" ? walletStore.active_id.trim() : "";
      const active = activeWalletId ? (walletStore.items.find((w: any) => w && w.id === activeWalletId) ?? null) : null;
      if (!active) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      }

      const storeO = readOffersStore(repoRoot);
      const offer = storeO.items.find((o: any) => o && o.offerId === offerId) ?? null;
      if (!offer) {
        return res.status(404).json({ ok: false, reason: "offer_not_found" });
      }

      const makerWalletId = typeof offer.makerWalletId === "string" ? offer.makerWalletId.trim() : "";
      if (makerWalletId !== active.id) {
        return res.status(403).json({ ok: false, reason: "offer_not_owned_by_active_wallet" });
      }

      if (String(offer.state || "").trim() !== "open") {
        return res.status(409).json({ ok: false, reason: "offer_not_open" });
      }

      const nowIso = new Date().toISOString();
      offer.state = "expired";
      offer.expiresAt = nowIso;

      writeOffersStore(repoRoot, storeO);

      return res.json({
        ok: true,
        offerId,
        state: offer.state,
        expiresAt: offer.expiresAt,
        active_wallet_id: active.id
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "swap_offer_expire_failed", error: String(err) });
    }
  });
  
  app.post("/api/swaps/offer", async (req, res) => {
    let rpc: RpcClient | null = null;
    let stage = "start";
    const rid = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  
    try {
      await ensureKaspaReady(repoRoot);
  
      stage = "parse_body";
      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }
  
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
        return res.status(400).json({ ok: false, reason: "invalid_kind" });
      }
  
      const tokenIdRaw = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
      const parsedToken = (() => {
        if (kind === "tick_to_kas") {
          const t = tokenIdRaw ? tokenIdRaw.trim().toUpperCase() : "";
          if (!t || !/^[A-Za-z0-9]{1,16}$/.test(t)) return { tick: "", caHex: "" };
          return { tick: t, caHex: "" };
        }
  
        const raw = tokenIdRaw ? tokenIdRaw.trim() : "";
        const h = /^CA:/i.test(raw) ? raw.slice(3).trim() : raw;
        const caHex = h.toLowerCase();
        if (!caHex || !/^[0-9a-f]{64}$/.test(caHex)) return { tick: "", caHex: "" };
        return { tick: "", caHex };
      })();
  
      const tick = parsedToken.tick;
      const caHex = parsedToken.caHex;
      const tickLc = tick ? tick.toLowerCase() : "";
  
      if (kind === "tick_to_kas") {
        if (!tickLc) return res.status(400).json({ ok: false, reason: "invalid_tokenId" });
      } else {
        if (!caHex) return res.status(400).json({ ok: false, reason: "invalid_tokenId" });
      }
  
      const tokenIdOut = kind === "tick_to_kas" ? tickLc : `CA:${caHex}`;
      const tokenName =
        kind === "ca_to_kas" && typeof body.tokenName === "string"
          ? body.tokenName.trim().slice(0, 128)
          : "";
  
      const amtStr =
        typeof body.amt === "string" || typeof body.amt === "number"
          ? String(body.amt).trim()
          : "";
      if (!isPositiveAmountString(amtStr)) {
        return res.status(400).json({ ok: false, reason: "invalid_amt" });
      }
  
      const priceKasRaw =
        typeof body.priceKas === "string" || typeof body.priceKas === "number"
          ? String(body.priceKas).trim()
          : "";
  
      const priceKasStr0 = priceKasRaw.startsWith(".") ? `0${priceKasRaw}` : priceKasRaw;
      const priceKasStr = priceKasStr0.endsWith(".") ? priceKasStr0.slice(0, -1) : priceKasStr0;
  
      const kasToSompiStrict = (human: string): bigint | null => {
        const raw = String(human || "").trim();
        if (!raw) return null;
        if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  
        const parts = raw.split(".");
        const whole = parts[0] || "0";
        const frac = parts.length > 1 ? (parts[1] || "") : "";
  
        if (frac.length > 8) return null;
  
        const fracPadded = frac.padEnd(8, "0");
        const combined = `${whole}${fracPadded}`;
        return BigInt(combined);
      };
  
      const priceSompi = kasToSompiStrict(priceKasStr);
      if (priceSompi === null || priceSompi <= 0n) {
        return res.status(400).json({ ok: false, reason: "invalid_priceKas" });
      }
  
      const takerTokenReceiveAddress =
        typeof body.takerTokenReceiveAddress === "string" ? body.takerTokenReceiveAddress.trim() : "";
      const makerReceiveAddress =
        typeof body.makerReceiveAddress === "string" ? body.makerReceiveAddress.trim() : "";
      const complianceOnly = (() => {
        if (kind !== "ca_to_kas") return false;
        if (!/^[0-9a-f]{64}$/.test(caHex)) return false;
        try {
          const cfg = getAppConfig(repoRoot);
          const gates = cnRecipientGatesFromPolicy(cfg);
          return Array.isArray(gates.regulated_cas) && gates.regulated_cas.includes(caHex);
        } catch {
          return false;
        }
      })();
  
      if (takerTokenReceiveAddress && !/^(kaspa:|kaspatest:)/.test(takerTokenReceiveAddress)) {
        return res.status(400).json({ ok: false, reason: "invalid_takerTokenReceiveAddress" });
      }
      if (!makerReceiveAddress || !/^(kaspa:|kaspatest:)/.test(makerReceiveAddress)) {
        return res.status(400).json({ ok: false, reason: "invalid_makerReceiveAddress" });
      }
  
      const expiry =
        typeof body.expiry === "number" && Number.isFinite(body.expiry) ? Math.floor(body.expiry) : 0;

      const reqStage = typeof body.stage === "string" ? body.stage.trim() : "";

      const offerRid = typeof body.offerRid === "string" ? body.offerRid.trim() : "";
      const isPrepare = reqStage === "prepare";
      const isCommitSubmit = reqStage === "commit_submit";
      const isRevealSubmit = reqStage === "reveal_submit";
      const isBcwMakerSubmit = reqStage === "bcw_maker_submit";
      if (!isPrepare && !isCommitSubmit && !isRevealSubmit && !isBcwMakerSubmit) {
        return res.status(400).json({ ok: false, reason: "invalid_stage" });
      }

      if (!isPrepare && !offerRid) {
        return res.status(400).json({ ok: false, reason: "missing_offerRid" });
      }

      if (isPrepare && offerRid) {
        return res.status(400).json({ ok: false, reason: "offerRid_not_allowed_on_prepare" });
      }

      let rid = offerRid;
      if (isPrepare) {
        rid = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      }

      stage = "load_wallet";
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = readWalletStore(repoRoot, userId);
      const active = store.active_id ? (store.items.find((w: any) => w.id === store.active_id) ?? null) : null;
  
      if (!active) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      }
      if (active.state !== "READY") {
        return res.status(409).json({ ok: false, reason: "wallet_not_ready" });
      }
      if (!active.address0 || typeof active.address0 !== "string" || !active.address0.trim()) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_address0" });
      }
  
      const appNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
      const expectedPrefix = `${addressPrefixFromAppNetworkKey(appNetworkKey)}:`;
      if (!makerReceiveAddress.startsWith(expectedPrefix)) {
        return res.status(400).json({ ok: false, reason: "invalid_makerReceiveAddress_network" });
      }
      if (takerTokenReceiveAddress && !takerTokenReceiveAddress.startsWith(expectedPrefix)) {
        return res.status(400).json({ ok: false, reason: "invalid_takerTokenReceiveAddress_network" });
      }
  
      const isComplianceWallet = active.wallet_type === "compliance";
      const isBcwBrokerCustody = isComplianceWallet && active.custody_model === "broker_1of1";

      const brokerCustodyKeyRef =
        isBcwBrokerCustody && typeof active.broker_custody_key_ref === "string"
          ? active.broker_custody_key_ref.trim()
          : "";
      const userAuthPubkey =
        isBcwBrokerCustody && typeof active.user_auth_pubkey === "string"
          ? active.user_auth_pubkey.trim()
          : "";

      if (isBcwBrokerCustody && !brokerCustodyKeyRef) {
        return res.status(409).json({ ok: false, reason: "bcw_broker_custody_key_ref_missing" });
      }
      if (isBcwBrokerCustody && !userAuthPubkey) {
        return res.status(409).json({ ok: false, reason: "bcw_user_auth_pubkey_missing" });
      }
  
      stage = "require_user_pubkey";
      let userPubXOnly: any = null;
      const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
      let kasplexSenderAddress = active.address0.trim();

      if (!isBcwBrokerCustody) {
        if (!active.user_pubkey || typeof active.user_pubkey !== "string" || !active.user_pubkey.trim()) {
          return res.status(409).json({ ok: false, reason: "wallet_missing_user_pubkey" });
        }

        const userPub = new PublicKey(active.user_pubkey);
        userPubXOnly = userPub.toXOnlyPublicKey();

        const kasplexSenderAddrObj = createAddress(userPub, networkId);
        kasplexSenderAddress = kasplexSenderAddrObj ? kasplexSenderAddrObj.toString() : "";
        if (!kasplexSenderAddress) {
          return res.status(500).json({ ok: false, reason: "krc20_sender_address_failed" });
        }
      }

      rpc = await getSharedRpc(networkId);
  
      stage = "fee_estimate";
      const fee = await rpc.getFeeEstimate();
      const rawFeeRate =
        fee &&
        fee.estimate &&
        Array.isArray(fee.estimate.normalBuckets) &&
        fee.estimate.normalBuckets.length > 0 &&
        typeof fee.estimate.normalBuckets[0].feerate === "number"
          ? fee.estimate.normalBuckets[0].feerate
          : 0;
  
      if (!rawFeeRate || rawFeeRate <= 0) {
        return res.status(502).json({ ok: false, reason: "fee_rate_unavailable" });
      }

      const feeRate = applyKrc20ToccataFeeRateFloor(appNetworkKey, rawFeeRate);
  
      // Build kasplex redeem script with KRC-20 transfer payload.
      // If takerTokenReceiveAddress is present, this becomes a directed offer (transfer.to is fixed).
      // takerTokenReceiveAddress optional (for open offers): if missing, this is an open offer (no transfer.to at offer time).
      stage = "build_redeem";
  
      // Convert human token amount -> base units using decimals from Kasplex holdings (canonical for this wallet).
      // Example (dec=8): "1000" -> "100000000000"
      const kasplexNetwork = kasplexNetworkIdFromAppNetworkKey(appNetworkKey);
      const holdings = await kasplexGetAddressTokenList(kasplexNetwork, kasplexSenderAddress);
  
      let tokenDec: number | null = null;
      if (kind === "tick_to_kas") {
        tokenDec =
          holdings && holdings.token_dec && Object.prototype.hasOwnProperty.call(holdings.token_dec, tick)
            ? (holdings.token_dec as any)[tick]
            : null;
      } else {
        const normalizeCA = (s: string): string => {
          const raw = String(s || "").trim();
          const h = /^CA:/i.test(raw) ? raw.slice(3).trim() : raw;
          return h.toLowerCase();
        };
        const hit = Array.isArray(holdings && (holdings as any).issue)
          ? (holdings as any).issue.find((x: any) => normalizeCA(x && x.ca) === caHex)
          : null;
        tokenDec = hit && typeof hit.dec === "number" ? hit.dec : null;
      }
  
      if (typeof tokenDec !== "number" || !Number.isFinite(tokenDec) || tokenDec < 0 || tokenDec > 18) {
        return res.status(409).json({
          ok: false,
          reason: "krc20_sender_balance_insufficient",
          stage,
          kind,
          tick,
          ca: kind === "ca_to_kas" ? caHex : undefined,
          amt: amtStr,
          krc20_sender_address: kasplexSenderAddress,
          wallet_address0: active.address0
        });
      }
  
      const toBaseUnits = (humanIn: string, dec: number): string | null => {
        const raw = String(humanIn || "").trim();
        if (!raw) return null;
        const s = raw.startsWith(".") ? `0${raw}` : raw;
        if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  
        const parts = s.split(".");
        const whole = parts[0] || "0";
        const frac = parts.length > 1 ? parts[1] : "";
  
        if (dec === 0) {
          if (frac && !/^0+$/.test(frac)) return null;
          return BigInt(whole).toString();
        }
  
        if (frac.length > dec) return null;
        const fracPadded = frac.padEnd(dec, "0");
        const combined = `${whole}${fracPadded}`;
        return BigInt(combined).toString();
      };
  
      const amtBaseStr = toBaseUnits(amtStr, tokenDec);
      if (!amtBaseStr || amtBaseStr === "0") {
        return res.status(400).json({ ok: false, reason: "invalid_amt_precision" });
      }
  
      // Open offers disabled: require takerTokenReceiveAddress (directed swaps only).
      if (!takerTokenReceiveAddress) {
        return res.status(400).json({
          ok: false,
          reason: "taker_token_receive_address_required",
          stage: "offer_require_to_address"
        });
      }

      if (isComplianceWallet && kind === "ca_to_kas") {
        const cfg = getAppConfig(repoRoot);
        const gates = cnRecipientGatesFromPolicy(cfg);
        const regulated = Array.isArray(gates && (gates as any).regulated_cas) ? (gates as any).regulated_cas : [];

        if (regulated.includes(caHex)) {
          const allow =
            Array.isArray(gates && (gates as any).recipient_allowlist) ? (gates as any).recipient_allowlist : [];
          if (!allow.includes(takerTokenReceiveAddress)) {
            return res.status(403).json({
              ok: false,
              reason: "recipient_not_allowlisted_for_regulated_ca",
              ca: caHex,
              to: takerTokenReceiveAddress
            });
          }
        }
      }

      if (isBcwBrokerCustody) {
        const bcwNetwork = appNetworkKey === "mainnet" ? "mainnet" : "testnet";

        if (isPrepare) {
          const createdAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          const intent: BcwDirectSwapMakerIntentV1 = {
            v: 1,
            purpose: "bcw_direct_swap_maker",
            wallet_id: active.id,
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: bcwNetwork,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: active.address0.trim(),
            maker_kas_receive_address: makerReceiveAddress,
            taker_token_receive_address: takerTokenReceiveAddress,
            kind,
            tick: kind === "tick_to_kas" ? tick : "",
            ca: kind === "ca_to_kas" ? caHex : "",
            sell_amount_raw: amtBaseStr,
            buy_amount_sompi: priceSompi.toString(),
            user_auth_pubkey: userAuthPubkey,
            created_at: createdAt,
            expires_at: expiresAt,
            nonce: newBcwDirectSwapMakerNonce()
          };

          return res.json({
            ok: true,
            stage: "bcw_direct_swap_maker_intent",
            offerRid: rid,
            custody_model: "broker_1of1",
            intent,
            intent_message: canonicalBcwDirectSwapMakerIntentMessage(intent),
            makerKasReceiveAddress: makerReceiveAddress,
            takerTokenReceiveAddress,
            kind,
            tick: kind === "tick_to_kas" ? tick : "",
            ca: kind === "ca_to_kas" ? caHex : "",
            sellAmountRaw: amtBaseStr,
            buyAmountSompi: priceSompi.toString()
          });
        }

        if (isBcwMakerSubmit) {
          if (!bcwDirectSwapMakerSubmit) {
            return res.status(500).json({ ok: false, reason: "bcw_direct_swap_maker_submit_unavailable" });
          }

          const intent = normalizeBcwDirectSwapMakerIntent((body as any).bcw_direct_swap_maker_intent);
          const authSignature = typeof (body as any).bcw_auth_signature === "string"
            ? String((body as any).bcw_auth_signature).trim()
            : "";

          if (!intent) {
            return res.status(400).json({ ok: false, reason: "bcw_direct_swap_maker_intent_invalid" });
          }
          if (!authSignature) {
            return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required" });
          }

          if (intent.wallet_id !== active.id) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_wallet_id_mismatch" });
          }
          if (intent.wallet_type !== "compliance" || intent.custody_model !== "broker_1of1") {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_custody_model_mismatch" });
          }
          if (intent.network !== bcwNetwork) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_network_mismatch" });
          }
          if (intent.broker_custody_key_ref !== brokerCustodyKeyRef) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_key_ref_mismatch" });
          }
          if (intent.from_address !== active.address0.trim()) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_from_address_mismatch" });
          }
          if (intent.maker_kas_receive_address !== makerReceiveAddress) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_receive_address_mismatch" });
          }
          if (intent.taker_token_receive_address !== takerTokenReceiveAddress) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_taker_address_mismatch" });
          }
          if (intent.kind !== kind) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_kind_mismatch" });
          }
          if (intent.tick !== (kind === "tick_to_kas" ? tick : "")) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_tick_mismatch" });
          }
          if (intent.ca !== (kind === "ca_to_kas" ? caHex : "")) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_ca_mismatch" });
          }
          if (intent.sell_amount_raw !== amtBaseStr) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_sell_amount_mismatch" });
          }
          if (intent.buy_amount_sompi !== priceSompi.toString()) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_buy_amount_mismatch" });
          }
          if (intent.user_auth_pubkey !== userAuthPubkey) {
            return res.status(409).json({ ok: false, reason: "bcw_direct_swap_maker_auth_pubkey_mismatch" });
          }

          const cn = await bcwDirectSwapMakerSubmit({
            repoRootPath: repoRoot,
            intent,
            authSignature
          });

          if (!cn.ok || !cn.data || cn.data.ok !== true) {
            return res.status(cn.status || 502).json({
              ok: false,
              reason: "bcw_direct_swap_maker_cn_rejected",
              cn
            });
          }

          const makerPskb = typeof cn.data.makerPskb === "string"
            ? cn.data.makerPskb.trim()
            : (typeof cn.data.swapPskb === "string" ? cn.data.swapPskb.trim() : "");
          const p2shAddress = typeof cn.data.swapP2shAddress === "string"
            ? cn.data.swapP2shAddress.trim()
            : (typeof cn.data.p2shAddress === "string" ? cn.data.p2shAddress.trim() : "");
          const commitTxids = Array.isArray(cn.data.swapCommitTxids)
            ? cn.data.swapCommitTxids.map((x: any) => String(x || "").trim()).filter(Boolean)
            : (Array.isArray(cn.data.commitTxids) ? cn.data.commitTxids.map((x: any) => String(x || "").trim()).filter(Boolean) : []);

          if (!makerPskb) {
            return res.status(502).json({ ok: false, reason: "bcw_direct_swap_maker_pskb_missing", cn });
          }
          if (!p2shAddress) {
            return res.status(502).json({ ok: false, reason: "bcw_direct_swap_maker_p2sh_missing", cn });
          }
          if (!commitTxids.length) {
            return res.status(502).json({ ok: false, reason: "bcw_direct_swap_maker_commit_txids_missing", cn });
          }

          stage = "bcw_direct_maker_offer_validate";
          const v = await validateSwapPskb(repoRoot, { phase: "offer", kind, pskb: makerPskb });
          if (!v.ok) {
            return res.status(500).json({
              ok: false,
              reason: "bcw_direct_swap_maker_validation_failed",
              stage,
              errors: v.errors,
              warnings: v.warnings
            });
          }

          stage = "bcw_direct_maker_offer_persist";
          const ttlSec = expiry > 0 ? expiry : 0;
          const nowIso = new Date().toISOString();
          const expiresIso = ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
          const offerId = rid.replace(/[^a-z0-9]/gi, "").slice(0, 32);

          const record: any = {
            offerId,
            createdAt: nowIso,
            state: "open",
            ttl: ttlSec,
            expiresAt: expiresIso,

            sell: { type: "KAS", symbol: "KAS" },
            buy: { type: "KRC20", symbol: kind === "tick_to_kas" ? `TICK:${tick}` : `CA:${caHex}`, name: tokenName },

            sellAmount: priceKasStr,
            buyAmount: amtStr,

            price: "",
            partial: { enabled: false },
            complianceOnly,

            networkId,

            makerWalletId: active.id,
            makerReceiveAddress,

            tokenId: tokenIdOut,
            tick: kind === "tick_to_kas" ? tick : "",
            ca: kind === "ca_to_kas" ? caHex : "",
            tokenAmount: amtStr,
            priceKas: priceKasStr,

            swapKind: kind,
            swapPskb: makerPskb,
            swapP2shAddress: p2shAddress,
            swapCommitTxids: commitTxids,
            takerTokenReceiveAddress,
            custodyModel: "broker_1of1"
          };

          const storeO = readOffersStore(repoRoot);
          const existing = storeO.items.find((o: any) => o && o.offerId === offerId) ?? null;
          if (!existing) storeO.items.push(record);
          writeOffersStore(repoRoot, storeO);

          queueUserNotification(
            repoRoot,
            userId,
            "maker_offer_created",
            "Token Depot — Maker offer created",
            [
              "A direct maker offer was created.",
              "",
              `Offer ID: ${offerId}`,
              `Network: ${networkId}`,
              `Kind: ${kind}`,
              `Token: ${tokenIdOut}`,
              `Amount (RAW): ${amtStr}`,
              `Price (KAS): ${priceKasStr}`,
              `Directed wallet: ${takerTokenReceiveAddress}`
            ].join("\n")
          );

          const directedUserId = findUserIdByWalletAddress(repoRoot, networkId, takerTokenReceiveAddress);
          if (directedUserId) {
            queueUserNotification(
              repoRoot,
              directedUserId,
              "new_offers",
              "Token Depot — New direct offer",
              [
                "A new direct offer is available for one of your wallets.",
                "",
                `Offer ID: ${offerId}`,
                `Network: ${networkId}`,
                `Kind: ${kind}`,
                `Token: ${tokenIdOut}`,
                `Amount (RAW): ${amtStr}`,
                `Price (KAS): ${priceKasStr}`,
                `Directed wallet: ${takerTokenReceiveAddress}`
              ].join("\n")
            );
          }

          return res.json({
            ok: true,
            stage: "bcw_direct_swap_maker_submit",
            offerId,
            network: networkId,
            kind,
            tokenId: tokenIdOut,
            amt: amtStr,
            priceKas: priceKasStr,
            makerReceiveAddress,
            takerTokenReceiveAddress,
            complianceOnly,
            expiry: ttlSec || null,
            pskb: makerPskb,
            p2shAddress,
            commitTxids,
            cn: cn.data
          });
        }

        return res.status(400).json({ ok: false, reason: "invalid_bcw_direct_swap_maker_stage" });
      }

      if (isComplianceWallet) {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_direct_swap_maker_removed",
          error: "Legacy 2-of-2 Compliance Wallet direct maker has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
  
      const payloadJson =
        kind === "ca_to_kas"
          ? JSON.stringify({ p: "krc-20", op: "transfer", ca: caHex, amt: amtBaseStr, to: takerTokenReceiveAddress })
          : JSON.stringify({ p: "krc-20", op: "transfer", tick, amt: amtBaseStr, to: takerTokenReceiveAddress });
  
      const redeem = new ScriptBuilder()
        .addData(userPubXOnly.toString())
        .addOp(Opcodes.OpCheckSig)
        .addOp(Opcodes.OpFalse)
        .addOp(Opcodes.OpIf)
        .addData(Buffer.from("kasplex"))
        .addI64(0n)
        .addData(Buffer.from(payloadJson))
        .addOp(Opcodes.OpEndIf);

      const redeemScriptHex = redeem.toString();

      const p2shAddrObj = addressFromScriptPublicKey(redeem.createPayToScriptHashScript(), networkId);
      const p2shAddress = p2shAddrObj ? p2shAddrObj.toString() : "";
      if (!p2shAddress) {
        return res.status(500).json({ ok: false, reason: "p2sh_address_failed" });
      }
  
      // Commit: fund the kasplex P2SH output and submit
      stage = "commit_create";
      const commitAmountSompi = kaspaToSompi("0.34");
      if (commitAmountSompi === undefined || commitAmountSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "invalid_commit_amount" });
      }
  
      const ownerUtxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
      const ownerEntries = ownerUtxos.entries;
      if (!ownerEntries || ownerEntries.length === 0) {
        return res.status(409).json({ ok: false, reason: "no_utxos" });
      }

      let commitPtxs: any[] = [];

    // rid is defined earlier based on request stage (prepare generates, other stages use offerRid)

      if (isPrepare) {
        stage = "commit_build";

        const outputs: any[] = [{ address: p2shAddress, amount: commitAmountSompi }];

        const commitEntries: any[] = ownerEntries;

        const txOpts: any = {
          outputs,
          changeAddress: active.address0,
          feeRate,
          priorityFee: { amount: 0n, source: FeeSource.SenderPays },
          entries: commitEntries,
          networkId
        };

        let commitCreated: any = null;
        try {
          commitCreated = await createTransactions(txOpts);
        } catch (e: any) {
          const msg = e && typeof e.message === "string" ? e.message : String(e);
          if (msg.includes("Storage mass exceeds maximum")) {
            return res.status(409).json({
              ok: false,
              reason: "commit_build_mass_exceeds_maximum",
              stage,
              utxoCount: ownerEntries.length
            });
          }
          throw e;
        }

        if (!commitCreated.transactions || commitCreated.transactions.length < 1) {
          return res.status(500).json({ ok: false, reason: "unexpected_commit_batch", stage });
        }

        commitPtxs = commitCreated.transactions;

        sweepSwapOfferPrepCache(Date.now());
        swapOfferPrepCache.set(rid, {
          createdAtMs: Date.now(),
          networkId,
          feeRate,

          userId,
          walletId: active.id,
          address0: active.address0,
          userPubkey: active.user_pubkey,

          commitPtxs,
          commitAmountSompi,
          p2shAddress,
          redeemScriptHex,

          kind,
          makerTokenTick: tokenIdOut,
          makerTokenAmtRaw: BigInt(amtBaseStr),
          makerKasReceiveAddress: makerReceiveAddress,
          takerTokenReceiveAddress,
          expiry
        });

        const unsignedCommit = commitPtxs.map((ptx: any) => ({
          tx: ptx.serializeToSafeJSON(),
          inputCount: ptx.getUtxoEntries().length
        }));

        const out: any = {
          ok: true,
          stage: "prepare",
          offerRid: rid,
          unsignedCommit,
          p2shAddress,
          redeemScriptHex,
          commitAmountSompi: commitAmountSompi.toString()
        };

        return res.json(out);
      }

      stage = "offerRid_cache_load";
      sweepSwapOfferPrepCache(Date.now());
      const cached = swapOfferPrepCache.get(rid) || null;
      if (!cached) {
        return res.status(409).json({ ok: false, reason: "offerRid_not_found", stage });
      }
      if (cached.userId !== userId) {
        return res.status(403).json({ ok: false, reason: "offerRid_wrong_user", stage });
      }
      if (cached.walletId !== active.id) {
        return res.status(409).json({ ok: false, reason: "offerRid_wrong_wallet", stage });
      }

      commitPtxs = cached.commitPtxs;

      stage = "commit_submit";
      const commitTxids: string[] = [];

      if (!isCommitSubmit) {
        if (!cached.commitTxids || !cached.txToSignSafeJson) {
          return res.status(409).json({ ok: false, reason: "offerRid_not_committed", stage });
        }
        for (const txid of cached.commitTxids) commitTxids.push(txid);
      } else {
        const commitInputSigs = Array.isArray(body.commitInputSigs) ? body.commitInputSigs : null;
        if (!commitInputSigs) {
          return res.status(400).json({ ok: false, reason: "invalid_commitInputSigs", stage });
        }
        if (commitInputSigs.length !== commitPtxs.length) {
          return res.status(400).json({ ok: false, reason: "commitInputSigs_wrong_length", stage });
        }

        for (let ti = 0; ti < commitPtxs.length; ti++) {
          const ptx = commitPtxs[ti];
          const utxoEntries = ptx.getUtxoEntries();
          const sigs = commitInputSigs[ti];

          if (!Array.isArray(sigs) || sigs.length !== utxoEntries.length) {
            return res.status(400).json({ ok: false, reason: "commitInputSigs_wrong_input_count", stage });
          }

          for (let i = 0; i < utxoEntries.length; i++) {
            const sigScriptHex = sigs[i];
            if (typeof sigScriptHex !== "string" || !sigScriptHex.trim()) {
              return res.status(400).json({ ok: false, reason: "commitInputSig_invalid", stage });
            }
            ptx.fillInput(i, sigScriptHex);
          }

          const txid = await ptx.submit(rpc);

          commitTxids.push(txid);
        }
      }
  
      if (isCommitSubmit) {
        cached.commitTxids = commitTxids;
      }

      // Wait for the matching P2SH UTXO (no fallbacks to random UTXOs)
      stage = "p2sh_wait";
      const startMs = Date.now();
      const deadlineMs = startMs + 120000;
      const wanted = new Set(commitTxids);
  
      let commitEntry: any = null;
  
      while (Date.now() < deadlineMs) {
        try {
          const p2sh = await rpc.getUtxosByAddresses({ addresses: [p2shAddress] });
          const list = p2sh && Array.isArray(p2sh.entries) ? p2sh.entries : [];
          const match = list.find((e: any) => {
            const tid = e && e.outpoint ? e.outpoint.transactionId : "";
            return tid && wanted.has(tid);
          });
          commitEntry = match || null;
        } catch {
          commitEntry = null;
        }
  
        if (commitEntry) break;
        await sleepMs(500);
      }
  
      if (!commitEntry) {
        return res.status(504).json({ ok: false, reason: "p2sh_commit_utxo_timeout" });
      }
  
      // Build reveal PSKT skeleton from the commit UTXO, then rewrite output0 to the maker settlement output.
      stage = "reveal_build";
      console.log(`[swap_offer] stage=${stage}`);
      const revealCreated = await createTransactions({
        priorityEntries: [commitEntry],
        entries: [],
        changeAddress: active.address0,
        outputs: [],
        feeRate,
        priorityFee: 0n,
        networkId
      });
      console.log(`[swap_offer] stage=${stage} ok`);
  
      if (!revealCreated.transactions || revealCreated.transactions.length !== 1) {
        return res.status(500).json({ ok: false, reason: "unexpected_reveal_batch" });
      }
  
      const reveal0 = revealCreated.transactions[0];
  
      const wantedTxid = String(commitEntry?.outpoint?.transactionId || "");
      const wantedIdx = Number(commitEntry?.outpoint?.index ?? -1);
  
      const inputIndex0 = reveal0.transaction.inputs.findIndex((input: any) => {
        const op = input && input.previousOutpoint ? input.previousOutpoint : null;
        const tid = op && typeof op.transactionId === "string" ? op.transactionId : "";
        const idx = op && typeof op.index === "number" ? op.index : -1;
        return tid === wantedTxid && idx === wantedIdx;
      });
  
      if (inputIndex0 !== 0) {
        return res.status(500).json({ ok: false, reason: "p2sh_input_not_input0" });
      }
  
      const commitAmtAny: any = (commitEntry as any)?.utxoEntry?.amount ?? (commitEntry as any)?.amount ?? 0n;
      const commitAmtSompi =
        typeof commitAmtAny === "bigint" ? commitAmtAny : BigInt(commitAmtAny);
  
      const makerOutSompi = commitAmtSompi + priceSompi;
    
      stage = "reveal_set_output0";
      const revealTxOut0 = reveal0.transaction.outputs[0];
      if (!revealTxOut0) throw new Error("maker_reveal_output0_missing");
      revealTxOut0.value = makerOutSompi;
      revealTxOut0.scriptPublicKey = payToAddressScript(makerReceiveAddress);
  
      // Maker signs input0 against output0: SIGHASH_SINGLE|ANYONECANPAY
      let input0SigScriptHex: string = "";
  
      stage = "reveal_sign_input0";
      console.log(`[swap_offer] stage=${stage}`);
  
      console.log(`[swap_offer] stage=${stage} ok`);
  
      // Do NOT finalize the maker reveal skeleton here.
      // finalize() would rebalance outputs using only the commit input and would mutate output0,
      // invalidating the maker's SIGHASH_SINGLE|ANYONECANPAY signature. The taker funds price/fees.
      stage = "reveal_finalize";
  
      stage = "pskt_role_creator";
      let pskt = new PSKT(undefined);
  
      stage = "pskt_set_flags";
      pskt = pskt.inputsModifiable();
      pskt = pskt.outputsModifiable();
      const f3aSer = pskt.serialize();
      let f3aObj: any = null;
      try { f3aObj = JSON.parse(f3aSer); } catch {}
      const f3aTopKeys = f3aObj ? Object.keys(f3aObj).join(",") : "parse_fail";
      const f3aPayload: any = f3aObj?.payload ?? null;
      const f3aPayloadKeys = f3aPayload ? Object.keys(f3aPayload).join(",") : "null";
      const f3aGlobal: any = f3aPayload?.global ?? null;
      const f3aGlobalKeys = f3aGlobal ? Object.keys(f3aGlobal).join(",") : "null";
      const f3aIn0: any = Array.isArray(f3aPayload?.inputs) ? f3aPayload.inputs[0] : null;
      const f3aIn0Keys = f3aIn0 ? Object.keys(f3aIn0).join(",") : "null";
      console.log(`[swap_offer] F3 after_set_flags role=${pskt.role} topKeys=${f3aTopKeys} payloadKeys=${f3aPayloadKeys} globalKeys=${f3aGlobalKeys} in0Keys=${f3aIn0Keys} inMod=${f3aGlobal?.inputsModifiable} outMod=${f3aGlobal?.outputsModifiable} sh0=${f3aIn0?.sighashType}`);
      console.log(`[swap_offer] F3 after_set_flags global=`, f3aGlobal);
  
      stage = "pskt_role_constructor";
      pskt = pskt.toConstructor();
      const f3bSer = pskt.serialize();
      let f3bObj: any = null;
      try { f3bObj = JSON.parse(f3bSer); } catch {}
      const f3bTopKeys = f3bObj ? Object.keys(f3bObj).join(",") : "parse_fail";
      const f3bPayload: any = f3bObj?.payload ?? null;
      const f3bPayloadKeys = f3bPayload ? Object.keys(f3bPayload).join(",") : "null";
      const f3bGlobal: any = f3bPayload?.global ?? null;
      const f3bGlobalKeys = f3bGlobal ? Object.keys(f3bGlobal).join(",") : "null";
      const f3bIn0: any = Array.isArray(f3bPayload?.inputs) ? f3bPayload.inputs[0] : null;
      const f3bIn0Keys = f3bIn0 ? Object.keys(f3bIn0).join(",") : "null";
      console.log(`[swap_offer] F3 after_toConstructor role=${pskt.role} topKeys=${f3bTopKeys} payloadKeys=${f3bPayloadKeys} globalKeys=${f3bGlobalKeys} in0Keys=${f3bIn0Keys} inMod=${f3bGlobal?.inputsModifiable} outMod=${f3bGlobal?.outputsModifiable} sh0=${f3bIn0?.sighashType}`);
      console.log(`[swap_offer] F3 after_toConstructor global=`, f3bGlobal);
  
      stage = "pskt_add_input0";
      console.log(`[swap_offer] stage=${stage}`);
      const input0: any = (reveal0.transaction as any).inputs?.[0];
      const rsType = typeof (redeemScriptHex as any);
      const rs = rsType === "string" ? (redeemScriptHex as any as string) : String(redeemScriptHex as any);
      const rsLen = rsType === "string" ? rs.length : -1;
      const rsIsHex = rsType === "string" && rs.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(rs);
      const input0Keys = input0 && typeof input0 === "object" ? Object.keys(input0) : [];
      console.log(`[swap_offer] F1 pskt_add_input0 redeemScriptHex type=${rsType} len=${rsLen} isHex=${rsIsHex} prefix=${rs.slice(0, 32)}`);
      console.log(`[swap_offer] F1 pskt_add_input0 input0 type=${typeof input0} keys=${input0Keys.join(",")} hasUtxo=${!!(input0 && input0.utxo)} hasUtxoEntry=${!!(input0 && input0.utxoEntry)}`);
      const op0 = input0.previousOutpoint;
  
      stage = "tx_sign_input0_psktshape";
      console.log(`[swap_offer] stage=${stage}`);
  
      const bytesToHex = (v: any): string => {
        if (typeof v === "string") {
          const s = v.trim();
          if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
          return "";
        }
        try {
          if (v && typeof v === "object") {
            if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
            if (Array.isArray(v)) return Buffer.from(v).toString("hex");
          }
        } catch {}
        return "";
      };
  
      const spkToHex = (spk: any): string => {
        if (!spk) return "";
        if (typeof spk === "string") return bytesToHex(spk);
        try {
          if (typeof (spk as any).toJSON === "function") spk = (spk as any).toJSON();
        } catch {}
        const v = spk && typeof spk === "object" ? (spk as any).version : undefined;
        const s = spk && typeof spk === "object" ? (spk as any).script : undefined;
        const sHex = bytesToHex(s);
        if (typeof v !== "number" || !sHex) return "";
        const vHex = (v >>> 0).toString(16).padStart(4, "0");
        const spkHex = (vHex + sHex).toLowerCase();
        if (!/^[0-9a-f]+$/.test(spkHex) || spkHex.length % 2 !== 0) return "";
        return spkHex;
      };
  
      const op0TxidHex = bytesToHex((op0 as any).transactionId);
      if (!op0TxidHex) throw new Error("commit_outpoint_txid_invalid");
      const op0ForTx: any = { transactionId: op0TxidHex, index: Number((op0 as any).index) };
  
      const utxo0Any: any = commitEntry || null;
      if (!utxo0Any) throw new Error("commit_utxo_missing");
  
      const utxo0SpkHex = spkToHex((utxo0Any as any).scriptPublicKey);
      if (!utxo0SpkHex) throw new Error("commit_utxo_scriptPublicKey_invalid");
  
      const outSpkHex = spkToHex(payToAddressScript(makerReceiveAddress));
      if (!outSpkHex) throw new Error("maker_output_scriptPublicKey_invalid");

      let makerAnchorOpForTx: any = null;
      let makerAnchorUtxo: any = null;
      let makerAnchorAmtSompi = 0n;
      let makerAnchorOutSpkHex = "";

      if (isComplianceWallet) {
        stage = "fetch_maker_anchor_utxo";

        const cachedAnchor: any =
          cached && typeof cached === "object" ? (cached as any).makerAnchorOutpoint : null;

        const makerUtxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
        const makerEntries: any[] =
          makerUtxos && Array.isArray((makerUtxos as any).entries) ? (makerUtxos as any).entries : [];

        if (!makerEntries.length) {
          return res.status(409).json({ ok: false, reason: "maker_anchor_utxo_not_found", stage });
        }

        let anchorEntry: any = null;

        if (cachedAnchor && typeof cachedAnchor.transactionId === "string") {
          const wantTxid = String(cachedAnchor.transactionId);
          const wantIdx = Number(cachedAnchor.index);

          anchorEntry = makerEntries.find((e: any) => {
            const op: any = e && typeof e === "object" ? (e as any).outpoint : null;
            const txid = op && typeof op.transactionId === "string" ? String(op.transactionId) : "";
            const idx = op && (typeof op.index === "number" || typeof op.index === "string") ? Number(op.index) : NaN;
            return !!txid && txid === wantTxid && Number.isFinite(idx) && idx === wantIdx;
          });

          if (!anchorEntry) {
            return res.status(409).json({ ok: false, reason: "maker_anchor_utxo_not_found", stage });
          }
        } else {
          const sorted = makerEntries.slice().sort((a: any, b: any) => {
            const aa: any = a && typeof a === "object" ? (a as any).amount ?? (a as any).value : undefined;
            const bb: any = b && typeof b === "object" ? (b as any).amount ?? (b as any).value : undefined;

            let aAmt = 0n;
            let bAmt = 0n;

            try { aAmt = typeof aa === "bigint" ? aa : BigInt(String(aa)); } catch {}
            try { bAmt = typeof bb === "bigint" ? bb : BigInt(String(bb)); } catch {}

            if (aAmt < bAmt) return -1;
            if (aAmt > bAmt) return 1;

            const aOp: any = a && typeof a === "object" ? (a as any).outpoint : null;
            const bOp: any = b && typeof b === "object" ? (b as any).outpoint : null;

            const aTxid = aOp && typeof aOp.transactionId === "string" ? String(aOp.transactionId) : "";
            const bTxid = bOp && typeof bOp.transactionId === "string" ? String(bOp.transactionId) : "";
            if (aTxid < bTxid) return -1;
            if (aTxid > bTxid) return 1;

            const aIdx = aOp && (typeof aOp.index === "number" || typeof aOp.index === "string") ? Number(aOp.index) : 0;
            const bIdx = bOp && (typeof bOp.index === "number" || typeof bOp.index === "string") ? Number(bOp.index) : 0;
            return aIdx - bIdx;
          });

          anchorEntry = sorted[0];
          const op: any = anchorEntry && typeof anchorEntry === "object" ? (anchorEntry as any).outpoint : null;
          if (!op || typeof op.transactionId !== "string") {
            return res.status(500).json({ ok: false, reason: "maker_anchor_utxo_outpoint_invalid", stage });
          }

          (cached as any).makerAnchorOutpoint = { transactionId: String(op.transactionId), index: Number(op.index) };
        }

        const anchorOp: any = anchorEntry && typeof anchorEntry === "object" ? (anchorEntry as any).outpoint : null;
        if (!anchorOp || typeof anchorOp.transactionId !== "string") {
          return res.status(500).json({ ok: false, reason: "maker_anchor_utxo_outpoint_invalid", stage });
        }

        makerAnchorOpForTx = { transactionId: String(anchorOp.transactionId), index: Number(anchorOp.index) };

        const uAnchor: any =
          anchorEntry && typeof anchorEntry === "object"
            ? ((anchorEntry as any).utxoEntry ?? (anchorEntry as any).utxo ?? null)
            : null;

        const anchorAmtAny: any = uAnchor
          ? (uAnchor as any).amount
          : anchorEntry && typeof anchorEntry === "object"
            ? ((anchorEntry as any).amount ?? (anchorEntry as any).value)
            : undefined;

        if (anchorAmtAny === undefined || anchorAmtAny === null) {
          return res.status(500).json({ ok: false, reason: "maker_anchor_utxo_amount_invalid", stage });
        }

        try {
          makerAnchorAmtSompi = typeof anchorAmtAny === "bigint" ? anchorAmtAny : BigInt(String(anchorAmtAny));
        } catch {
          return res.status(500).json({ ok: false, reason: "maker_anchor_utxo_amount_invalid", stage });
        }

        const spkAny: any = uAnchor
          ? (uAnchor as any).scriptPublicKey
          : anchorEntry && typeof anchorEntry === "object"
            ? (anchorEntry as any).scriptPublicKey
            : null;

        if (!spkAny) {
          return res.status(500).json({ ok: false, reason: "maker_anchor_utxo_scriptPublicKey_invalid", stage });
        }

        const bdsAny: any = uAnchor
          ? (uAnchor as any).blockDaaScore
          : anchorEntry && typeof anchorEntry === "object"
            ? (anchorEntry as any).blockDaaScore
            : undefined;

        const bdsNum =
          typeof bdsAny === "number" ? bdsAny : Number(typeof bdsAny === "bigint" ? bdsAny.toString() : String(bdsAny));

        if (!Number.isFinite(bdsNum)) {
          const entryKeys = anchorEntry && typeof anchorEntry === "object" ? Object.keys(anchorEntry).join(",") : "null";
          const utxoKeys = uAnchor && typeof uAnchor === "object" ? Object.keys(uAnchor).join(",") : "null";
          return res.status(500).json({
            ok: false,
            reason: "maker_anchor_utxo_blockDaaScore_invalid",
            stage,
            entryKeys,
            utxoKeys
          });
        }

        const isCoinbaseAny: any = uAnchor
          ? (uAnchor as any).isCoinbase
          : anchorEntry && typeof anchorEntry === "object"
            ? (anchorEntry as any).isCoinbase
            : undefined;

        makerAnchorUtxo = {
          outpoint: makerAnchorOpForTx,
          amount: makerAnchorAmtSompi,
          scriptPublicKey: spkAny,
          blockDaaScore: bdsNum,
          isCoinbase: isCoinbaseAny
        };

        makerAnchorOutSpkHex = spkToHex(payToAddressScript(active.address0));
        if (!makerAnchorOutSpkHex) throw new Error("maker_anchor_output_scriptPublicKey_invalid");

        (cached as any).makerAnchorAmtSompi = makerAnchorAmtSompi.toString();
        (cached as any).makerAnchorOutSpkHex = makerAnchorOutSpkHex;
      }
  
      const txToSignTxObj: any = {
        version: (reveal0.transaction as any).version,
        lockTime: (reveal0.transaction as any).lockTime,
        subnetworkId: (reveal0.transaction as any).subnetworkId,
        gas: (reveal0.transaction as any).gas,
        payload: (reveal0.transaction as any).payload,
        inputs: [
          {
            previousOutpoint: op0ForTx,
            sequence: (reveal0.transaction as any).inputs[0].sequence,
            sigOpCount: 1,
            utxo: (input0 as any).utxo
          }
        ],
        outputs: [
          {
            value: makerOutSompi,
            scriptPublicKey: outSpkHex
          }
        ]
      };

      if (isCommitSubmit) {
        const txToSignSafeJson = new Transaction(txToSignTxObj).serializeToSafeJSON();
        cached.txToSignSafeJson = txToSignSafeJson;

        return res.json({
          ok: true,
          stage: "commit_submit",
          offerRid: rid,
          commitTxids,
          txToSignSafeJson,
          sighashType: "SingleAnyOneCanPay",
          walletType: active.wallet_type
        });
      }

      let txToSign: any;
      try {
        txToSign = new Transaction(txToSignTxObj);
      } catch (e) {
        console.log(`[swap_offer] tx_to_sign_ctor_error`, e);
        throw e;
      }
  
      stage = "parse_signature0";
      const signature0 = typeof body.signature0 === "string" ? body.signature0.trim() : "";
      if (!signature0) {
        return res.status(400).json({ ok: false, reason: "missing_signature0", stage });
      }

      const sig0 = normalizeOpCheckSigSignature64(signature0, "swap_offer.signature0");
      const sigScriptHex0 = encodePushOnlyP2shSigScript(sig0, SighashType.SingleAnyOneCanPay, redeemScriptHex);

      input0SigScriptHex = sigScriptHex0;
  
      console.log(`[swap_offer] stage=${stage} ok`);
  
      const ss0 = typeof input0SigScriptHex === "string" ? input0SigScriptHex : "";
      const ss0Ok = ss0.length > 0 && ss0.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(ss0);
      if (!ss0Ok) throw new Error("maker_input0_signatureScript_invalid");
  
      const input0ForPskt: any = {
        previousOutpoint: { transactionId: String(op0.transactionId), index: Number(op0.index) },
        signatureScript: ss0,
        sequence: input0.sequence,
        sigOpCount: input0.sigOpCount,
        sighashType: SighashType.SingleAnyOneCanPay,
        utxo: input0.utxo
      };
  
      pskt = pskt.inputAndRedeemScript(input0ForPskt, {
        redeemScript: redeemScriptHex,
        sighashType: SighashType.SingleAnyOneCanPay
      });
  
      stage = "pskt_add_output0";

      pskt = pskt.output({
        value: makerOutSompi,
        scriptPublicKey: payToAddressScript(makerReceiveAddress)
      });
  
      const f3cSer = pskt.serialize();
      let f3cObj: any = null;
      try { f3cObj = JSON.parse(f3cSer); } catch {}
      const f3cTopKeys = f3cObj ? Object.keys(f3cObj).join(",") : "parse_fail";
      const f3cPayload: any = f3cObj?.payload ?? null;
      const f3cPayloadKeys = f3cPayload ? Object.keys(f3cPayload).join(",") : "null";
      const f3cGlobal: any = f3cPayload?.global ?? null;
      const f3cGlobalKeys = f3cGlobal ? Object.keys(f3cGlobal).join(",") : "null";
      const f3cIn0: any = Array.isArray(f3cPayload?.inputs) ? f3cPayload.inputs[0] : null;
      const f3cIn0Keys = f3cIn0 ? Object.keys(f3cIn0).join(",") : "null";
      console.log(`[swap_offer] F3 after_add_outputs role=${pskt.role} topKeys=${f3cTopKeys} payloadKeys=${f3cPayloadKeys} globalKeys=${f3cGlobalKeys} in0Keys=${f3cIn0Keys} inMod=${f3cGlobal?.inputsModifiable} outMod=${f3cGlobal?.outputsModifiable} sh0=${f3cIn0?.sighashType}`);
      console.log(`[swap_offer] F3 after_add_outputs global=`, f3cGlobal);
  
      stage = "pskt_role_constructor_for_bundle";
  
      stage = "pskt_ready_for_bundle";
      const f3dSer = pskt.serialize();
      let f3dObj: any = null;
      try { f3dObj = JSON.parse(f3dSer); } catch {}
      const f3dTopKeys = f3dObj ? Object.keys(f3dObj).join(",") : "parse_fail";
      const f3dPayload: any = f3dObj?.payload ?? null;
      const f3dPayloadKeys = f3dPayload ? Object.keys(f3dPayload).join(",") : "null";
      const f3dGlobal: any = f3dPayload?.global ?? null;
      const f3dGlobalKeys = f3dGlobal ? Object.keys(f3dGlobal).join(",") : "null";
      const f3dIn0: any = Array.isArray(f3dPayload?.inputs) ? f3dPayload.inputs[0] : null;
      const f3dIn0Keys = f3dIn0 ? Object.keys(f3dIn0).join(",") : "null";
      console.log(`[swap_offer] F3 ready_for_bundle role=${pskt.role} topKeys=${f3dTopKeys} payloadKeys=${f3dPayloadKeys} globalKeys=${f3dGlobalKeys} in0Keys=${f3dIn0Keys} inMod=${f3dGlobal?.inputsModifiable} outMod=${f3dGlobal?.outputsModifiable} sh0=${f3dIn0?.sighashType}`);
      console.log(`[swap_offer] F3 ready_for_bundle global=`, f3dGlobal);
      console.log(`[swap_offer] stage=${stage} role=${pskt.role}`);
      const psktSer = pskt.serialize();
      console.log(`[swap_offer] pskt_serialize prefix=${psktSer.slice(0, 4)} len=${psktSer.length}`);
  
      stage = "bundle_add";
      const bundle = new PSKB();
      try {
        bundle.add(pskt);
      } catch (e: any) {
        const msg = e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e);
        console.log(`[swap_offer] bundle_add failed role=${pskt.role} msg=${msg}`);
        throw e;
      }
  
      stage = "bundle_serialize";
      const pskb = bundle.serialize();
  
      stage = "pskb_canonicalize_for_offer";
      let pskbOffer = pskb;
      try {
        const arr: any[] = decodePskbPayloadArray(pskb);
  
        const arrLen = Array.isArray(arr) ? arr.length : 0;
        const p0: any = arrLen > 0 ? arr[0] : null;
        const p0Keys = p0 ? Object.keys(p0).join(",") : "null";
  
        const global0: any = p0?.global ?? null;
        const global0Keys = global0 ? Object.keys(global0).join(",") : "null";
  
        const input0: any = Array.isArray(p0?.inputs) ? p0.inputs[0] : null;
        const input0Keys = input0 ? Object.keys(input0).join(",") : "null";
  
        console.log(
          `[swap_offer] pskb_decode proof arrLen=${arrLen} p0Keys=${p0Keys} globalKeys=${global0Keys} in0Keys=${input0Keys}`
        );
        console.log(
          `[swap_offer] pskb_decode proof inMod=${global0?.inputsModifiable} outMod=${global0?.outputsModifiable} sh0=${input0?.sighashType}`
        );
  
        const i0ss: any = input0 ? (input0 as any).signatureScript : undefined;
        const i0fss: any = input0 ? (input0 as any).finalScriptSig : undefined;
        const i0rs: any = input0 ? (input0 as any).redeemScript : undefined;
        const i0ps: any = input0 ? (input0 as any).partialSigs : undefined;
  
        const i0ssLen =
          typeof i0ss === "string" ? i0ss.length : i0ss instanceof Uint8Array ? i0ss.length : Array.isArray(i0ss) ? i0ss.length : -1;
        const i0fssLen =
          typeof i0fss === "string" ? i0fss.length : i0fss instanceof Uint8Array ? i0fss.length : Array.isArray(i0fss) ? i0fss.length : -1;
        const i0rsLen =
          typeof i0rs === "string" ? i0rs.length : i0rs instanceof Uint8Array ? i0rs.length : Array.isArray(i0rs) ? i0rs.length : -1;
  
        const i0psCtor = i0ps && typeof i0ps === "object" ? String((i0ps as any).constructor?.name ?? "Object") : typeof i0ps;
        const i0psKeys = i0ps && typeof i0ps === "object" ? Object.keys(i0ps).length : 0;
        const i0psSize = i0ps && typeof i0ps === "object" && typeof (i0ps as any).size === "number" ? (i0ps as any).size : -1;
  
        console.log(
          `[swap_offer] input0_sigmaterial ss=${typeof i0ss}:${i0ssLen} fss=${typeof i0fss}:${i0fssLen} rs=${typeof i0rs}:${i0rsLen} psCtor=${i0psCtor} psKeys=${i0psKeys} psSize=${i0psSize}`
        );
  
        if (arrLen !== 1) throw new Error("pskb_array_len_must_be_1");
        if (!global0 || !input0) throw new Error("pskb_unexpected_shape");
  
        global0.inputsModifiable = true;
        global0.outputsModifiable = true;
        input0.sighashType = SighashType.SingleAnyOneCanPay;
  
        const offerIn0SigScript = input0SigScriptHex;
        const offerIn0SigScriptOk =
          offerIn0SigScript.length > 0 && offerIn0SigScript.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(offerIn0SigScript);
        if (!offerIn0SigScriptOk) throw new Error("maker_input0_signatureScript_invalid");
  
        input0.signatureScript = offerIn0SigScript;
  
        pskbOffer = encodePskbPayloadArray(arr);
  
        console.log(
          `[swap_offer] pskb_canonicalize ok inMod=${global0.inputsModifiable} outMod=${global0.outputsModifiable} sh0=${input0?.sighashType}`
        );
      } catch (e: any) {
        const msg = e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e);
        console.log(`[swap_offer] pskb_canonicalize failed msg=${msg}`);
        throw e;
      }
  
      stage = "offer_validate";
      console.log(`[swap_offer] stage=${stage}`);
      const v = await validateSwapPskb(repoRoot, { phase: "offer", kind, pskb: pskbOffer });
      console.log(`[swap_offer] stage=${stage} ok`);
      if (!v.ok) {
        console.log("[swap_offer] validate errors:", v.errors);
        console.log("[swap_offer] validate warnings:", v.warnings);
        return res.status(500).json({
          ok: false,
          reason: "swap_offer_internal_validation_failed",
          stage,
          error: Array.isArray(v.errors) ? v.errors.join(",") : "",
          errors: v.errors,
          warnings: v.warnings
        });
      }
  
      stage = "offer_persist";
      const ttlSec = expiry > 0 ? expiry : 0;
      const nowIso = new Date().toISOString();
      const expiresIso = ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
  
      const offerId = rid.replace(/[^a-z0-9]/gi, "").slice(0, 32);
  
      const record: any = {
        offerId,
        createdAt: nowIso,
        state: "open",
        ttl: ttlSec,
        expiresAt: expiresIso,
  
        sell: { type: "KAS", symbol: "KAS" },
        buy: { type: "KRC20", symbol: kind === "tick_to_kas" ? `TICK:${tick}` : `CA:${caHex}`, name: tokenName },
  
        sellAmount: priceKasStr,
        buyAmount: amtStr,
  
        price: "",
        partial: { enabled: false },
        complianceOnly,
  
        networkId,
  
        makerWalletId: active.id,
        makerReceiveAddress,
  
        tokenId: tokenIdOut,
        tick: kind === "tick_to_kas" ? tick : "",
        ca: kind === "ca_to_kas" ? caHex : "",
        tokenAmount: amtStr,
        priceKas: priceKasStr,
  
        swapKind: kind,
        swapPskb: pskbOffer,
        swapP2shAddress: p2shAddress,
        swapCommitTxids: commitTxids,
        takerTokenReceiveAddress
      };
  
      const storeO = readOffersStore(repoRoot);
      const existing = storeO.items.find((o: any) => o && o.offerId === offerId) ?? null;
      if (!existing) storeO.items.push(record);
      writeOffersStore(repoRoot, storeO);

      queueUserNotification(
        repoRoot,
        userId,
        "maker_offer_created",
        "Token Depot — Maker offer created",
        [
          "A direct maker offer was created.",
          "",
          `Offer ID: ${offerId}`,
          `Network: ${networkId}`,
          `Kind: ${kind}`,
          `Token: ${tokenIdOut}`,
          `Amount (RAW): ${amtStr}`,
          `Price (KAS): ${priceKasStr}`,
          `Directed wallet: ${takerTokenReceiveAddress}`
        ].join("\n")
      );

      const directedUserId = findUserIdByWalletAddress(repoRoot, networkId, takerTokenReceiveAddress);
      if (directedUserId) {
        queueUserNotification(
          repoRoot,
          directedUserId,
          "new_offers",
          "Token Depot — New direct offer",
          [
            "A new direct offer is available for one of your wallets.",
            "",
            `Offer ID: ${offerId}`,
            `Network: ${networkId}`,
            `Kind: ${kind}`,
            `Token: ${tokenIdOut}`,
            `Amount (RAW): ${amtStr}`,
            `Price (KAS): ${priceKasStr}`,
            `Directed wallet: ${takerTokenReceiveAddress}`
          ].join("\n")
        );
      }
  
      return res.json({
        ok: true,
        offerId,
        network: networkId,
        kind,
        tokenId: tokenIdOut,
        amt: amtStr,
        priceKas: priceKasStr,
        makerReceiveAddress,
        takerTokenReceiveAddress,
        complianceOnly,
        expiry: ttlSec || null,
        pskb: pskbOffer,
        p2shAddress,
        commitTxids
      });
  
    } catch (err) {
      return res.status(500).json({
        ok: false,
        reason: `swap_offer_failed:${stage}`,
        stage,
        rid,
        error: String(err)
      });
    } finally {
      // keep shared RPC connected
    }
  });
  
  app.post("/api/swaps/accept", async (req, res) => {
    let rpc: RpcClient | null = null;
    let stage = "start";
    let rid = "";
  
    try {
      await ensureKaspaReady(repoRoot);
  
      stage = "parse_body";
      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }

      const reqStage = typeof body.stage === "string" ? body.stage.trim() : "";
      const acceptRid = typeof body.acceptRid === "string" ? body.acceptRid.trim() : "";
      const isPrepare = reqStage === "prepare";
      const isSubmit = reqStage === "submit";
      const isResignSubmit = reqStage === "resign_submit";
      if (!isPrepare && !isSubmit && !isResignSubmit) {
        return res.status(400).json({ ok: false, reason: "invalid_stage" });
      }
      if (!isPrepare && !acceptRid) {
        return res.status(400).json({ ok: false, reason: "missing_acceptRid" });
      }

      rid = acceptRid;
      if (isPrepare && !rid) {
        rid = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      }

      sweepBcwDirectSwapFinalizePrepCache(Date.now());
  
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
        return res.status(400).json({ ok: false, reason: "invalid_kind" });
      }
  
      const tokenIdRaw = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
      const parsedToken = (() => {
        if (kind === "tick_to_kas") {
          const t = tokenIdRaw ? tokenIdRaw.trim().toUpperCase() : "";
          if (!t || !/^[A-Za-z0-9]{1,16}$/.test(t)) return { tick: "", caHex: "" };
          return { tick: t, caHex: "" };
        }
  
        const raw = tokenIdRaw ? tokenIdRaw.trim() : "";
        const h = /^CA:/i.test(raw) ? raw.slice(3).trim() : raw;
        const caHex = h.toLowerCase();
        if (!caHex || !/^[0-9a-f]{64}$/.test(caHex)) return { tick: "", caHex: "" };
        return { tick: "", caHex };
      })();
  
      const tick = parsedToken.tick;
      const caHex = parsedToken.caHex;
  
      if (kind === "tick_to_kas") {
        if (!tick) return res.status(400).json({ ok: false, reason: "invalid_tokenId" });
      } else {
        if (!caHex) return res.status(400).json({ ok: false, reason: "invalid_tokenId" });
      }
  
      const tokenIdOut = kind === "tick_to_kas" ? tick : `CA:${caHex}`;
  
      const p2shAddress = typeof body.p2shAddress === "string" ? body.p2shAddress.trim() : "";
      if (!p2shAddress) {
        return res.status(400).json({ ok: false, reason: "missing_p2shAddress" });
      }
  
      const pskb = typeof body.pskb === "string" ? body.pskb.trim() : "";
      if (!pskb) {
        return res.status(400).json({ ok: false, reason: "missing_pskb" });
      }

      const offerIdForIntent = typeof body.offerId === "string" ? body.offerId.trim() : "";

      const swapCommitTxidsAny: any = (body as any).swapCommitTxids;
      const swapCommitTxids: string[] = Array.isArray(swapCommitTxidsAny)
        ? swapCommitTxidsAny.map((x: any) => (typeof x === "string" ? x.trim() : "")).filter((x: string) => !!x)
        : [];

      // stage parsing already handled above (reqStage/acceptRid/isPrepare/isSubmit/isResignSubmit)

      stage = "load_wallet";
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = readWalletStore(repoRoot, userId);
      const active = store.active_id ? (store.items.find((w: any) => w.id === store.active_id) ?? null) : null;
  
      if (!active) return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      if (active.state !== "READY") return res.status(409).json({ ok: false, reason: "wallet_not_ready" });
      if (!active.address0 || typeof active.address0 !== "string" || !active.address0.trim()) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_address0" });
      }
      const isComplianceWallet = active.wallet_type === "compliance";
      const isBcwBrokerCustody = isComplianceWallet && active.custody_model === "broker_1of1";
      const brokerCustodyKeyRef =
        isBcwBrokerCustody && typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
      const userAuthPubkey =
        isBcwBrokerCustody && typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";

      if (isBcwBrokerCustody && !brokerCustodyKeyRef) {
        return res.status(409).json({ ok: false, reason: "bcw_broker_custody_key_ref_missing" });
      }
      if (isBcwBrokerCustody && !userAuthPubkey) {
        return res.status(409).json({ ok: false, reason: "bcw_user_auth_pubkey_missing" });
      }
      if (isComplianceWallet && !isBcwBrokerCustody) {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_direct_swap_taker_removed",
          error: "Legacy 2-of-2 Compliance Wallet direct taker has been removed. Create or select a broker-custody Compliance Wallet."
        });
      }
  
      const appNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
      const expectedPrefix = `${addressPrefixFromAppNetworkKey(appNetworkKey)}:`;
      if (!p2shAddress.startsWith(expectedPrefix)) {
        return res.status(400).json({ ok: false, reason: "invalid_p2shAddress_network" });
      }

      if (kind === "ca_to_kas") {
        const cfg = getAppConfig(repoRoot);
        const gates = cnRecipientGatesFromPolicy(cfg);
        const regulated = Array.isArray(gates && (gates as any).regulated_cas) ? (gates as any).regulated_cas : [];

        if (regulated.includes(caHex)) {
          if (!isComplianceWallet) {
            return res.status(403).json({ ok: false, reason: "regulated_ca_requires_compliance_wallet", ca: caHex });
          }
          const allow =
            Array.isArray(gates && (gates as any).recipient_allowlist) ? (gates as any).recipient_allowlist : [];
          if (!allow.includes(active.address0)) {
            return res.status(403).json({ ok: false, reason: "recipient_not_allowlisted_for_regulated_ca", ca: caHex, to: active.address0 });
          }
        }
      }
  
      stage = "require_user_pubkey";
      if (!isBcwBrokerCustody && (!active.user_pubkey || typeof active.user_pubkey !== "string" || !active.user_pubkey.trim())) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_user_pubkey" });
      }

      const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
      rpc = await getSharedRpc(networkId);

      if (isSubmit && isBcwBrokerCustody) {
        stage = "bcw_direct_swap_finalize_submit";

        const cached = bcwDirectSwapFinalizePrepCache.get(acceptRid);
        if (!cached) {
          return res.status(409).json({ ok: false, reason: "bcw_direct_swap_finalize_cache_missing" });
        }
        if (cached.userId !== userId || cached.walletId !== active.id) {
          return res.status(409).json({ ok: false, reason: "bcw_direct_swap_finalize_cache_wallet_mismatch" });
        }
        if (cached.networkId !== networkId || cached.kind !== kind) {
          return res.status(409).json({ ok: false, reason: "bcw_direct_swap_finalize_cache_request_mismatch" });
        }
        if (offerIdForIntent && cached.offerId !== offerIdForIntent) {
          return res.status(409).json({ ok: false, reason: "bcw_direct_swap_finalize_offer_mismatch" });
        }

        const submittedIntent = (body as any).bcw_direct_swap_finalize_intent;
        const authSignature = typeof (body as any).bcw_auth_signature === "string" ? String((body as any).bcw_auth_signature).trim() : "";
        if (!submittedIntent || typeof submittedIntent !== "object") {
          return res.status(400).json({ ok: false, reason: "bcw_direct_swap_finalize_intent_required" });
        }
        if (!authSignature) {
          return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required" });
        }

        const submittedIntentMessage = canonicalBcwDirectSwapFinalizeIntentMessage(submittedIntent as BcwDirectSwapFinalizeIntentV1);
        if (submittedIntentMessage !== cached.intentMessage) {
          return res.status(409).json({ ok: false, reason: "bcw_direct_swap_finalize_intent_mismatch" });
        }

        if (!bcwDirectSwapFinalizeSubmit) {
          return res.status(500).json({ ok: false, reason: "bcw_direct_swap_finalize_submit_unavailable" });
        }

        const cn = await bcwDirectSwapFinalizeSubmit({
          repoRootPath: repoRoot,
          intent: cached.intent,
          authSignature,
          txSafeJson: cached.txSafeJson
        });

        if (!cn.ok) {
          return res.status(cn.status || 502).json({
            ok: false,
            reason: "bcw_direct_swap_finalize_cn_rejected",
            stage,
            cn: cn.data
          });
        }

        const txid = typeof (cn.data as any)?.txid === "string" ? String((cn.data as any).txid).trim() : "";
        if (!txid) {
          return res.status(502).json({ ok: false, reason: "bcw_direct_swap_finalize_missing_txid", stage, cn: cn.data });
        }

        bcwDirectSwapFinalizePrepCache.delete(acceptRid);
        queueDirectMakerFilledNotification(repoRoot, networkId, kind, txid, cached.makerOutputSpk);

        return res.json({
          ok: true,
          stage: "bcw_direct_swap_finalize_submit",
          network: networkId,
          kind,
          txid,
          txids: [txid],
          cn: cn.data
        });
      }
  
      stage = "validate_offer_pskb";
      const vOffer = await validateSwapPskb(repoRoot, { phase: "offer", kind, pskb });
      if (!vOffer.ok) {
        return res.status(400).json({
          ok: false,
          reason: "swap_offer_invalid",
          errors: vOffer.errors,
          warnings: vOffer.warnings
        });
      }
  
      stage = "decode_offer_pskb";
      const arr = decodePskbPayloadArray(pskb);
      if (arr.length !== 1) {
        return res.status(400).json({ ok: false, reason: "pskb_must_contain_single_pskt_for_m4a" });
      }
  
      const base: any = arr[0];
      const baseInputs: any[] = Array.isArray(base?.inputs) ? base.inputs : [];
      const baseOutputs: any[] = Array.isArray(base?.outputs) ? base.outputs : [];

      const baseInCount = baseInputs.length;
      const baseOutCount = baseOutputs.length;

      if (baseInCount !== 1 && baseInCount !== 2) {
        return res.status(400).json({ ok: false, reason: "offer_inputs_must_be_1_or_2" });
      }
      if (baseOutCount !== 1 && baseOutCount !== 2) {
        return res.status(400).json({ ok: false, reason: "offer_outputs_must_be_1_or_2" });
      }
      if (baseInCount !== baseOutCount) {
        return res.status(400).json({ ok: false, reason: "offer_inputs_outputs_count_mismatch" });
      }

      const baseInput0: any = baseInputs[0];
      const baseOutput0: any = baseOutputs[0];
  
      {
        const ss0: any = baseInput0 && typeof baseInput0 === "object" ? (baseInput0 as any).signatureScript : undefined;
        const rs0: any = baseInput0 && typeof baseInput0 === "object" ? (baseInput0 as any).redeemScript : undefined;
  
        const ss0Ok =
          typeof ss0 === "string" && ss0.length > 0 && ss0.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(ss0);
        const rs0Ok =
          typeof rs0 === "string" && rs0.length > 0 && rs0.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(rs0);
  
        if (ss0Ok && rs0Ok && !ss0.toLowerCase().includes(rs0.toLowerCase())) {
          throw new Error("offer_input0_sigscript_missing_redeemScript");
        }
  
        if (!rs0Ok) {
          return res.status(400).json({ ok: false, reason: "offer_input0_redeemScript_invalid" });
        }

        const rs0Lower = rs0.toLowerCase();
        const needleTo = Buffer.from(`"to":"${active.address0}"`).toString("hex").toLowerCase();
        if (!rs0Lower.includes(needleTo)) {
          return res.status(403).json({ ok: false, reason: "offer_not_directed_to_active_wallet" });
        }
      }
  
      stage = "offer_output0_probe";
  
      const out0Keys = baseOutput0 && typeof baseOutput0 === "object" ? Object.keys(baseOutput0).join(",") : "null";
      const out0ValueRaw: any = baseOutput0 && typeof baseOutput0 === "object" ? (baseOutput0 as any).value : undefined;
      const out0ValueRawType =
        out0ValueRaw === null ? "null" : Array.isArray(out0ValueRaw) ? "array" : typeof out0ValueRaw;
      const out0ValueRawKeys =
        out0ValueRaw && typeof out0ValueRaw === "object" && !Array.isArray(out0ValueRaw)
          ? Object.keys(out0ValueRaw).slice(0, 80).join(",")
          : "";
  
      console.log(
        `[swap_accept] offer_output0 probe out0Keys=${out0Keys} valueType=${out0ValueRawType} valueKeys=${out0ValueRawKeys}`
      );
      console.log("[swap_accept] offer_output0 raw=", baseOutput0);
      console.log("[swap_accept] offer_output0 raw.value=", out0ValueRaw);
  
      const bytesToSompiLE = (bytes: number[]): bigint => {
        let x = 0n;
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
            throw new Error("offer_output0_bytes_invalid");
          }
          x += BigInt(b) << (8n * BigInt(i));
        }
        return x;
      };
  
      const asByteArray = (v: any): number[] | null => {
        if (!v) return null;
  
        if (Array.isArray(v)) {
          const arr: number[] = [];
          for (const n0 of v) {
            const n =
              typeof n0 === "number"
                ? n0
                : typeof n0 === "string" && /^\d+$/.test(n0)
                  ? Number(n0)
                  : NaN;
            if (!Number.isFinite(n)) return null;
            arr.push(n);
          }
          return arr;
        }
  
        if (typeof v === "object") {
          const keys = Object.keys(v)
            .filter((k) => /^\d+$/.test(k))
            .sort((a, b) => Number(a) - Number(b));
          if (!keys.length) return null;
  
          const arr: number[] = [];
          for (const k of keys) {
            const n0 = (v as any)[k];
            const n =
              typeof n0 === "number"
                ? n0
                : typeof n0 === "string" && /^\d+$/.test(n0)
                  ? Number(n0)
                  : NaN;
            if (!Number.isFinite(n)) return null;
            arr.push(n);
          }
          return arr;
        }
  
        return null;
      };
  
      const coerceSompiStr = (v: any): string => {
        const bi0 = readSompi(v);
        if (bi0 !== null) return bi0.toString();
  
        if (v && typeof v === "object") {
          for (const k of ["sompi", "amount", "value", "valueSompi", "value_sompi"]) {
            const biK = readSompi((v as any)[k]);
            if (biK !== null) return biK.toString();
          }
        }
  
        const bytes = asByteArray(v);
        if (bytes && bytes.length) {
          try {
            return bytesToSompiLE(bytes).toString();
          } catch {
            return "";
          }
        }
  
        return "";
      };
  
      const out0Candidate: any =
        (baseOutput0 && typeof baseOutput0 === "object" ? (baseOutput0 as any).value : undefined) ??
        (baseOutput0 && typeof baseOutput0 === "object" ? (baseOutput0 as any).amount : undefined);
  
      const out0ValueStr = coerceSompiStr(out0Candidate);
      if (!out0ValueStr) {
        return res.status(400).json({ ok: false, reason: "offer_output0_value_invalid" });
      }
  
      if (baseOutput0 && typeof baseOutput0 === "object") {
        (baseOutput0 as any).value = out0ValueStr;
      }
  
      const out0Value = readSompi(out0ValueStr);
      if (out0Value === null) {
        return res.status(400).json({ ok: false, reason: "offer_output0_value_invalid" });
      }
  
      console.log(`[swap_accept] offer_output0 normalized value=${out0ValueStr}`);
  
      stage = "fetch_commit_utxo";
      const p2shUtxos = await rpc.getUtxosByAddresses({ addresses: [p2shAddress] });
      const p2shEntries: any[] = p2shUtxos && Array.isArray((p2shUtxos as any).entries) ? (p2shUtxos as any).entries : [];

      if (!p2shEntries.length) {
        return res.status(409).json({ ok: false, reason: "commit_utxo_not_found" });
      }

      let commitEntry: any = null;

      if (p2shEntries.length === 1) {
        commitEntry = p2shEntries[0];
      } else if (swapCommitTxids.length) {
        const commitTxidsLowerSet = new Set(swapCommitTxids.map((t: string) => t.toLowerCase()));
        const commitMatches = p2shEntries.filter((e: any) => {
          const op = e && e.outpoint ? e.outpoint : null;
          const txid = op && typeof op.transactionId === "string" ? op.transactionId.toLowerCase() : "";
          return !!txid && commitTxidsLowerSet.has(txid);
        });

        if (!commitMatches.length) {
          return res.status(409).json({ ok: false, reason: "commit_utxo_not_found" });
        }
        if (commitMatches.length !== 1) {
          return res.status(409).json({ ok: false, reason: "p2sh_utxo_ambiguous" });
        }

        commitEntry = commitMatches[0];
      } else {
        return res.status(409).json({ ok: false, reason: "p2sh_utxo_ambiguous" });
      }
      const commitOp: any = commitEntry && typeof commitEntry === "object" ? (commitEntry as any).outpoint : null;
      if (!commitOp || typeof commitOp.transactionId !== "string") {
        return res.status(500).json({ ok: false, reason: "commit_utxo_outpoint_invalid" });
      }

      const commitTxidLower = commitOp.transactionId.toLowerCase();
      const commitVoutNum = Number(commitOp.index);
      if (!Number.isInteger(commitVoutNum) || commitVoutNum < 0) {
        return res.status(500).json({ ok: false, reason: "commit_utxo_outpoint_invalid" });
      }

      const commitAmtAny: any = (commitEntry as any)?.utxoEntry?.amount ?? (commitEntry as any)?.amount;
      const commitAmt = readSompi(commitAmtAny);
      if (commitAmt === null) {
        return res.status(500).json({ ok: false, reason: "commit_utxo_amount_invalid" });
      }
  
      stage = "fetch_taker_utxos";
      const takerUtxos = await rpc.getUtxosByAddresses({ addresses: [active.address0] });
      let takerEntries: any[] =
        takerUtxos && Array.isArray((takerUtxos as any).entries) ? ((takerUtxos as any).entries as any[]) : [];
  
      if (!takerEntries.length) {
        return res.status(409).json({ ok: false, reason: "no_utxos" });
      }
  
      takerEntries = takerEntries
        .filter((e: any) => {
          const op = e && e.outpoint ? e.outpoint : null;
          return !(op && typeof op.transactionId === "string" && op.transactionId.toLowerCase() === commitTxidLower && Number(op.index) === commitVoutNum);
        })
        .sort((a: any, b: any) => {
          const av = readSompi((a as any)?.utxoEntry?.amount ?? (a as any)?.amount) ?? 0n;
          const bv = readSompi((b as any)?.utxoEntry?.amount ?? (b as any)?.amount) ?? 0n;
          if (bv !== av) return bv > av ? 1 : -1;

          const atx = String((a as any)?.outpoint?.transactionId ?? "");
          const btx = String((b as any)?.outpoint?.transactionId ?? "");
          if (atx !== btx) return atx < btx ? -1 : 1;

          const ai = Number((a as any)?.outpoint?.index ?? 0);
          const bi = Number((b as any)?.outpoint?.index ?? 0);
          return ai - bi;
        });
  
      stage = "taker_utxo_probe";
      const t0: any = takerEntries.length ? takerEntries[0] : null;
      const t0Keys = t0 && typeof t0 === "object" ? Object.keys(t0).join(",") : "null";
      const t0Op: any = t0 && typeof t0 === "object" ? (t0 as any).outpoint : null;
      const t0OpKeys = t0Op && typeof t0Op === "object" ? Object.keys(t0Op).join(",") : "null";
      const t0U: any =
        t0 && typeof t0 === "object" ? ((t0 as any).utxoEntry ?? (t0 as any).utxo ?? null) : null;
      const t0UKeys = t0U && typeof t0U === "object" ? Object.keys(t0U).join(",") : "null";
      console.log(`[swap_accept] taker_utxo_probe len=${takerEntries.length} t0Keys=${t0Keys} opKeys=${t0OpKeys} uKeys=${t0UKeys}`);
      console.log(`[swap_accept] taker_utxo_probe t0=`, t0);
  
      const baseSequence = typeof baseInput0?.sequence === "number" ? baseInput0.sequence : 0;
      const baseSigOps = typeof baseInput0?.sigOpCount === "number" ? baseInput0.sigOpCount : 1;
  
      const buildTxAttempt = (selected: any[], withChange: boolean, changeHint?: bigint) => {
        const payload: any = JSON.parse(JSON.stringify(base));
  
        payload.inputs = Array.isArray(payload.inputs) ? payload.inputs : [];
        payload.outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
  
        if (!payload.inputs[0].utxo) {
          const u: any = (commitEntry as any).utxoEntry ?? (commitEntry as any).utxo ?? null;
          if (u) {
            payload.inputs[0].utxo = {
              outpoint: (commitEntry as any).outpoint,
              amount: (u as any).amount,
              scriptPublicKey: (u as any).scriptPublicKey,
              blockDaaScore: (u as any).blockDaaScore,
              isCoinbase: (u as any).isCoinbase
            };
          }
        }
  
        for (const e of selected) {
          const op: any =
            e && typeof e === "object"
              ? ((e as any).outpoint ?? (e as any)?.utxo?.outpoint ?? (e as any)?.utxoEntry?.outpoint ?? null)
              : null;
  
          let u: any =
            e && typeof e === "object"
              ? ((e as any).utxoEntry ?? (e as any).utxo ?? null)
              : null;
  
          if (!u && e && typeof e === "object") {
            const hasAmt = (e as any).amount !== undefined;
            const hasSpk = (e as any).scriptPublicKey !== undefined;
            if (hasAmt || hasSpk) u = e;
          }
  
          if (!op || !u) {
            const eKeys = e && typeof e === "object" ? Object.keys(e).join(",") : String(typeof e);
            console.log(`[swap_accept] taker_utxo_shape_invalid keys=${eKeys} op=${!!op} u=${!!u}`);
            console.log(`[swap_accept] taker_utxo_shape_invalid e=`, e);
            throw new Error("taker_utxo_shape_invalid");
          }
  
          const amtAny: any = (u as any).amount;
          const spkAny: any = (u as any).scriptPublicKey;
  
          if (amtAny === undefined || spkAny === undefined) {
            const uKeys = u && typeof u === "object" ? Object.keys(u).join(",") : String(typeof u);
            console.log(`[swap_accept] taker_utxo_fields_missing uKeys=${uKeys} amt=${String(amtAny)} spk=${String(spkAny)}`);
            console.log(`[swap_accept] taker_utxo_fields_missing u=`, u);
            throw new Error("taker_utxo_fields_missing");
          }
  
          payload.inputs.push({
            previousOutpoint: op,
            signatureScript: "",
            sequence: baseSequence,
            sigOpCount: baseSigOps,
            utxoRef: e,
            utxo: {
              outpoint: op,
              amount: amtAny,
              scriptPublicKey: spkAny,
              blockDaaScore: (u as any).blockDaaScore,
              isCoinbase: (u as any).isCoinbase
            }
          });
        }
  
        const MIN_CHANGE_SOMPI = 33000000n; // 0.33 KAS safe cutoff (output deviation / storage mass)
        const changeSompi =
          typeof changeHint === "bigint" && changeHint > MIN_CHANGE_SOMPI ? changeHint : MIN_CHANGE_SOMPI;

        if (payload.outputs.length < baseOutCount) {
          throw new Error("payload_base_outputs_missing");
        }

        const outs: any[] = payload.outputs.slice(0, baseOutCount);

        if (changeSompi > 0n) {
          outs.push({ value: changeSompi.toString(), scriptPublicKey: payToAddressScript(active.address0) });
        }

        payload.outputs = outs;
  
        const txShape: any = { ...payload };
        const txGlobal: any = txShape.global ?? payload.global ?? null;
        delete txShape.global;
  
        if (txShape.version === undefined) {
          const v = txGlobal && typeof txGlobal === "object" ? (txGlobal as any).txVersion : undefined;
          txShape.version = typeof v === "number" ? v : 0;
        }
  
        if (txShape.lockTime === undefined) {
          const lt = txGlobal && typeof txGlobal === "object" ? (txGlobal as any).fallbackLockTime : undefined;
          txShape.lockTime = typeof lt === "number" ? lt : 0;
        }
  
        if (txShape.gas === undefined) {
          txShape.gas = 0;
        }
  
        stage = "txshape_normalize_hex";
  
        const toHexStr = (v: any): string => {
          if (typeof v === "string") {
            const s = v.trim();
            if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
            return "";
          }
          if (v instanceof Uint8Array) {
            return Buffer.from(v).toString("hex");
          }
          if (Array.isArray(v)) {
            const bytes: number[] = [];
            for (const n0 of v) {
              const n =
                typeof n0 === "number"
                  ? n0
                  : typeof n0 === "string" && /^\d+$/.test(n0)
                    ? Number(n0)
                    : NaN;
              if (!Number.isFinite(n) || n < 0 || n > 255) return "";
              bytes.push(n);
            }
            return Buffer.from(bytes).toString("hex");
          }
          return "";
        };
  
        const normalizeOutpoint = (op: any, tag: string): any => {
          if (!op || typeof op !== "object") return op;
  
          const tidAny: any = (op as any).transactionId ?? (op as any).transaction_id ?? (op as any).txid ?? (op as any).id;
          const idxAny: any = (op as any).index ?? (op as any).vout ?? (op as any).outputIndex;
  
          const tidHex = toHexStr(tidAny);
          const idxNum = typeof idxAny === "number" ? idxAny : typeof idxAny === "string" && /^\d+$/.test(idxAny) ? Number(idxAny) : NaN;
  
          if (tidHex && Number.isFinite(idxNum)) {
            return { transactionId: tidHex, index: idxNum };
          }
  
          // Try nested shapes (some wrappers hide fields under `.outpoint`)
          const nested: any = (op as any).outpoint ?? null;
          if (nested && typeof nested === "object") {
            const tidHex2 = toHexStr((nested as any).transactionId ?? (nested as any).id);
            const idx2: any = (nested as any).index ?? (nested as any).vout;
            const idxNum2 = typeof idx2 === "number" ? idx2 : typeof idx2 === "string" && /^\d+$/.test(idx2) ? Number(idx2) : NaN;
            if (tidHex2 && Number.isFinite(idxNum2)) return { transactionId: tidHex2, index: idxNum2 };
          }
  
          const keys = Object.keys(op).join(",");
          console.log(`[swap_accept] outpoint_normalize_failed tag=${tag} keys=${keys}`);
          console.log(`[swap_accept] outpoint_normalize_failed op=`, op);
          return op;
        };
  
        const normalizeSpk = (spk: any, tag: string): any => {
          const hx0 = toHexStr(spk);
          if (hx0) return hx0;
  
          if (spk && typeof spk === "object") {
            // WASM ScriptPublicKey -> hex string "vvvv" + scriptHex (matches PSKB payload shape like "0000....")
            try {
              const v = (spk as any).version;
              const s = (spk as any).script;
              const sHex = toHexStr(s);
              if (typeof v === "number" && sHex) {
                const vHex = (v >>> 0).toString(16).padStart(4, "0");
                const spkHex = (vHex + sHex).toLowerCase();
                if (/^[0-9a-f]+$/.test(spkHex) && spkHex.length % 2 === 0) {
                  console.log(`[swap_accept] spk_normalized tag=${tag} mode=hex_from_wasm`);
                  return spkHex;
                }
              }
            } catch {}
  
            // Some bindings expose a useful toJSON()
            try {
              if (typeof (spk as any).toJSON === "function") {
                const o: any = (spk as any).toJSON();
                const v = o && typeof o === "object" ? o.version : undefined;
                const s = o && typeof o === "object" ? o.script : undefined;
                const sHex = toHexStr(s);
                if (typeof v === "number" && sHex) {
                  console.log(`[swap_accept] spk_normalized tag=${tag} mode=toJSON`);
                  return { version: v, script: sHex };
                }
              }
            } catch {}
  
            // Fallback: sometimes toString() returns a hex view
            try {
              if (typeof (spk as any).toString === "function") {
                const s = String((spk as any).toString());
                const hx = toHexStr(s);
                if (hx) return hx;
              }
            } catch {}
  
            // Some wrappers store bytes under `.bytes`
            if ((spk as any).bytes) {
              const hx2 = toHexStr((spk as any).bytes);
              if (hx2) return hx2;
            }
          }
  
          const keys = spk && typeof spk === "object" ? Object.keys(spk).join(",") : String(typeof spk);
          console.log(`[swap_accept] spk_normalize_failed tag=${tag} type=${typeof spk} keys=${keys}`);
          console.log(`[swap_accept] spk_normalize_failed spk=`, spk);
          return spk;
        };
  
        // Normalize inputs
        if (Array.isArray(txShape.inputs)) {
          for (let i = 0; i < txShape.inputs.length; i++) {
            const inp: any = txShape.inputs[i];
            if (!inp || typeof inp !== "object") continue;
  
            if ((inp as any).previousOutpoint) {
              (inp as any).previousOutpoint = normalizeOutpoint((inp as any).previousOutpoint, `in${i}.prev`);
            }
  
            let utxo: any = (inp as any).utxo ?? null;
  
            if (!utxo) {
              const ue: any = (inp as any).utxoEntry ?? null;
              if (ue && typeof ue === "object") {
                const prevOp: any = (inp as any).previousOutpoint ?? null;
  
                utxo = {
                  outpoint: prevOp,
                  amount: (ue as any).amount,
                  scriptPublicKey: (ue as any).scriptPublicKey,
                  blockDaaScore: (ue as any).blockDaaScore,
                  isCoinbase: (ue as any).isCoinbase
                };
  
                if ((ue as any).scriptPublicKey) {
                  (ue as any).scriptPublicKey = normalizeSpk((ue as any).scriptPublicKey, `in${i}.utxoEntry.spk`);
                }
  
                (inp as any).utxo = utxo;
  
                console.log(`[swap_accept] utxoEntry_mapped i=${i}`);
              }
            }
  
            if (utxo && typeof utxo === "object") {
              if ((utxo as any).outpoint) (utxo as any).outpoint = normalizeOutpoint((utxo as any).outpoint, `in${i}.utxo.outpoint`);
              if ((utxo as any).scriptPublicKey) (utxo as any).scriptPublicKey = normalizeSpk((utxo as any).scriptPublicKey, `in${i}.utxo.spk`);
            }
          }
        }
  
        // Normalize outputs
        if (Array.isArray(txShape.outputs)) {
          for (let j = 0; j < txShape.outputs.length; j++) {
            const out: any = txShape.outputs[j];
            if (!out || typeof out !== "object") continue;
            if ((out as any).scriptPublicKey) (out as any).scriptPublicKey = normalizeSpk((out as any).scriptPublicKey, `out${j}.spk`);
          }
        }
  
        stage = "txshape_sanitize_scripts";
  
        const isHexEven = (s: string): boolean => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
  
        // Inputs: ensure scripts are bytes, and remove null script fields that trigger wasm type errors
        if (Array.isArray(txShape.inputs)) {
          for (let i = 0; i < txShape.inputs.length; i++) {
            const inp: any = txShape.inputs[i];
            if (!inp || typeof inp !== "object") continue;
  
            // signatureScript must be hex string for ITransaction ("" is allowed for unsigned)
            const ss0: any = (inp as any).signatureScript;
            if (typeof ss0 === "string") {
              // keep as-is
            } else if (ss0 instanceof Uint8Array && ss0.length) {
              (inp as any).signatureScript = Buffer.from(ss0).toString("hex");
            } else if (Array.isArray(ss0) && ss0.length && ss0.every((n) => typeof n === "number")) {
              (inp as any).signatureScript = Buffer.from(ss0).toString("hex");
            } else {
              (inp as any).signatureScript = "";
            }
            if ((inp as any).signatureScript === undefined || (inp as any).signatureScript === null) {
              (inp as any).signatureScript = "";
            }
  
            // PSKB input schema: keep required fields present for validator deserialization
            const ps0: any = (inp as any).partialSigs;
            if (ps0 === undefined || ps0 === null || typeof ps0 !== "object") {
              (inp as any).partialSigs = {};
            }
  
            const mt0: any = (inp as any).minTime;
            if (mt0 === undefined || mt0 === null || typeof mt0 !== "number") {
              (inp as any).minTime = 0;
            }
  
            const bd0: any = (inp as any).bip32Derivations;
            if (bd0 === undefined || bd0 === null || typeof bd0 !== "object") {
              (inp as any).bip32Derivations = {};
            }
  
            const pr0: any = (inp as any).proprietaries;
            if (pr0 === undefined || pr0 === null || typeof pr0 !== "object") {
              (inp as any).proprietaries = {};
            }
  
            // PSKB validator expects sighashType to be present on each input.
            // Default: input0 must remain SINGLE|ANYONECANPAY, other inputs default to ALL.
            const sh0: any = (inp as any).sighashType;
            if (typeof sh0 !== "number") {
              (inp as any).sighashType = i === 0 ? SighashType.SingleAnyOneCanPay : SighashType.All;
            }
            if ((inp as any).sighashType === undefined || (inp as any).sighashType === null) {
              (inp as any).sighashType = i === 0 ? SighashType.SingleAnyOneCanPay : SighashType.All;
            }
  
            // PSKB/PSKT script fields must remain present for validator deserialization.
            // Keep finalScriptSig as a string (empty string is allowed when not finalized).
            const fss0: any = (inp as any).finalScriptSig;
            if (typeof fss0 !== "string") {
              (inp as any).finalScriptSig = "";
            }
            if ((inp as any).finalScriptSig === undefined || (inp as any).finalScriptSig === null) {
              (inp as any).finalScriptSig = "";
            }
  
            // PSKB validator expects redeemScript field present (empty string if not used)
            const rs0: any = (inp as any).redeemScript;
            if (typeof rs0 !== "string") {
              (inp as any).redeemScript = "";
            }
            if ((inp as any).redeemScript === undefined || (inp as any).redeemScript === null) {
              (inp as any).redeemScript = "";
            }
  
            // Some PSKB payloads use sequence=null; normalize to 0 for Transaction
            if ((inp as any).sequence === null || (inp as any).sequence === undefined) {
              (inp as any).sequence = 0;
            }
          }
        }
  
        // Outputs: keep PSKB fields present for validator deserialization (especially our change output)
        if (Array.isArray(txShape.outputs)) {
          for (let j = 0; j < txShape.outputs.length; j++) {
            const out: any = txShape.outputs[j];
            if (!out || typeof out !== "object") continue;
  
            const ors0: any = (out as any).redeemScript;
            if (typeof ors0 !== "string") {
              (out as any).redeemScript = "";
            }
            if ((out as any).redeemScript === undefined || (out as any).redeemScript === null) {
              (out as any).redeemScript = "";
            }
  
            const obd0: any = (out as any).bip32Derivations;
            if (obd0 === undefined || obd0 === null || typeof obd0 !== "object") {
              (out as any).bip32Derivations = {};
            }
  
            const opr0: any = (out as any).proprietaries;
            if (opr0 === undefined || opr0 === null || typeof opr0 !== "object") {
              (out as any).proprietaries = {};
            }
  
            // PSKB validator expects `amount` present on outputs (sompi as number).
            const oa0: any = (out as any).amount;
            if (typeof oa0 !== "number") {
              const v0: any = (out as any).value;
              if (typeof v0 === "bigint") (out as any).amount = Number(v0);
              else if (typeof v0 === "number") (out as any).amount = v0;
              else if (typeof v0 === "string" && /^[0-9]+$/.test(v0)) (out as any).amount = Number(v0);
              else (out as any).amount = 0;
            }
          }
        }
  
        stage = "txshape_input_probe";
        if (Array.isArray(txShape.inputs)) {
          for (let i = 0; i < txShape.inputs.length; i++) {
            const inp: any = txShape.inputs[i];
            if (!inp || typeof inp !== "object") continue;
  
            const ss: any = (inp as any).signatureScript;
            const ssType =
              ss === null ? "null" : ss instanceof Uint8Array ? "Uint8Array" : Array.isArray(ss) ? "array" : typeof ss;
  
            const prev: any = (inp as any).previousOutpoint ?? null;
            const tid: any = prev && typeof prev === "object" ? (prev as any).transactionId : undefined;
            const tidType =
              tid === null ? "null" : tid instanceof Uint8Array ? "Uint8Array" : Array.isArray(tid) ? "array" : typeof tid;
            const tidOk = typeof tid === "string" ? isHexEven(tid) : true;
  
            const utxo: any = (inp as any).utxo ?? null;
            const spk: any = utxo && typeof utxo === "object" ? (utxo as any).scriptPublicKey : undefined;
            const spkType =
              spk === null ? "null" : spk instanceof Uint8Array ? "Uint8Array" : Array.isArray(spk) ? "array" : typeof spk;
            const spkOk = typeof spk === "string" ? isHexEven(spk) : true;
  
            console.log(
              `[swap_accept] txshape_input_probe i=${i} sigType=${ssType} tidType=${tidType} tidOk=${tidOk} spkType=${spkType} spkOk=${spkOk}`
            );
          }
        }
  
        console.log(
          `[swap_accept] txshape probe keys=${Object.keys(txShape).join(",")} version=${txShape.version} lockTime=${txShape.lockTime} gas=${txShape.gas}`
        );
  
        stage = "itx_build";
  
        const toBigInt0 = (v: any): bigint => {
          if (typeof v === "bigint") return v;
          if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
          if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
          return 0n;
        };
  
        const subnetworkIdNative = "0000000000000000000000000000000000000000";
  
        stage = "maker_utxo_ref_from_commit";
  
        const makerUref: any = commitEntry;
        if (!makerUref) throw new Error("maker_commit_entry_missing");
  
        const makerPtr = makerUref && typeof makerUref === "object" ? (makerUref as any).__wbg_ptr : undefined;
        let makerKeys = "";
        try {
          makerKeys =
            makerUref && typeof makerUref === "object" ? Object.keys(makerUref as any).slice(0, 24).join(",") : "";
        } catch {}
        console.log(
          `[swap_accept] maker_utxo_ref_probe type=${makerUref === null ? "null" : Array.isArray(makerUref) ? "array" : typeof makerUref} hasPtr=${typeof makerPtr === "number"} ptr=${String(makerPtr)} keys=${makerKeys}`
        );
  
        console.log(`[swap_accept] maker_utxo_ref ok txid=${commitTxidLower} vout=${commitVoutNum}`);
  
        const iTx: any = {
          version: typeof txShape.version === "number" ? txShape.version : 0,
          lockTime: toBigInt0(txShape.lockTime),
          gas: toBigInt0(txShape.gas),
          payload: "",
          subnetworkId: subnetworkIdNative,
          inputs: [],
          outputs: []
        };
  
        if (Array.isArray(txShape.inputs)) {
          for (let i = 0; i < txShape.inputs.length; i++) {
            const inp: any = txShape.inputs[i];
            if (!inp || typeof inp !== "object") continue;
  
            const prev: any = (inp as any).previousOutpoint ?? null;
            const seq0 = toBigInt0((inp as any).sequence);
  
            const sigOps0 =
              typeof (inp as any).sigOpCount === "number"
                ? (inp as any).sigOpCount
                : typeof (inp as any).sigOpCount === "string" && /^\d+$/.test((inp as any).sigOpCount)
                  ? Number((inp as any).sigOpCount)
                  : 1;
  
            const txIn: any = {
              previousOutpoint: prev,
              signatureScript: typeof (inp as any).signatureScript === "string" ? (inp as any).signatureScript : "",
              sequence: seq0,
              sigOpCount: sigOps0
            };
  
            let uref: any = (inp as any).utxoRef ?? null;
  
            if (!uref) {
              const op: any = prev && typeof prev === "object" ? prev : null;
              if (op && typeof op.transactionId === "string" && op.transactionId.toLowerCase() === commitTxidLower && Number(op.index) === commitVoutNum) {
                uref = makerUref;
              }
            }
  
            const utxoObj: any = (inp as any).utxo ?? null;
            if (!uref && (!utxoObj || typeof utxoObj !== "object")) throw new Error("tx_input_utxo_missing");
            txIn.utxo = uref ? uref : utxoObj;
  
            iTx.inputs.push(txIn);
          }
        }
  
        if (Array.isArray(txShape.outputs)) {
          for (let j = 0; j < txShape.outputs.length; j++) {
            const out: any = txShape.outputs[j];
            if (!out || typeof out !== "object") continue;
  
            const v0 = toBigInt0((out as any).value ?? (out as any).amount);
            const spk0 = (out as any).scriptPublicKey;
  
            iTx.outputs.push({
              value: v0,
              scriptPublicKey: spk0
            });
          }
        }
  
        console.log(`[swap_accept] itx probe in=${iTx.inputs.length} out=${iTx.outputs.length} v=${iTx.version} lt=${String(iTx.lockTime)} gas=${String(iTx.gas)}`);
  
        const bigintIssues: string[] = [];
        if (typeof iTx.lockTime !== "bigint") bigintIssues.push(`lockTime=${typeof iTx.lockTime}`);
        if (typeof iTx.gas !== "bigint") bigintIssues.push(`gas=${typeof iTx.gas}`);
  
        for (let i = 0; i < iTx.inputs.length; i++) {
          const seq = (iTx.inputs[i] as any)?.sequence;
          if (typeof seq !== "bigint") bigintIssues.push(`in[${i}].sequence=${typeof seq}`);
        }
        for (let j = 0; j < iTx.outputs.length; j++) {
          const val = (iTx.outputs[j] as any)?.value;
          if (typeof val !== "bigint") bigintIssues.push(`out[${j}].value=${typeof val}`);
        }
  
        console.log(
          `[swap_accept] itx_bigint_probe issues=${bigintIssues.length}${bigintIssues.length ? " " + bigintIssues.join(" | ") : ""}`
        );
  
        const isHexEvenOrEmpty = (v: any): boolean =>
          typeof v === "string" && v.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(v);
  
        const isBytesLike = (v: any): boolean => v instanceof Uint8Array || Array.isArray(v);
  
        const tagAny = (v: any): string => {
          if (v === null) return "null";
          if (v === undefined) return "undefined";
          const t = Array.isArray(v) ? "array" : v instanceof Uint8Array ? "Uint8Array" : typeof v;
          if (t === "string") return `string(len=${(v as string).length} hex=${isHexEvenOrEmpty(v)})`;
          if (t === "Uint8Array") return `Uint8Array(len=${(v as Uint8Array).length})`;
          if (t === "array") return `array(len=${(v as any[]).length})`;
          if (t === "number" || t === "boolean" || t === "bigint") return `${t}(${String(v)})`;
          if (t === "object") {
            let keys = "";
            try {
              keys = Object.keys(v).slice(0, 10).join(",");
            } catch {}
            return `object(keys=${keys})`;
          }
          return String(t);
        };
  
        const tagUref = (u: any): string => {
          const ptr = u && typeof u === "object" ? (u as any).__wbg_ptr : undefined;
          return `type=${u === null ? "null" : Array.isArray(u) ? "array" : typeof u} hasPtr=${typeof ptr === "number"} ptr=${String(ptr)}`;
        };
  
        const tagSpk = (spk: any): string => {
          if (typeof spk === "string" || spk instanceof Uint8Array || Array.isArray(spk)) return tagAny(spk);
          if (spk && typeof spk === "object") {
            const ver = (spk as any).version;
            const script = (spk as any).script ?? (spk as any).scriptPublicKey ?? (spk as any).data;
            let keys = "";
            try {
              keys = Object.keys(spk).slice(0, 10).join(",");
            } catch {}
            return `object(ver=${String(ver)} script=${tagAny(script)} keys=${keys})`;
          }
          return tagAny(spk);
        };
  
        const preflightIssues: string[] = [];
  
        if (!(isHexEvenOrEmpty(iTx.subnetworkId) || isBytesLike(iTx.subnetworkId))) {
          preflightIssues.push(`subnetworkId=${tagAny(iTx.subnetworkId)}`);
        }
        if (!(isHexEvenOrEmpty(iTx.payload) || isBytesLike(iTx.payload))) {
          preflightIssues.push(`payload=${tagAny(iTx.payload)}`);
        }
  
        for (let k = 0; k < iTx.inputs.length; k++) {
          const inp: any = iTx.inputs[k];
          const po: any = inp ? inp.previousOutpoint : null;
          const tid: any = po && typeof po === "object" ? po.transactionId : undefined;
          const ss: any = inp ? inp.signatureScript : undefined;
  
          if (!(isHexEvenOrEmpty(tid) || isBytesLike(tid))) {
            preflightIssues.push(`in[${k}].prev.transactionId=${tagAny(tid)}`);
          }
          if (!(po && typeof po.index === "number")) {
            preflightIssues.push(`in[${k}].prev.index=${tagAny(po ? po.index : undefined)}`);
          }
          if (!(isHexEvenOrEmpty(ss) || isBytesLike(ss))) {
            preflightIssues.push(`in[${k}].signatureScript=${tagAny(ss)}`);
          }
  
          const u = inp ? inp.utxo : undefined;
          const ptr = u && typeof u === "object" ? (u as any).__wbg_ptr : undefined;
          if (!(u && typeof u === "object" && typeof ptr === "number")) {
            preflightIssues.push(`in[${k}].utxo=${tagUref(u)}`);
          }
        }
  
        for (let k = 0; k < iTx.outputs.length; k++) {
          const out: any = iTx.outputs[k];
          const spk: any = out ? out.scriptPublicKey : undefined;
          let script: any = spk;
          if (spk && typeof spk === "object" && !(spk instanceof Uint8Array) && !Array.isArray(spk)) {
            script = (spk as any).script ?? (spk as any).scriptPublicKey ?? (spk as any).data;
          }
          if (!(isHexEvenOrEmpty(script) || isBytesLike(script))) {
            preflightIssues.push(`out[${k}].scriptPublicKey=${tagSpk(spk)}`);
          }
        }
  
        console.log(
          `[swap_accept] itx_preflight_issues count=${preflightIssues.length}${preflightIssues.length ? " " + preflightIssues.join(" | ") : ""}`
        );
  
        stage = "tx_new_transaction_ctor";
        let tx: any;
        try {
          tx = new Transaction(iTx);
        } catch (e) {
          console.log(`[swap_accept] tx_new_transaction_error`, e);
          throw e;
        }
  
        stage = "tx_sign_inputs";

        let unsignedSafeLen = -1;
        try {
          const s = tx.serializeToSafeJSON();
          unsignedSafeLen = typeof s === "string" ? s.length : -1;
        } catch {}

        let unsignedMass: any = "na";
        let unsignedFee: any = "na";
        try { unsignedMass = calculateTransactionMass(networkId, tx); } catch (e) { unsignedMass = `err:${String(e)}`; }
        try { unsignedFee = calculateTransactionFee(networkId, tx); } catch (e) { unsignedFee = `err:${String(e)}`; }

        console.log(
          `[swap_accept] unsigned_fee_probe safeLen=${String(unsignedSafeLen)} mass=${String(unsignedMass)} fee=${String(unsignedFee)}`
        );

        const inputsToSign: number[] = [];
        for (let i = baseInCount; i < txShape.inputs.length; i++) inputsToSign.push(i);

        const buildBcwDirectSwapFinalizeAttempt = (
          txToFinalizeSafeJson: string,
          outputsForIntent: any[],
          signInputIndexes: number[]
        ) => {
          const bcwNetwork = walletNetworkToBcwDirectSwapNetwork(active.network);
          if (!bcwNetwork) {
            return { ok: false as const, reason: "bcw_direct_swap_network_invalid" };
          }
          if (!offerIdForIntent) {
            return { ok: false as const, reason: "bcw_direct_swap_offer_id_missing" };
          }

          const expectedOutputSpkHexes = outputsForIntent.map((out: any) => {
            const spk = out && out.scriptPublicKey ? out.scriptPublicKey : null;
            if (typeof spk === "string" && /^[0-9a-fA-F]+$/.test(spk) && spk.length % 2 === 0) {
              return spk.toLowerCase();
            }
            if (spk && typeof spk === "object" && typeof spk.version === "number" && typeof spk.script === "string") {
              const script = spk.script.trim().toLowerCase();
              if (/^[0-9a-f]+$/.test(script) && script.length % 2 === 0) {
                return `${(spk.version >>> 0).toString(16).padStart(4, "0")}${script}`;
              }
            }
            return "";
          });

          if (expectedOutputSpkHexes.some((spk: string) => !spk)) {
            return { ok: false as const, reason: "bcw_direct_swap_expected_output_spk_missing" };
          }

          const createdAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
          const intent: BcwDirectSwapFinalizeIntentV1 = {
            v: 1,
            purpose: "bcw_direct_swap_finalize",
            wallet_id: String(active.id || ""),
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: bcwNetwork,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: active.address0,
            offer_id: offerIdForIntent,
            kind,
            tx_safe_json_sha256: sha256Utf8Hex(txToFinalizeSafeJson),
            sign_input_indexes: signInputIndexes,
            expected_output_spk_hexes: expectedOutputSpkHexes,
            user_auth_pubkey: userAuthPubkey,
            created_at: createdAt,
            expires_at: expiresAt,
            nonce: newBcwDirectSwapFinalizeNonce()
          };
          const intentMessage = canonicalBcwDirectSwapFinalizeIntentMessage(intent);

          bcwDirectSwapFinalizePrepCache.set(rid, {
            createdAtMs: Date.now(),
            userId,
            walletId: String(active.id || ""),
            networkId,
            kind,
            offerId: offerIdForIntent,
            txSafeJson: txToFinalizeSafeJson,
            makerOutputSpk: outputsForIntent[0]?.scriptPublicKey,
            intent,
            intentMessage
          });

          return {
            ok: false as const,
            needBcwDirectSwapFinalize: true as const,
            txToSignSafeJson: txToFinalizeSafeJson,
            intent,
            intentMessage
          };
        };

        const takerInputSigs = Array.isArray((body as any).takerInputSigs) ? (body as any).takerInputSigs : null;
        if (!takerInputSigs || takerInputSigs.length !== inputsToSign.length) {
          if (isBcwBrokerCustody) {
            const dummySignatureScriptHex = "00".repeat(64);
            for (let i = baseInCount; i < txShape.inputs.length; i++) {
              txShape.inputs[i].signatureScript = dummySignatureScriptHex;
            }
          } else {
            const txToSignSafeJson = tx.serializeToSafeJSON();
            return {
              ok: false as const,
              needSign: true as const,
              reason: "missing_takerInputSigs",
              txToSignSafeJson,
              inputsToSign
            };
          }
        } else {
          for (let i = baseInCount; i < txShape.inputs.length; i++) {
            const sig = takerInputSigs[i - baseInCount];
            txShape.inputs[i].signatureScript = sig;
          }
        }
  
        stage = "tx_fee_calc";

        const reqPskb: any = (body as any)?.psktRequest?.pskb;
        const reqPskbLen: number = typeof reqPskb === "string" ? reqPskb.length : -1;
        const reqPskbTag: string = typeof reqPskb === "string" ? reqPskb.slice(0, 8) : "na";
        const reqKind: any = (body as any)?.psktRequest?.kind;
        console.log(`[swap_accept] req_probe kind=${String(reqKind)} pskbLen=${String(reqPskbLen)} pskbTag=${reqPskbTag}`);

        let requiredFee: bigint | undefined;
        try {
          const iTxSigned: any = {
            version: iTx.version,
            lockTime: iTx.lockTime,
            gas: iTx.gas,
            payload: iTx.payload,
            subnetworkId: iTx.subnetworkId,
            inputs: iTx.inputs.map((inp: any, k: number) => {
              const ss =
                txShape &&
                Array.isArray((txShape as any).inputs) &&
                (txShape as any).inputs[k] &&
                typeof (txShape as any).inputs[k].signatureScript === "string"
                  ? (txShape as any).inputs[k].signatureScript
                  : inp.signatureScript;
              return { ...inp, signatureScript: ss };
            }),
            outputs: iTx.outputs
          };

          const pay: any = iTxSigned.payload;
          const payType =
            pay === null ? "null" : pay instanceof Uint8Array ? "Uint8Array" : Array.isArray(pay) ? "array" : typeof pay;

          let payLen = -1;
          if (typeof pay === "string") {
            payLen = pay.length;
          } else if (pay instanceof Uint8Array) {
            payLen = pay.length;
          } else if (Array.isArray(pay)) {
            payLen = pay.length;
          } else if (pay && typeof pay === "object") {
            const d: any = (pay as any).data ?? (pay as any).payload ?? (pay as any).bytes;
            if (typeof d === "string") payLen = d.length;
            else if (d instanceof Uint8Array) payLen = d.length;
            else if (Array.isArray(d)) payLen = d.length;
          }

          let payTag = "na";
          if (typeof pay === "string") {
            payTag = pay.slice(0, 8);
          } else if (pay instanceof Uint8Array && pay.length >= 4) {
            payTag = String.fromCharCode(pay[0], pay[1], pay[2], pay[3]);
          }

          const payKeys =
            pay && typeof pay === "object" && !(pay instanceof Uint8Array) && !Array.isArray(pay) ? Object.keys(pay).slice(0, 12).join(",") : "na";

          console.log(`[swap_accept] payload_probe type=${payType} len=${String(payLen)} tag=${payTag} keys=${payKeys}`);

          let itxSignedJsonLen = -1;
          try { itxSignedJsonLen = JSON.stringify(iTxSigned).length; } catch {}
          const itxTopKeys = Object.keys(iTxSigned).slice(0, 24).join(",");
          console.log(`[swap_accept] itxSigned_probe topKeys=${itxTopKeys} jsonLen=${String(itxSignedJsonLen)}`);

          for (let k = 0; k < iTxSigned.inputs.length; k++) {
            const inp: any = iTxSigned.inputs[k];
            const keys =
              inp && typeof inp === "object" && !(inp instanceof Uint8Array) && !Array.isArray(inp)
                ? Object.keys(inp).slice(0, 24).join(",")
                : "na";

            let jsonLen = -1;
            try { jsonLen = JSON.stringify(inp).length; } catch {}

            const redeem: any = inp ? (inp as any).redeemScript : undefined;
            const redeemLen =
              typeof redeem === "string"
                ? redeem.length
                : redeem instanceof Uint8Array
                  ? redeem.length
                  : Array.isArray(redeem)
                    ? redeem.length
                    : -1;

            const utxo: any = inp ? (inp as any).utxoEntry : undefined;
            let utxoJsonLen = -1;
            try { utxoJsonLen = utxo ? JSON.stringify(utxo).length : -1; } catch {}

            const props: any = inp ? (inp as any).proprietaries : undefined;
            let propsJsonLen = -1;
            try { propsJsonLen = props ? JSON.stringify(props).length : -1; } catch {}

            console.log(
              `[swap_accept] itxSigned_in_probe i=${k} keys=${keys} jsonLen=${String(jsonLen)} redeemLen=${String(redeemLen)} utxoJsonLen=${String(utxoJsonLen)} propsJsonLen=${String(propsJsonLen)}`
            );
          }

          for (let j = 0; j < iTxSigned.outputs.length; j++) {
            const out: any = iTxSigned.outputs[j];
            const keys =
              out && typeof out === "object" && !(out instanceof Uint8Array) && !Array.isArray(out)
                ? Object.keys(out).slice(0, 24).join(",")
                : "na";

            let jsonLen = -1;
            try { jsonLen = JSON.stringify(out).length; } catch {}

            const redeem: any = out ? (out as any).redeemScript : undefined;
            const redeemLen =
              typeof redeem === "string"
                ? redeem.length
                : redeem instanceof Uint8Array
                  ? redeem.length
                  : Array.isArray(redeem)
                    ? redeem.length
                    : -1;

            const props: any = out ? (out as any).proprietaries : undefined;
            let propsJsonLen = -1;
            try { propsJsonLen = props ? JSON.stringify(props).length : -1; } catch {}

            console.log(
              `[swap_accept] itxSigned_out_probe j=${j} keys=${keys} jsonLen=${String(jsonLen)} redeemLen=${String(redeemLen)} propsJsonLen=${String(propsJsonLen)}`
            );
          }

          const txSigned = new Transaction(iTxSigned);

          let signedSafeLen = -1;
          try {
            const s = txSigned.serializeToSafeJSON();
            signedSafeLen = typeof s === "string" ? s.length : -1;
          } catch {}

          let signedMass: any = "na";
          let signedFee: any = "na";
          try { signedMass = calculateTransactionMass(networkId, txSigned); } catch (e) { signedMass = `err:${String(e)}`; }
          try { signedFee = calculateTransactionFee(networkId, txSigned); } catch (e) { signedFee = `err:${String(e)}`; }

          console.log(
            `[swap_accept] signed_fee_probe safeLen=${String(signedSafeLen)} mass=${String(signedMass)} fee=${String(signedFee)}`
          );
  
          const sdkNet = rpcNetworkIdFromAppNetworkKey(appNetworkKeyFromWalletNetwork(active.network));
          const maxMass = maximumStandardTransactionMass();
          let massOk: any = undefined;
          let massVal: any = undefined;
          try {
            massOk = updateTransactionMass(sdkNet, txSigned);
            massVal = (txSigned as any).mass;
          } catch (e) {
            console.log(`[swap_accept] mass_calc_error`, e);
          }
  
          const delta = typeof massVal === "bigint" ? massVal - maxMass : undefined;
          console.log(
            `[swap_accept] mass_probe ok=${String(massOk)} mass=${String(massVal)} max=${String(maxMass)} delta=${delta === undefined ? "na" : String(delta)}`
          );
  
          for (let k = 0; k < iTxSigned.inputs.length; k++) {
            const inp: any = iTxSigned.inputs[k];
            const ss: any = inp ? inp.signatureScript : undefined;
            const soc: any = inp ? inp.sigOpCount : undefined;
            const ssLen =
              typeof ss === "string"
                ? ss.length
                : ss instanceof Uint8Array
                  ? ss.length
                  : Array.isArray(ss)
                    ? ss.length
                    : -1;
            console.log(
              `[swap_accept] mass_hint in[${k}] sigScriptLen=${ssLen} sigOpCount=${String(soc)} sigOpType=${soc === null ? "null" : Array.isArray(soc) ? "array" : typeof soc}`
            );
          }
  
          for (let j = 0; j < iTxSigned.outputs.length; j++) {
            const out: any = iTxSigned.outputs[j];
            const spk: any = out ? out.scriptPublicKey : undefined;
            let script: any = spk;
            if (spk && typeof spk === "object" && !(spk instanceof Uint8Array) && !Array.isArray(spk)) {
              script = (spk as any).script ?? (spk as any).scriptPublicKey ?? (spk as any).data;
            }
            const spkLen =
              typeof script === "string"
                ? script.length
                : script instanceof Uint8Array
                  ? script.length
                  : Array.isArray(script)
                    ? script.length
                    : -1;
  
            const v: any = out ? out.value : undefined;
            console.log(
              `[swap_accept] mass_hint out[${j}] value=${String(v)} valueType=${v === null ? "null" : typeof v} spkLen=${spkLen} spkType=${script === null ? "null" : Array.isArray(script) ? "array" : script instanceof Uint8Array ? "Uint8Array" : typeof script}`
            );
          }
  
          if (massOk === false) {
            try {
              const m = calculateTransactionMass(sdkNet, txSigned);
              const max = maximumStandardTransactionMass();
              console.log(`[swap_accept] calc_mass_probe mass=${String(m)} max=${String(max)} delta=${String(m - max)}`);

              const out0Any: any = iTxSigned.outputs && iTxSigned.outputs[0] ? iTxSigned.outputs[0] : null;
              const out1Any: any = iTxSigned.outputs && iTxSigned.outputs[1] ? iTxSigned.outputs[1] : null;
              const out2Any: any = iTxSigned.outputs && iTxSigned.outputs[2] ? iTxSigned.outputs[2] : null;

              const out0Value: bigint = readSompi(out0Any?.value) ?? 0n;
              const out0Spk: any = out0Any?.scriptPublicKey;
              const out1Spk: any = out1Any?.scriptPublicKey;
              const out2Spk: any = out2Any?.scriptPublicKey;

              const in0Amt: bigint =
                readSompi((iTxSigned.inputs && iTxSigned.inputs[0] ? iTxSigned.inputs[0] : null)?.utxo?.amount) ??
                readSompi((iTxSigned.inputs && iTxSigned.inputs[0] ? iTxSigned.inputs[0] : null)?.utxoEntry?.amount) ??
                0n;

              const in1Amt: bigint =
                readSompi((iTxSigned.inputs && iTxSigned.inputs[1] ? iTxSigned.inputs[1] : null)?.utxo?.amount) ??
                readSompi((iTxSigned.inputs && iTxSigned.inputs[1] ? iTxSigned.inputs[1] : null)?.utxoEntry?.amount) ??
                0n;

              const sweepTotalIn = in0Amt + in1Amt;

              if (sweepTotalIn > 0n && out0Value > 0n && typeof out0Spk === "string" && typeof out1Spk === "string" && typeof out2Spk === "string") {
                const sweepCandidates: bigint[] = [
                  kaspaToSompi("0.05"),
                  kaspaToSompi("0.10"),
                  kaspaToSompi("0.20"),
                  kaspaToSompi("0.30"),
                  kaspaToSompi("0.33"),
                  kaspaToSompi("0.50")
                ].filter((v): v is bigint => typeof v === "bigint");

                const massSweepOut2: any[] = [];
                for (const out2v of sweepCandidates) {
                  const changeV = sweepTotalIn - (out0Value + out2v);
                  if (changeV < 0n) {
                    massSweepOut2.push({
                      out2Sompi: out2v.toString(),
                      out1Sompi: changeV.toString(),
                      ok: false,
                      reason: "negative_change"
                    });
                    continue;
                  }

                  const iTxSweep: any = {
                    ...iTxSigned,
                    outputs: [
                      { value: out0Value, scriptPublicKey: out0Spk },
                      { value: changeV, scriptPublicKey: out1Spk },
                      { value: out2v, scriptPublicKey: out2Spk }
                    ]
                  };

                  let mm: bigint | null = null;
                  let err = "";
                  try {
                    mm = calculateTransactionMass(sdkNet, new Transaction(iTxSweep));
                  } catch (e2: any) {
                    mm = null;
                    err = e2 && typeof e2.message === "string" ? e2.message : String(e2);
                  }

                  massSweepOut2.push({
                    out2Sompi: out2v.toString(),
                    out1Sompi: changeV.toString(),
                    ok: mm !== null,
                    mass: mm === null ? null : mm.toString(),
                    error: err ? err : undefined
                  });
                }

                console.log(`[swap_accept] mass_sweep_out2`, massSweepOut2);
              } else {
                console.log(`[swap_accept] mass_sweep_out2_skip`, {
                  sweepTotalIn: sweepTotalIn.toString(),
                  out0Value: out0Value.toString(),
                  out0SpkType: typeof out0Spk,
                  out1SpkType: typeof out1Spk,
                  out2SpkType: typeof out2Spk
                });
              }
            } catch (e) {
              console.log(`[swap_accept] calc_mass_error`, e);
            }
          }

          requiredFee = directSwapToccataRequiredFee(sdkNet, txSigned, "tx_mass_exceeds_standard");
        } catch (e) {
          console.log(`[swap_accept] fee_calc_error`, e);
          throw e;
        }
        if (requiredFee === undefined) {
          throw new Error("tx_mass_exceeds_standard");
        }
  
        let selectedSum = 0n;
        for (const e of selected) {
          const v = readSompi((e as any)?.utxoEntry?.amount ?? (e as any)?.amount) ?? 0n;
          selectedSum += v;
        }
  
        const totalInputs = commitAmt + selectedSum;
  
        if (withChange) {
          const change = totalInputs - out0Value - requiredFee;
          if (change <= 0n) {
            return { ok: false as const, needMore: true as const };
          }
  
          const changeIndex = baseOutCount;

          txShape.outputs[changeIndex].value = change.toString();
  
          stage = "tx_change_resign_ctor";
          const iTxResign: any = {
            version: iTx.version,
            lockTime: iTx.lockTime,
            gas: iTx.gas,
            payload: iTx.payload,
            subnetworkId: iTx.subnetworkId,
            inputs: iTx.inputs.map((inp: any, k: number) => {
              if (k < baseInCount) return inp;
              return { ...inp, signatureScript: "" };
            }),
            outputs: iTx.outputs.map((out: any, j: number) => {
              if (j !== changeIndex) return out;
              return { ...out, value: change };
            })
          };
  
          const inputsToSign2: number[] = [];
          for (let i = baseInCount; i < txShape.inputs.length; i++) inputsToSign2.push(i);

          const takerResignInputSigs = Array.isArray((body as any).takerResignInputSigs)
            ? (body as any).takerResignInputSigs
            : null;

          if (!takerResignInputSigs || takerResignInputSigs.length !== inputsToSign2.length) {
            const txToResignSafeJson = new Transaction(iTxResign).serializeToSafeJSON();
            if (isBcwBrokerCustody) {
              return buildBcwDirectSwapFinalizeAttempt(txToResignSafeJson, iTxResign.outputs, inputsToSign2);
            }
            return {
              ok: false as const,
              needResign: true as const,
              reason: "missing_takerResignInputSigs",
              txToResignSafeJson,
              inputsToSign: inputsToSign2
            };
          }

          stage = "tx_change_resign_sign";
          for (let i = baseInCount; i < txShape.inputs.length; i++) {
            const sig = takerResignInputSigs[i - baseInCount];
            txShape.inputs[i].signatureScript = sig;
          }

          return { ok: true as const, txShape, requiredFee, change };
        } else {
          const delta = totalInputs - out0Value - requiredFee;
          if (delta < 0n) return { ok: false as const, needMore: true as const };
          if (delta === 0n) return { ok: true as const, txShape, requiredFee, change: 0n };
  
          // If change would be dust, do not create change output; treat remainder as priority fee.
          if (delta < MIN_CHANGE_SOMPI) {
            const bumpedFee = requiredFee + delta;
            return { ok: true as const, txShape, requiredFee: bumpedFee, change: 0n };
          }
  
          return { ok: false as const, needChange: true as const, changeHint: delta };
        }
      };
  
      stage = "select_and_build";
      const selected: any[] = [];
      let cursor = 0;
  
      while (true) {
        if (cursor >= takerEntries.length) {
          return res.status(409).json({ ok: false, reason: "insufficient_utxos" });
        }
        selected.push(takerEntries[cursor++]);
  
        let a0: any;
        try {
          a0 = buildTxAttempt(selected, false);
        } catch (e) {
          return res.status(500).json({ ok: false, reason: "swap_accept_build_failed", stage, error: String(e) });
        }
  
        if (a0 && a0.needBcwDirectSwapFinalize) {
          return res.json({
            ok: true,
            stage: "bcw_direct_swap_finalize_intent",
            acceptRid: rid,
            kind,
            p2shAddress,
            pskb,
            custody_model: "broker_1of1",
            bcw_direct_swap_finalize_intent: a0.intent,
            intent_message: a0.intentMessage
          });
        }

        if (a0 && a0.needSign) {
          const txToSignSafeJson = a0.txToSignSafeJson;
          return res.json({
            ok: true,
            stage: "prepare",
            acceptRid: rid,
            kind,
            p2shAddress,
            pskb,
            txToSignSafeJson,
            inputsToSign: a0.inputsToSign
          });
        }

        if (a0 && a0.needResign) {
          const txToResignSafeJson = a0.txToResignSafeJson;
          return res.json({
            ok: true,
            stage: "resign_prepare",
            acceptRid: rid,
            kind,
            p2shAddress,
            pskb,
            txToResignSafeJson,
            inputsToSign: a0.inputsToSign
          });
        }

        if (a0 && a0.ok) {
          const acceptedPayload: any = { ...base, ...a0.txShape };
          acceptedPayload.global = base.global;
  
          const ai0: any = Array.isArray((acceptedPayload as any).inputs) ? (acceptedPayload as any).inputs[0] : null;
          const a0ss: any = ai0 ? (ai0 as any).signatureScript : undefined;
          const a0fss: any = ai0 ? (ai0 as any).finalScriptSig : undefined;
          const a0rs: any = ai0 ? (ai0 as any).redeemScript : undefined;
          const a0ps: any = ai0 ? (ai0 as any).partialSigs : undefined;
          const a0ssLen =
            typeof a0ss === "string" ? a0ss.length : a0ss instanceof Uint8Array ? a0ss.length : Array.isArray(a0ss) ? a0ss.length : -1;
          const a0fssLen =
            typeof a0fss === "string" ? a0fss.length : a0fss instanceof Uint8Array ? a0fss.length : Array.isArray(a0fss) ? a0fss.length : -1;
          const a0rsLen =
            typeof a0rs === "string" ? a0rs.length : a0rs instanceof Uint8Array ? a0rs.length : Array.isArray(a0rs) ? a0rs.length : -1;
          const a0psCtor = a0ps && typeof a0ps === "object" ? String((a0ps as any).constructor?.name ?? "Object") : typeof a0ps;
          const a0psKeys = a0ps && typeof a0ps === "object" ? Object.keys(a0ps).length : 0;
          const a0psSize = a0ps && typeof a0ps === "object" && typeof (a0ps as any).size === "number" ? (a0ps as any).size : -1;
          console.log(
            `[swap_accept] accepted_input0_sigmaterial ss=${typeof a0ss}:${a0ssLen} fss=${typeof a0fss}:${a0fssLen} rs=${typeof a0rs}:${a0rsLen} psCtor=${a0psCtor} psKeys=${a0psKeys} psSize=${a0psSize}`
          );

          const acceptedPskb = encodePskbPayloadArray([acceptedPayload]);
          const vAccept = await validateSwapPskb(repoRoot, { phase: "accept", kind, pskb: acceptedPskb });
          if (!vAccept.ok) {
            return res.status(500).json({
              ok: false,
              reason: "swap_accept_internal_validation_failed",
              errors: vAccept.errors,
              warnings: vAccept.warnings
            });
          }
  
          return res.json({ ok: true, network: networkId, kind, pskb: acceptedPskb });
        }
  
        if (a0 && a0.needMore) continue;
  
        if (a0 && a0.needChange) {
          let a1: any;
          try {
            a1 = buildTxAttempt(selected, true, a0.changeHint);
          } catch (e) {
            return res.status(500).json({ ok: false, reason: "swap_accept_build_failed", stage, error: String(e) });
          }

          if (a1 && a1.needBcwDirectSwapFinalize) {
            return res.json({
              ok: true,
              stage: "bcw_direct_swap_finalize_intent",
              acceptRid: rid,
              kind,
              p2shAddress,
              pskb,
              custody_model: "broker_1of1",
              bcw_direct_swap_finalize_intent: a1.intent,
              intent_message: a1.intentMessage
            });
          }

          if (a1 && a1.needResign) {
            const txToResignSafeJson = a1.txToResignSafeJson;
            return res.json({
              ok: true,
              stage: "resign_prepare",
              acceptRid: rid,
              kind,
              p2shAddress,
              pskb,
              txToResignSafeJson,
              inputsToSign: a1.inputsToSign
            });
          }
  
          if (a1 && a1.ok) {
            const acceptedPayload: any = { ...base, ...a1.txShape };
            acceptedPayload.global = base.global;
  
            const ai0: any = Array.isArray((acceptedPayload as any).inputs) ? (acceptedPayload as any).inputs[0] : null;
            const a0ss: any = ai0 ? (ai0 as any).signatureScript : undefined;
            const a0fss: any = ai0 ? (ai0 as any).finalScriptSig : undefined;
            const a0rs: any = ai0 ? (ai0 as any).redeemScript : undefined;
            const a0ps: any = ai0 ? (ai0 as any).partialSigs : undefined;
            const a0ssLen =
              typeof a0ss === "string" ? a0ss.length : a0ss instanceof Uint8Array ? a0ss.length : Array.isArray(a0ss) ? a0ss.length : -1;
            const a0fssLen =
              typeof a0fss === "string" ? a0fss.length : a0fss instanceof Uint8Array ? a0fss.length : Array.isArray(a0fss) ? a0fss.length : -1;
            const a0rsLen =
              typeof a0rs === "string" ? a0rs.length : a0rs instanceof Uint8Array ? a0rs.length : Array.isArray(a0rs) ? a0rs.length : -1;
            const a0psCtor = a0ps && typeof a0ps === "object" ? String((a0ps as any).constructor?.name ?? "Object") : typeof a0ps;
            const a0psKeys = a0ps && typeof a0ps === "object" ? Object.keys(a0ps).length : 0;
            const a0psSize = a0ps && typeof a0ps === "object" && typeof (a0ps as any).size === "number" ? (a0ps as any).size : -1;
            console.log(
              `[swap_accept] accepted_input0_sigmaterial ss=${typeof a0ss}:${a0ssLen} fss=${typeof a0fss}:${a0fssLen} rs=${typeof a0rs}:${a0rsLen} psCtor=${a0psCtor} psKeys=${a0psKeys} psSize=${a0psSize}`
            );
  
            const acceptedPskb = encodePskbPayloadArray([acceptedPayload]);
            const vAccept = await validateSwapPskb(repoRoot, { phase: "accept", kind, pskb: acceptedPskb });
            if (!vAccept.ok) {
              return res.status(500).json({
                ok: false,
                reason: "swap_accept_internal_validation_failed",
                errors: vAccept.errors,
                warnings: vAccept.warnings
              });
            }
  
            return res.json({ ok: true, network: networkId, kind, pskb: acceptedPskb });
          }
  
          continue;
        }
      }
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "swap_accept_failed", stage, rid, error: String(err) });
    } finally {
      // keep shared RPC connected
    }
  });
  
  app.post("/api/swaps/finalize", async (req, res) => {
    let rpc: RpcClient | null = null;
    let stage = "start";
    const rid = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  
    try {
      await ensureKaspaReady(repoRoot);
  
      stage = "parse_body";
      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }
  
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
        return res.status(400).json({ ok: false, reason: "invalid_kind" });
      }
  
      const pskb = typeof body.pskb === "string" ? body.pskb.trim() : "";
      if (!pskb) {
        return res.status(400).json({ ok: false, reason: "missing_pskb" });
      }
  
      stage = "load_wallet";
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const store = readWalletStore(repoRoot, userId);
      const active = store.active_id ? (store.items.find((w: any) => w.id === store.active_id) ?? null) : null;
  
      if (!active) return res.status(409).json({ ok: false, reason: "no_active_wallet" });
      if (active.state !== "READY") return res.status(409).json({ ok: false, reason: "wallet_not_ready" });

      const isComplianceWallet = active.wallet_type === "compliance";
      if (isComplianceWallet) {
        return res.status(409).json({
          ok: false,
          reason: "legacy_compliance_direct_swap_finalize_removed",
          error: "Legacy 2-of-2 Compliance Wallet direct finalize has been removed. Use the broker-custody Compliance Wallet direct swap path."
        });
      }

      if (!active.user_pubkey || typeof active.user_pubkey !== "string" || !active.user_pubkey.trim()) {
        return res.status(409).json({ ok: false, reason: "wallet_missing_user_pubkey" });
      }

      const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKeyFromWalletNetwork(active.network));
      rpc = await getSharedRpc(networkId);
  
      stage = "validate_accept_pskb";
      const vAccept = await validateSwapPskb(repoRoot, { phase: "accept", kind, pskb });
      if (!vAccept.ok) {
        return res.status(400).json({
          ok: false,
          reason: "swap_accept_invalid",
          errors: vAccept.errors,
          warnings: vAccept.warnings
        });
      }
  
      stage = "decode_and_lock";
      const arr = decodePskbPayloadArray(pskb);
      if (arr.length !== 1) {
        return res.status(400).json({ ok: false, reason: "pskb_must_contain_single_pskt_for_m4a" });
      }
  
      const payload: any = arr[0];
      if (!payload || typeof payload !== "object" || !payload.global || typeof payload.global !== "object") {
        return res.status(400).json({ ok: false, reason: "pskb_global_missing" });
      }
  
      const fi0: any = Array.isArray((payload as any).inputs) ? (payload as any).inputs[0] : null;
      const f0ss: any = fi0 ? (fi0 as any).signatureScript : undefined;
      const f0fss: any = fi0 ? (fi0 as any).finalScriptSig : undefined;
      const f0rs: any = fi0 ? (fi0 as any).redeemScript : undefined;
      const f0ps: any = fi0 ? (fi0 as any).partialSigs : undefined;
      const f0ssLen =
        typeof f0ss === "string" ? f0ss.length : f0ss instanceof Uint8Array ? f0ss.length : Array.isArray(f0ss) ? f0ss.length : -1;
      const f0fssLen =
        typeof f0fss === "string" ? f0fss.length : f0fss instanceof Uint8Array ? f0fss.length : Array.isArray(f0fss) ? f0fss.length : -1;
      const f0rsLen =
        typeof f0rs === "string" ? f0rs.length : f0rs instanceof Uint8Array ? f0rs.length : Array.isArray(f0rs) ? f0rs.length : -1;
      const f0psCtor = f0ps && typeof f0ps === "object" ? String((f0ps as any).constructor?.name ?? "Object") : typeof f0ps;
      const f0psKeys = f0ps && typeof f0ps === "object" ? Object.keys(f0ps).length : 0;
      const f0psSize = f0ps && typeof f0ps === "object" && typeof (f0ps as any).size === "number" ? (f0ps as any).size : -1;
      console.log(
        `[swap_finalize] payload_input0_sigmaterial ss=${typeof f0ss}:${f0ssLen} fss=${typeof f0fss}:${f0fssLen} rs=${typeof f0rs}:${f0rsLen} psCtor=${f0psCtor} psKeys=${f0psKeys} psSize=${f0psSize}`
      );

      payload.global.inputsModifiable = false;
      payload.global.outputsModifiable = false;
  
      const lockedPskb = encodePskbPayloadArray([payload]);
  
      stage = "validate_finalize_pskb";
      const vFinal = await validateSwapPskb(repoRoot, { phase: "finalize", kind, pskb: lockedPskb });
      if (!vFinal.ok) {
        return res.status(500).json({
          ok: false,
          reason: "swap_finalize_internal_validation_failed",
          errors: vFinal.errors,
          warnings: vFinal.warnings
        });
      }
  
      stage = "submit_build_itx";
  
      const toBigInt0 = (v: any): bigint => {
        if (typeof v === "bigint") return v;
        if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
        if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
        return 0n;
      };
  
      const subnetworkIdNative = "0000000000000000000000000000000000000000";
  
      const g: any = (payload as any).global ?? {};
      const iTxSubmit: any = {
        version: typeof g.txVersion === "number" ? g.txVersion : 0,
        lockTime: toBigInt0(g.fallbackLockTime),
        gas: 0n,
        payload: "",
        subnetworkId: subnetworkIdNative,
        inputs: [],
        outputs: []
      };
  
      if (Array.isArray((payload as any).inputs)) {
        for (let i = 0; i < (payload as any).inputs.length; i++) {
          const inp: any = (payload as any).inputs[i];
          if (!inp || typeof inp !== "object") continue;
  
          const prev: any = inp.previousOutpoint ?? null;
  
          let ssUse = "";
          if (i === 0) {
            stage = "submit_build_itx_input0_sigscript";
  
            const ss: any = inp.signatureScript;
            if (typeof ss !== "string" || ss.length === 0) {
              throw new Error("input0_signatureScript_missing");
            }
            ssUse = ss;
          } else {
            const ss: any = inp.signatureScript;
            if (typeof ss !== "string" || ss.length === 0) {
              throw new Error(`input${i}_signatureScript_missing`);
            }
            ssUse = ss;
          }
  
          iTxSubmit.inputs.push({
            previousOutpoint: prev,
            signatureScript: ssUse,
            sequence: toBigInt0(inp.sequence),
            sigOpCount: typeof inp.sigOpCount === "number" ? inp.sigOpCount : 1
          });
        }
      }
  
      const normalizeScriptPublicKey = (spk: any): any => {
        // SDK typings: ITransactionOutput.scriptPublicKey is IScriptPublicKey | HexString
        if (typeof spk === "string") return spk;
        if (!spk || typeof spk !== "object") {
          throw new Error("invalid scriptPublicKey: expected HexString or {version:number, script:HexString}");
        }
  
        const v = (spk as any).version;
        const s = (spk as any).script;
  
        if (typeof v === "number" && typeof s === "string") {
          return { version: v, script: s };
        }
  
        throw new Error("invalid scriptPublicKey: expected HexString or {version:number, script:HexString}");
      };
  
      if (Array.isArray((payload as any).outputs)) {
        for (let j = 0; j < (payload as any).outputs.length; j++) {
          const out: any = (payload as any).outputs[j];
          if (!out || typeof out !== "object") continue;
  
          const v0 = toBigInt0(out.value ?? out.amount);
          const spk0 = normalizeScriptPublicKey(out.scriptPublicKey);
  
          iTxSubmit.outputs.push({
            value: v0,
            scriptPublicKey: spk0
          });
        }
      }
      stage = "submit_tx_ctor";
      const tx = new Transaction(iTxSubmit);

      stage = "submit_tx_finalize";
      tx.finalize();

      stage = "submit_tx_rpc";
      await rpc.submitTransaction({ transaction: tx });

      queueDirectMakerFilledNotification(
        repoRoot,
        networkId,
        kind,
        tx.id,
        iTxSubmit.outputs[0]?.scriptPublicKey
      );
  
      return res.json({
        ok: true,
        network: networkId,
        kind,
        txid: tx.id,
        pskb: lockedPskb
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "swap_finalize_failed", stage, rid, error: String(err) });
    } finally {
      // keep shared RPC connected
    }
  });
}
