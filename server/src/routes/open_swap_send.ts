import type { Express } from "express";
import crypto from "node:crypto";
import type { AppNetworkKey, RpcNetworkId, WalletNetworkType } from "../types";
import { readUserProfile, type UserNotificationSettings } from "../storage/userStore";
import { sendNotificationEmail } from "../email/smtp";
import {
  appNetworkKeyFromWalletNetwork,
  krc20ToccataFeeRateFloorFromAppNetworkKey,
  normalizeAppNetworkKey,
  rpcNetworkIdFromAppNetworkKey
} from "../networks";

import {
  RpcClient,
  Transaction,
  SighashType,
  payToAddressScript,
  calculateTransactionMass,
  maximumStandardTransactionMass
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";
import { getOpenSwapOffer, upsertOpenSwapOffer, type OpenSwapOfferRecord } from "../storage/openSwapOffersStore";
import {
  calculateEntitlementPackageForUserIds,
  listEntitlementTokenRules,
  upsertEntitlementTokenSale,
  type EntitlementPackageStatusV1,
  type EntitlementTokenRuleV1,
  type EntitlementTokenSaleV1
} from "../storage/entitlementTokenStore";

export type OpenSwapSendCtx = {
  repoRoot: string;

  getSharedRpc: (networkId: string) => Promise<RpcClient>;

  readWalletStore: (
    repoRootPath: string,
    userId: string
  ) => {
    active_id: string | null;
    items: Array<{
      id: string;
      wallet_type: "standard" | "compliance";
      network: WalletNetworkType;
      address0: string;
      state: "PENDING_ENGINE" | "READY";
      user_pubkey?: string;
      custody_model?: "self_1of1" | "broker_1of1" | null;
      broker_custody_key_ref?: string | null;
      user_auth_pubkey?: string | null;
    }>;
  };

  bcwOpenSwapFinalizeSubmit?: (params: {
    repoRootPath: string;
    intent: unknown;
    authSignature: string;
    txSafeJson: string;
  }) => Promise<{ ok: boolean; status: number; data: any }>;

  validateOpenSwapPskbV2: (
    repoRootPath: string,
    args: {
      phase: "offer" | "accept" | "finalize";
      kind: "tick_to_kas" | "ca_to_kas";
      pskb: string;
      expectedSendJsonHex?: string;
      expectedFinalizeRoles?: {
        output0KasReceiverSpkHex: string;
        output1TokenReceiverSpkHex: string;
        output2MakerRefundSpkHex: string;
        output3ChangeSpkHex: string;
      };
    }
  ) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
};

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

function parseOfferBlobText(rawText: string): any {
  const raw = String(rawText || "").trim();
  if (!raw) throw new Error("offer_blob_required");

  let parsed: any = JSON.parse(raw);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("offer_blob_object_required");
  }

  return parsed;
}

function isGtcOpenSwapOffer(offer: any): boolean {
  const rawTtl = offer?.ttl;
  if (rawTtl === 0) return true;
  if (typeof rawTtl === "string") {
    const trimmed = rawTtl.trim();
    return trimmed !== "" && Number(trimmed) === 0;
  }
  return false;
}

function openSwapOfferExpiryRejectReason(offer: any, nowMs: number = Date.now()): string {
  if (isGtcOpenSwapOffer(offer)) return "";

  const expiresAtMs = Date.parse(String(offer?.expiresAt || ""));
  if (!Number.isFinite(expiresAtMs)) return "offer_expires_at_invalid";
  if (expiresAtMs <= nowMs) return "offer_expired";
  return "";
}

function buildCanonicalOpenSwapSendJson(kind: "tick_to_kas" | "ca_to_kas", sell: any): string {
  if (kind === "ca_to_kas") {
    const ca = typeof sell?.ca === "string" ? sell.ca.trim().toLowerCase() : "";
    return ca ? `{"p":"krc-20","op":"send","ca":"${ca}"}` : "";
  }

  const tick = typeof sell?.ticker === "string" ? sell.ticker.trim().toLowerCase() : "";
  return tick ? `{"p":"krc-20","op":"send","tick":"${tick}"}` : "";
}

function buildCanonicalOpenSwapSendJsonHex(kind: "tick_to_kas" | "ca_to_kas", sell: any): string {
  const json = buildCanonicalOpenSwapSendJson(kind, sell);
  return json ? Buffer.from(json, "utf8").toString("hex") : "";
}

function buildOpenSwapOfferId(listRevealTxid: string, termsCommitment: string): string {
  return crypto
    .createHash("sha256")
    .update(`${String(listRevealTxid || "").trim()}\n${String(termsCommitment || "").trim()}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

const PSKB_PREFIX = "PSKB";
const OPEN_SWAP_FINALIZE_CACHE_TTL_MS = 10 * 60 * 1000;
const OPEN_SWAP_FINALIZE_FEE_CONVERGENCE_MAX_PASSES = 8;

type BcwOpenSwapFinalizeIntentV1 = {
  v: 1;
  purpose: "bcw_open_swap_finalize";
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
  output0_maker_kas_receiver_spk_hex: string;
  output1_taker_token_receiver_spk_hex: string;
  output2_maker_refund_spk_hex: string;
  output3_taker_kas_change_spk_hex: string;
  expected_send_json_hex: string;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

type OpenSwapFinalizeCacheEntry = {
  createdAtMs: number;
  userId: string;
  networkId: WalletNetworkType;
  kind: "tick_to_kas" | "ca_to_kas";
  offerId: string;
  txToSignObj: any;
  signInputIndexes: number[];
  takerTokenReceiveAddress: string;
  expectedSendJsonHex: string;
  makerSendPskt0: any;
  isComplianceWallet: boolean;
  bcwOpenSwapFinalizeIntent?: BcwOpenSwapFinalizeIntentV1 | null;
  bcwOpenSwapFinalizeIntentMessage?: string | null;
  txToSignSafeJson?: string | null;
};

const openSwapFinalizeCache = new Map<string, OpenSwapFinalizeCacheEntry>();

type OpenSwapMakerFillReceipt = {
  offerId: string;
  networkId: string;
  kind: "tick_to_kas" | "ca_to_kas";
  sellSymbol: string;
  tokenName: string;
  tokenCa: string;
  sellAmount: string;
  buyAmountKas: string;
  makerKasReceiveAddress: string;
  takerTokenReceiveAddress: string;
  txid: string;
  filledAt: string;
};

function receiptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function receiptHex64(value: unknown): string {
  const s = receiptString(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

function buildOpenSwapMakerFillReceipt(
  existingOffer: OpenSwapOfferRecord,
  cached: OpenSwapFinalizeCacheEntry,
  txid: string,
  filledAt: string
): OpenSwapMakerFillReceipt {
  const sell = existingOffer.offerDraft && typeof existingOffer.offerDraft === "object"
    ? (existingOffer.offerDraft as any).sell
    : null;

  const sellSymbol = receiptString(existingOffer.sellSymbol) || receiptString(sell?.symbol) || receiptString(sell?.ticker);
  const tokenName = receiptString(sell?.name);
  const tokenCa = receiptHex64(sell?.ca);

  return {
    offerId: receiptString(existingOffer.offerId) || cached.offerId,
    networkId: receiptString(existingOffer.networkId) || cached.networkId,
    kind: existingOffer.kind || cached.kind,
    sellSymbol,
    tokenName,
    tokenCa,
    sellAmount: receiptString(existingOffer.sellAmount) || receiptString(sell?.amount),
    buyAmountKas: receiptString(existingOffer.buyAmountKas),
    makerKasReceiveAddress: receiptString(existingOffer.makerKasReceiveAddress).toLowerCase(),
    takerTokenReceiveAddress: receiptString(cached.takerTokenReceiveAddress).toLowerCase(),
    txid: receiptHex64(txid),
    filledAt
  };
}

function formatOpenSwapMakerFillReceiptText(receipt: OpenSwapMakerFillReceipt): string {
  return [
    "An open maker offer was filled.",
    "",
    `Offer ID: ${receipt.offerId}`,
    `Network: ${receipt.networkId}`,
    `Kind: ${receipt.kind}`,
    `Token name: ${receipt.tokenName || "(not provided)"}`,
    `Token CA: ${receipt.tokenCa || "(not applicable)"}`,
    `Sell asset: ${receipt.sellSymbol}`,
    `Sell amount (RAW/display input): ${receipt.sellAmount}`,
    `Buy amount (KAS): ${receipt.buyAmountKas}`,
    `Seller KAS receive address: ${receipt.makerKasReceiveAddress}`,
    `Recipient token address: ${receipt.takerTokenReceiveAddress}`,
    `TxID: ${receipt.txid}`,
    `Filled at: ${receipt.filledAt}`
  ].join("\n");
}

type EntitlementRecorderResult = {
  warning: string;
  rule: EntitlementTokenRuleV1 | null;
  sale: EntitlementTokenSaleV1 | null;
  status: EntitlementPackageStatusV1 | null;
};

function entitlementRecorderResult(
  warning = "",
  rule: EntitlementTokenRuleV1 | null = null,
  sale: EntitlementTokenSaleV1 | null = null,
  status: EntitlementPackageStatusV1 | null = null
): EntitlementRecorderResult {
  return { warning, rule, sale, status };
}

function recordEntitlementTokenSaleFromMakerFillReceipt(
  repoRoot: string,
  receipt: OpenSwapMakerFillReceipt,
  userId: string
): EntitlementRecorderResult {
  if (receipt.kind !== "ca_to_kas") return entitlementRecorderResult();
  if (receipt.networkId !== "mainnet") return entitlementRecorderResult();

  try {
    const matchingRules = listEntitlementTokenRules(repoRoot).filter((rule) => {
      if (rule.status !== "active") return false;
      if (rule.network !== "mainnet") return false;
      if (receiptHex64(rule.trigger_ca) !== receipt.tokenCa) return false;
      if (receiptString(rule.seller_address).toLowerCase() !== receipt.makerKasReceiveAddress) return false;
      return true;
    });

    if (matchingRules.length === 0) return entitlementRecorderResult();
    if (matchingRules.length > 1) return entitlementRecorderResult("entitlement_recorder_multiple_matching_rules");

    const rule = matchingRules[0];
    if (!receipt.txid) return entitlementRecorderResult("entitlement_recorder_missing_txid", rule);
    if (!receipt.takerTokenReceiveAddress.startsWith("kaspa:")) return entitlementRecorderResult("entitlement_recorder_missing_recipient_address", rule);
    if (!receipt.sellAmount) return entitlementRecorderResult("entitlement_recorder_missing_amount", rule);
    const saleUserId = receiptString(userId);
    if (!saleUserId) return entitlementRecorderResult("entitlement_recorder_missing_user_id", rule);

    const sale = upsertEntitlementTokenSale(repoRoot, {
      sale_txid: receipt.txid,
      rule_id: rule.id,
      package_type: rule.package_type,
      network: "mainnet",
      trigger_ca: rule.trigger_ca,
      trigger_label: rule.trigger_label,
      seller_address: rule.seller_address,
      recipient_address: receipt.takerTokenReceiveAddress,
      user_id: saleUserId,
      amount_units: receipt.sellAmount,
      accepted_at: receipt.filledAt,
      status: "verified",
      verified_at: receipt.filledAt,
      notes: "Recorded from configured entitlement-token open-swap maker fill receipt."
    });

    const status = calculateEntitlementPackageForUserIds(repoRoot, sale.package_type, [saleUserId], receipt.filledAt);
    return entitlementRecorderResult("", rule, sale, status);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return entitlementRecorderResult(`entitlement_recorder_failed: ${message}`);
  }
}

function warnEntitlementRecorder(reason: string): void {
  if (!reason) return;
  console.warn(`[entitlement-recorder] ${reason}`);
}

function entitlementDateText(value: string | null): string {
  return value ? value : "Not available";
}

function formatEntitlementPurchaseNotificationText(result: EntitlementRecorderResult): string {
  const sale = result.sale;
  if (!sale) return "";

  return [
    `Package: ${sale.package_type}`,
    `Token: ${sale.trigger_label}`,
    `Sale txid: ${sale.sale_txid}`,
    `Recipient address: ${sale.recipient_address}`,
    `Accepted at: ${sale.accepted_at}`,
    `Active until: ${entitlementDateText(result.status?.active_until || null)}`,
    `Grace until: ${entitlementDateText(result.status?.grace_until || null)}`
  ].join("\n");
}

function queueEntitlementPurchaseNotification(repoRoot: string, userId: string, result: EntitlementRecorderResult): void {
  if (!result.sale) return;
  const text = formatEntitlementPurchaseNotificationText(result);
  if (!text) return;

  queueUserNotification(
    repoRoot,
    userId,
    "entitlement_purchase",
    `Token Depot — ${result.sale.package_type} entitlement purchase recorded`,
    text
  );
}

function formatOperatorEntitlementPurchaseNotificationText(
  repoRoot: string,
  userId: string,
  result: EntitlementRecorderResult
): string {
  const rule = result.rule;
  const sale = result.sale;
  if (!rule || !sale) return "";

  let purchaserEmail = "";
  let purchaserPhone = "";
  let purchaserName = "";
  try {
    const profile = readUserProfile(repoRoot, userId);
    purchaserEmail = typeof profile.email === "string" ? profile.email.trim() : "";
    purchaserPhone = typeof profile.phone === "string" ? profile.phone.trim() : "";
    const firstName = typeof profile.first_name === "string" ? profile.first_name.trim() : "";
    const lastName = typeof profile.last_name === "string" ? profile.last_name.trim() : "";
    purchaserName = `${firstName} ${lastName}`.trim();
  } catch {
    purchaserEmail = "";
    purchaserPhone = "";
    purchaserName = "";
  }

  return [
    rule.operator_email_body,
    "",
    `Package: ${sale.package_type}`,
    `Token: ${sale.trigger_label}`,
    `Sale txid: ${sale.sale_txid}`,
    `Purchaser user_id: ${sale.user_id || userId}`,
    `Purchaser name: ${purchaserName || "Not available"}`,
    `Purchaser email: ${purchaserEmail || "Not available"}`,
    `Purchaser phone: ${purchaserPhone || "Not available"}`,
    `Recipient address: ${sale.recipient_address}`,
    `Accepted at: ${sale.accepted_at}`,
    `Active until: ${entitlementDateText(result.status?.active_until || null)}`,
    `Grace until: ${entitlementDateText(result.status?.grace_until || null)}`
  ].join("\n");
}

function queueOperatorEntitlementPurchaseNotification(repoRoot: string, userId: string, result: EntitlementRecorderResult): void {
  const rule = result.rule;
  if (!rule || !result.sale) return;
  if (rule.operator_email_enabled !== true) return;
  if (!rule.operator_email_to) return;

  const text = formatOperatorEntitlementPurchaseNotificationText(repoRoot, userId, result);
  if (!text) return;

  void sendNotificationEmail({
    to: rule.operator_email_to,
    subject: rule.operator_email_subject || `${result.sale.package_type} entitlement purchase recorded`,
    text
  }).catch(() => {});
}

function walletNetworkToBcwOpenSwapNetwork(networkId: WalletNetworkType): "mainnet" | "testnet" | null {
  if (networkId === "mainnet") return "mainnet";
  if (networkId === "testnet") return "testnet";
  return null;
}

function sha256Utf8Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function newBcwOpenSwapFinalizeNonce(): string {
  return `BCWOPENREQ_${Date.now().toString(36)}_${crypto.randomBytes(16).toString("hex")}`;
}

function canonicalBcwOpenSwapFinalizeIntentMessage(intent: BcwOpenSwapFinalizeIntentV1): string {
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
    output0_maker_kas_receiver_spk_hex: intent.output0_maker_kas_receiver_spk_hex,
    output1_taker_token_receiver_spk_hex: intent.output1_taker_token_receiver_spk_hex,
    output2_maker_refund_spk_hex: intent.output2_maker_refund_spk_hex,
    output3_taker_kas_change_spk_hex: intent.output3_taker_kas_change_spk_hex,
    expected_send_json_hex: intent.expected_send_json_hex,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

function newOpenSwapFinalizeRid(): string {
  return `osf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isHexString(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(String(s || ""));
}

function isEvenHexString(s: string): boolean {
  const raw = String(s || "").trim();
  return !!raw && raw.length % 2 === 0 && isHexString(raw);
}

function decodePskbPayloadArray(pskb: string): any[] {
  const raw = String(pskb || "").trim();
  if (!raw.startsWith(PSKB_PREFIX)) throw new Error("pskb_prefix_missing");
  const hex = raw.slice(PSKB_PREFIX.length);
  if (!isEvenHexString(hex)) throw new Error("pskb_hex_invalid");
  const jsonText = Buffer.from(hex, "hex").toString("utf8");
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) throw new Error("pskb_json_must_be_array");
  return parsed;
}

function toPskbJsonValue(v: any): any {
  if (typeof v === "bigint") {
    if (v < 0n) throw new Error("pskb_bigint_negative");
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (v > max) throw new Error("pskb_bigint_unsafe_integer");
    return Number(v);
  }

  if (Array.isArray(v)) {
    return v.map((item) => toPskbJsonValue(item));
  }

  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = toPskbJsonValue(val);
    }
    return out;
  }

  return v;
}

function encodePskbPayloadArray(payloadArr: any[]): string {
  const normalized = toPskbJsonValue(payloadArr);
  const jsonText = JSON.stringify(normalized);
  return PSKB_PREFIX + Buffer.from(jsonText, "utf8").toString("hex");
}

function readSompi(v: any): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) return BigInt(s);
  }
  return null;
}

function appNetworkKeyFromOpenSwapFinalizeRpcNetworkId(networkId: RpcNetworkId): AppNetworkKey {
  if (networkId === "mainnet") return "mainnet";
  if (networkId === "testnet-10") return "tn10";
  throw new Error("open_swap_finalize_network_unsupported");
}

function openSwapFinalizeToccataFeeRateFloor(networkId: RpcNetworkId): number {
  return krc20ToccataFeeRateFloorFromAppNetworkKey(appNetworkKeyFromOpenSwapFinalizeRpcNetworkId(networkId));
}

function openSwapFinalizeToccataRequiredFee(networkId: RpcNetworkId, mass: bigint): bigint {
  return mass * BigInt(openSwapFinalizeToccataFeeRateFloor(networkId));
}

function openSwapFinalizePresignMass(networkId: RpcNetworkId, txObj: any, minimumSignatures: number): bigint | null {
  try {
    return calculateTransactionMass(networkId, new Transaction(txObj), minimumSignatures);
  } catch {
    return null;
  }
}

function openSwapFinalizeTxInputSum(txObj: any): bigint | null {
  const inputs = Array.isArray(txObj?.inputs) ? txObj.inputs : [];
  let total = 0n;
  for (const input of inputs) {
    const amount = readSompi(input?.utxo?.amount);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

function openSwapFinalizeTxOutputSum(txObj: any): bigint | null {
  const outputs = Array.isArray(txObj?.outputs) ? txObj.outputs : [];
  let total = 0n;
  for (const output of outputs) {
    const value = readSompi(output?.value);
    if (value === null) return null;
    total += value;
  }
  return total;
}

function openSwapFinalizeTxFee(txObj: any): bigint | null {
  const inputSum = openSwapFinalizeTxInputSum(txObj);
  const outputSum = openSwapFinalizeTxOutputSum(txObj);
  if (inputSum === null || outputSum === null || inputSum < outputSum) return null;
  return inputSum - outputSum;
}

function normalizeSpkHex(spkAny: any): string {
  const toHex = (v: any): string => {
    if (!v) return "";
    if (typeof v === "string") {
      const s = v.trim();
      return isEvenHexString(s) ? s.toLowerCase() : "";
    }
    if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
    if (Array.isArray(v) && v.every((n) => typeof n === "number")) return Buffer.from(v).toString("hex");
    return "";
  };

  const hx0 = toHex(spkAny);
  if (hx0) {
    if (hx0.startsWith("0000")) return hx0;
    return ("0000" + hx0).toLowerCase();
  }

  if (spkAny && typeof spkAny === "object") {
    const v = (spkAny as any).version;
    const scriptAny = (spkAny as any).script ?? (spkAny as any).scriptPublicKey ?? (spkAny as any).data;
    const sHex = toHex(scriptAny);
    if (typeof v === "number" && sHex) {
      return ((v >>> 0).toString(16).padStart(4, "0") + sHex).toLowerCase();
    }
  }

  return "";
}

type OpenSwapSendCovenantExclusion = {
  inspection_kind: string;
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

function openSwapSendPrintable(value: any): string | null {
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

function openSwapSendReferenceEntry(reference: any): any | null {
  return reference && typeof reference === "object" && reference.entry ? reference.entry : null;
}

function openSwapSendCovenantIdFromReference(reference: any): string | null {
  const entry = openSwapSendReferenceEntry(reference);
  const canonical = entry ? entry.covenantId : undefined;
  return canonical === null || canonical === undefined ? null : openSwapSendPrintable(canonical);
}

function openSwapSendOutpointKeyFromValue(outpoint: any): string {
  if (!outpoint) return "";
  if (typeof outpoint === "string") return outpoint;
  if (outpoint && typeof outpoint.toJSON === "function") return openSwapSendOutpointKeyFromValue(outpoint.toJSON());
  const transactionId = openSwapSendPrintable(outpoint.transactionId ?? outpoint.transaction_id ?? outpoint.txid);
  const rawIndex = outpoint.index ?? outpoint.outputIndex ?? outpoint.output_index;
  const index = rawIndex === null || rawIndex === undefined ? null : Number(rawIndex);
  return transactionId && Number.isFinite(index) ? `${transactionId}:${index}` : "";
}

function openSwapSendOutpointKeyFromReference(reference: any): string {
  const entry = openSwapSendReferenceEntry(reference);
  const candidates = [
    reference && reference.outpoint,
    entry && entry.outpoint,
    reference && reference.utxo && reference.utxo.outpoint,
    reference && reference.utxoEntry && reference.utxoEntry.outpoint
  ];

  for (const candidate of candidates) {
    const key = openSwapSendOutpointKeyFromValue(candidate);
    if (key) return key;
  }
  return "";
}

function applyOpenSwapSendCovenantExclusion(args: {
  networkId: RpcNetworkId;
  address: string;
  entries: any[];
  inspectionKind: string;
}): { entries: any[]; exclusion: OpenSwapSendCovenantExclusion } {
  const rawEntries = Array.isArray(args.entries) ? args.entries : [];
  const covenantOutpoints = new Set<string>();

  for (const entry of rawEntries) {
    const covenantId = openSwapSendCovenantIdFromReference(entry);
    const key = covenantId ? openSwapSendOutpointKeyFromReference(entry) : "";
    if (key) covenantOutpoints.add(key);
  }

  const spendableEntries = rawEntries.filter((entry) => {
    const key = openSwapSendOutpointKeyFromReference(entry);
    return !key || !covenantOutpoints.has(key);
  });

  return {
    entries: spendableEntries,
    exclusion: {
      inspection_kind: args.inspectionKind,
      networkId: args.networkId,
      address: args.address,
      total_entries: rawEntries.length,
      spendable_entries: spendableEntries.length,
      excluded_entries: rawEntries.length - spendableEntries.length,
      excluded_outpoints: Array.from(covenantOutpoints).sort(),
      inspection_path: "reference.entry.covenantId",
      signing_enabled: false,
      broadcasting_enabled: false,
      minting_enabled: false
    }
  };
}

function cloneTxObjectWithSignatures(txToSignObj: any, signaturesByIndex: Map<number, string>): any {
  return {
    version: txToSignObj.version,
    lockTime: txToSignObj.lockTime,
    gas: txToSignObj.gas,
    payload: txToSignObj.payload,
    subnetworkId: txToSignObj.subnetworkId,
    inputs: Array.isArray(txToSignObj.inputs)
      ? txToSignObj.inputs.map((inp: any, idx: number) => ({
          previousOutpoint: {
            transactionId: String(inp?.previousOutpoint?.transactionId || ""),
            index: Number(inp?.previousOutpoint?.index)
          },
          signatureScript: idx === 0
            ? String(inp?.signatureScript || "")
            : String(signaturesByIndex.get(idx) || ""),
          sequence: inp?.sequence,
          sigOpCount: inp?.sigOpCount,
          utxo: inp?.utxo
            ? {
                outpoint: {
                  transactionId: String(inp.utxo?.outpoint?.transactionId || ""),
                  index: Number(inp.utxo?.outpoint?.index)
                },
                amount: inp.utxo?.amount,
                scriptPublicKey: inp.utxo?.scriptPublicKey,
                blockDaaScore: inp.utxo?.blockDaaScore,
                isCoinbase: inp.utxo?.isCoinbase
              }
            : undefined
        }))
      : [],
    outputs: Array.isArray(txToSignObj.outputs)
      ? txToSignObj.outputs.map((out: any) => ({
          value: out?.value,
          scriptPublicKey: out?.scriptPublicKey
        }))
      : []
  };
}

function buildFinalizePskb(basePskt0: any, txFinalObj: any): string {
  const baseGlobal: any = basePskt0 && typeof basePskt0 === "object" && basePskt0.global && typeof basePskt0.global === "object"
    ? basePskt0.global
    : null;
  const baseInputs: any[] = Array.isArray(basePskt0?.inputs) ? basePskt0.inputs : [];
  const baseInput0: any = baseInputs[0] ?? null;
  if (!baseGlobal || !baseInput0) {
    throw new Error("maker_send_pskb_shape_invalid");
  }

  const txInputs: any[] = Array.isArray(txFinalObj?.inputs) ? txFinalObj.inputs : [];
  const txOutputs: any[] = Array.isArray(txFinalObj?.outputs) ? txFinalObj.outputs : [];
  if (!txInputs.length) throw new Error("finalize_tx_missing_inputs");
  if (!txOutputs.length) throw new Error("finalize_tx_missing_outputs");

  const buildUtxoEntry = (utxoAny: any, inputIndex: number): any => {
    const src: any = utxoAny && typeof utxoAny === "object" ? utxoAny : null;
    if (!src) throw new Error(`finalize_input_${inputIndex}_utxo_missing`);

    const amount = readSompi(src.amount);
    if (amount === null || amount <= 0n) {
      throw new Error(`finalize_input_${inputIndex}_utxo_amount_invalid`);
    }

    const scriptPublicKey = normalizeSpkHex(src.scriptPublicKey);
    if (!scriptPublicKey) {
      throw new Error(`finalize_input_${inputIndex}_utxo_spk_invalid`);
    }

    const blockDaaScore = readSompi(src.blockDaaScore) ?? 0n;

    return {
      amount,
      scriptPublicKey,
      blockDaaScore,
      isCoinbase: !!src.isCoinbase
    };
  };

  const buildInput = (inpAny: any, inputIndex: number, baseInputAny: any): any => {
    const prevTxid = typeof inpAny?.previousOutpoint?.transactionId === "string"
      ? inpAny.previousOutpoint.transactionId.trim()
      : "";
    const prevIndex = typeof inpAny?.previousOutpoint?.index === "number"
      ? inpAny.previousOutpoint.index
      : Number(inpAny?.previousOutpoint?.index);

    if (!prevTxid || !Number.isInteger(prevIndex) || prevIndex < 0) {
      throw new Error(`finalize_input_${inputIndex}_outpoint_invalid`);
    }

    const utxoSource: any =
      inpAny?.utxo && typeof inpAny.utxo === "object"
        ? inpAny.utxo
        : baseInputAny?.utxoEntry && typeof baseInputAny.utxoEntry === "object"
          ? baseInputAny.utxoEntry
          : baseInputAny?.utxo && typeof baseInputAny.utxo === "object"
            ? baseInputAny.utxo
            : null;

    const sequence = readSompi(inpAny?.sequence);
    const sigOpCountRaw = inpAny?.sigOpCount ?? baseInputAny?.sigOpCount;
    const sigOpCount = typeof sigOpCountRaw === "number" && Number.isInteger(sigOpCountRaw) && sigOpCountRaw >= 0
      ? sigOpCountRaw
      : 1;

    const signatureScriptRaw = typeof inpAny?.signatureScript === "string"
      ? inpAny.signatureScript.trim()
      : baseInputAny && typeof baseInputAny.signatureScript === "string"
        ? baseInputAny.signatureScript.trim()
        : "";

    const redeemScriptRaw = baseInputAny && typeof baseInputAny.redeemScript === "string"
      ? baseInputAny.redeemScript.trim()
      : "";

    const out: any = {
      utxoEntry: buildUtxoEntry(utxoSource, inputIndex),
      previousOutpoint: {
        transactionId: prevTxid,
        index: prevIndex
      },
      sequence: sequence === null ? null : sequence,
      minTime: baseInputAny && Object.prototype.hasOwnProperty.call(baseInputAny, "minTime")
        ? (baseInputAny.minTime ?? null)
        : null,
      partialSigs: {},
      sighashType: inputIndex === 0 ? SighashType.SingleAnyOneCanPay : SighashType.None,
      redeemScript: inputIndex === 0
        ? (isEvenHexString(redeemScriptRaw) ? redeemScriptRaw : null)
        : null,
      sigOpCount,
      bip32Derivations: {},
      finalScriptSig: null,
      proprietaries: {}
    };

    if (isEvenHexString(signatureScriptRaw)) {
      out.signatureScript = signatureScriptRaw;
    }

    return out;
  };

  const payload0: any = {
    global: {
      version: typeof baseGlobal.version === "number" ? baseGlobal.version : 0,
      txVersion: typeof txFinalObj?.version === "number" && Number.isInteger(txFinalObj.version)
        ? txFinalObj.version
        : (typeof baseGlobal.txVersion === "number" ? baseGlobal.txVersion : 0),
      fallbackLockTime: Object.prototype.hasOwnProperty.call(baseGlobal, "fallbackLockTime")
        ? (baseGlobal.fallbackLockTime ?? null)
        : null,
      inputsModifiable: false,
      outputsModifiable: false,
      inputCount: txInputs.length,
      outputCount: txOutputs.length,
      xpubs: baseGlobal.xpubs && typeof baseGlobal.xpubs === "object" && !Array.isArray(baseGlobal.xpubs)
        ? baseGlobal.xpubs
        : {},
      id: Object.prototype.hasOwnProperty.call(baseGlobal, "id")
        ? (baseGlobal.id ?? null)
        : null,
      proprietaries: baseGlobal.proprietaries && typeof baseGlobal.proprietaries === "object" && !Array.isArray(baseGlobal.proprietaries)
        ? baseGlobal.proprietaries
        : {}
    },
    inputs: [
      buildInput(txInputs[0], 0, baseInput0),
      ...txInputs.slice(1).map((inp: any, idx: number) => buildInput(inp, idx + 1, null))
    ],
    outputs: txOutputs.map((outAny: any, outputIndex: number) => {
      const amount = readSompi(outAny?.value ?? outAny?.amount);
      if (amount === null || amount <= 0n) {
        throw new Error(`finalize_output_${outputIndex}_amount_invalid`);
      }

      const scriptPublicKey = normalizeSpkHex(outAny?.scriptPublicKey);
      if (!scriptPublicKey) {
        throw new Error(`finalize_output_${outputIndex}_spk_invalid`);
      }

      return {
        amount,
        scriptPublicKey,
        redeemScript: null,
        bip32Derivations: {},
        proprietaries: {}
      };
    })
  };

  return encodePskbPayloadArray([payload0]);
}

export function registerOpenSwapSendRoutes(app: Express, ctx: OpenSwapSendCtx): void {
  const {
    repoRoot,
    getSharedRpc,
    readWalletStore,
    bcwOpenSwapFinalizeSubmit,
    validateOpenSwapPskbV2
  } = ctx;

  app.post("/api/open-swaps/accept", async (req, res) => {
    try {
      const body: any = req.body && typeof req.body === "object" ? req.body : null;
      const offerBlob = typeof body?.offerBlob === "string" ? body.offerBlob : "";
      if (!offerBlob) {
        return res.status(400).json({ ok: false, reason: "offer_blob_required" });
      }

      const userId = typeof (res.locals as any).td_user_id === "string" ? String((res.locals as any).td_user_id) : "";
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      let offer: any;
      try {
        offer = parseOfferBlobText(offerBlob);
      } catch (e) {
        return res.status(400).json({
          ok: false,
          reason: "offer_blob_invalid",
          error: String(e instanceof Error ? e.message : e)
        });
      }

      const kind = offer.kind === "tick_to_kas" || offer.kind === "ca_to_kas" ? offer.kind : null;
      if (!kind) return res.status(400).json({ ok: false, reason: "offer_kind_invalid" });
      if (offer.version !== 1) return res.status(400).json({ ok: false, reason: "offer_version_invalid" });
      if (offer.mode !== "open_swap_v2") return res.status(400).json({ ok: false, reason: "offer_mode_invalid" });
      if (offer.discovery !== "manual_import") return res.status(400).json({ ok: false, reason: "offer_discovery_invalid" });
      if (offer.fillMode !== "full_fill_only") return res.status(400).json({ ok: false, reason: "offer_fill_mode_invalid" });
      if (!offer.protocol || typeof offer.protocol !== "object") return res.status(400).json({ ok: false, reason: "offer_protocol_missing" });
      if (offer.protocol.makerOp !== "list") return res.status(400).json({ ok: false, reason: "offer_protocol_maker_op_invalid" });
      if (offer.protocol.takerOp !== "send") return res.status(400).json({ ok: false, reason: "offer_protocol_taker_op_invalid" });
      if (!offer.maker || typeof offer.maker !== "object") return res.status(400).json({ ok: false, reason: "offer_maker_missing" });
      const makerWalletType = String(offer.maker.walletType || "").trim().toLowerCase();
      const makerCustodyModel = String(offer.maker.custodyModel || "").trim().toLowerCase();
      const makerIsStandard = makerWalletType === "standard";
      const makerIsBcw = makerWalletType === "compliance" && makerCustodyModel === "broker_1of1";
      if (!makerIsStandard && !makerIsBcw) return res.status(400).json({ ok: false, reason: "offer_maker_wallet_type_invalid" });
      if (!offer.maker.walletId) return res.status(400).json({ ok: false, reason: "offer_maker_wallet_id_missing" });
      if (!offer.maker.networkId) return res.status(400).json({ ok: false, reason: "offer_maker_network_id_missing" });
      if (!offer.maker.kasReceiveAddress) return res.status(400).json({ ok: false, reason: "offer_maker_kas_receive_address_missing" });
      if (makerIsStandard && !offer.maker.userPubkey) return res.status(400).json({ ok: false, reason: "offer_maker_user_pubkey_missing" });
      if (makerIsBcw && !offer.maker.brokerCustodyKeyRef) return res.status(400).json({ ok: false, reason: "offer_maker_broker_custody_key_ref_missing" });
      if (makerIsBcw && !offer.maker.userAuthPubkey) return res.status(400).json({ ok: false, reason: "offer_maker_user_auth_pubkey_missing" });
      if (!offer.sell || typeof offer.sell !== "object") return res.status(400).json({ ok: false, reason: "offer_sell_missing" });
      if (!offer.buy || typeof offer.buy !== "object") return res.status(400).json({ ok: false, reason: "offer_buy_missing" });
      if (offer.sell.type !== "KRC20") return res.status(400).json({ ok: false, reason: "offer_sell_type_invalid" });
      if (offer.buy.type !== "KAS") return res.status(400).json({ ok: false, reason: "offer_buy_type_invalid" });
      if (!offer.sell.amount) return res.status(400).json({ ok: false, reason: "offer_sell_amount_missing" });
      if (!offer.buy.amount) return res.status(400).json({ ok: false, reason: "offer_buy_amount_missing" });
      if (!offer.makerListPskb) return res.status(400).json({ ok: false, reason: "offer_maker_list_pskb_missing" });
      if (!offer.makerSendPskb) return res.status(400).json({ ok: false, reason: "offer_maker_send_pskb_missing" });
      if (!offer.listRevealTxid) return res.status(400).json({ ok: false, reason: "offer_list_reveal_txid_missing" });
      if (!offer.p2shSendOutpoint || typeof offer.p2shSendOutpoint !== "object") return res.status(400).json({ ok: false, reason: "offer_p2sh_send_outpoint_missing" });
      if (!offer.sendRedeemScriptHex) return res.status(400).json({ ok: false, reason: "offer_send_redeem_script_hex_missing" });
      if (!offer.termsCommitment) return res.status(400).json({ ok: false, reason: "offer_terms_commitment_missing" });

      const expiryRejectReason = openSwapOfferExpiryRejectReason(offer);
      if (expiryRejectReason) {
        return res.status(400).json({ ok: false, reason: expiryRejectReason });
      }

      const store = readWalletStore(repoRoot, userId);
      const active = store.active_id ? store.items.find((w) => w.id === store.active_id) ?? null : null;
      if (!active) return res.status(400).json({ ok: false, reason: "active_wallet_missing" });
      if (active.state !== "READY") return res.status(400).json({ ok: false, reason: "active_wallet_not_ready" });

      const takerNetworkId: WalletNetworkType = active.network;
      const offerAppNetworkKey = normalizeAppNetworkKey(offer.maker.networkId);
      const takerAppNetworkKey = appNetworkKeyFromWalletNetwork(takerNetworkId);
      const takerAddress = typeof active.address0 === "string" ? active.address0.trim() : "";
      if (!takerAddress || takerAddress === "PENDING") {
        return res.status(400).json({ ok: false, reason: "active_wallet_address_missing" });
      }
      if (!offerAppNetworkKey) {
        return res.status(400).json({
          ok: false,
          reason: "offer_network_id_invalid",
          offerNetworkId: String(offer.maker.networkId),
          takerNetworkId,
          takerAppNetworkKey
        });
      }
      if (offerAppNetworkKey !== takerAppNetworkKey) {
        return res.status(400).json({
          ok: false,
          reason: "offer_network_mismatch",
          offerNetworkId: String(offer.maker.networkId),
          takerNetworkId,
          offerAppNetworkKey,
          takerAppNetworkKey
        });
      }

      const expectedSendJsonHex = buildCanonicalOpenSwapSendJsonHex(kind, offer.sell);
      if (!expectedSendJsonHex) {
        return res.status(400).json({ ok: false, reason: "offer_send_payload_invalid" });
      }

      const validation = await validateOpenSwapPskbV2(repoRoot, {
        phase: "accept",
        kind,
        pskb: String(offer.makerSendPskb),
        expectedSendJsonHex
      });
      if (!validation.ok) {
        return res.status(400).json({
          ok: false,
          reason: "maker_send_pskb_invalid",
          errors: validation.errors,
          warnings: validation.warnings
        });
      }

      const sellSymbol = kind === "tick_to_kas"
        ? String(offer.sell.ticker || offer.sell.symbol || "")
        : String(offer.sell.ca || "");

      return res.json({
        ok: true,
        stage: "accept_prepare",
        notes: [
          "maker_list_taker_send",
          "open_v2_phase1_manual_import_only",
          "cb4b1_accept_surface_send_ready"
        ],
        offerSummary: {
          kind,
          sellAmount: String(offer.sell.amount),
          sellSymbol,
          buyAmountKas: String(offer.buy.amount),
          expiresAt: String(offer.expiresAt)
        },
        taker: {
          walletId: active.id,
          walletType: active.wallet_type,
          networkId: takerNetworkId,
          kasSendAddress: takerAddress
        },
        sendContext: {
          mode: "open_swap_v2",
          phase: "accept_prepare",
          networkId: takerNetworkId,
          fromAddress: takerAddress,
          toAddress: String(offer.maker.kasReceiveAddress),
          asset: "KAS",
          amount: String(offer.buy.amount),
          receiveType: "KRC20",
          receiveAmount: String(offer.sell.amount),
          receiveSymbol: sellSymbol,
          makerSendPskb: String(offer.makerSendPskb),
          listRevealTxid: String(offer.listRevealTxid),
          p2shSendOutpoint: {
            txid: String(offer.p2shSendOutpoint.txid || ""),
            index: Number(offer.p2shSendOutpoint.index)
          },
          sendRedeemScriptHex: String(offer.sendRedeemScriptHex),
          termsCommitment: String(offer.termsCommitment),
          validationWarnings: validation.warnings.slice()
        }
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        reason: "open_swap_accept_prepare_failed",
        error: String(e instanceof Error ? e.message : e)
      });
    }
  });

  app.post("/api/open-swaps/finalize", async (req, res) => {
    try {
      const body: any = req.body && typeof req.body === "object" ? req.body : null;
      const reqStage = typeof body?.stage === "string" ? String(body.stage).trim() : "";
      const isPrepare = reqStage === "prepare";
      const isSubmit = reqStage === "submit";
      if (!isPrepare && !isSubmit) {
        return res.status(400).json({ ok: false, reason: "invalid_stage", allowedStages: ["prepare", "submit"] });
      }

      const userId = typeof (res.locals as any).td_user_id === "string" ? String((res.locals as any).td_user_id) : "";
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      if (isPrepare) {
        let stage = "finalize_prepare";
        const offerBlob = typeof body?.offerBlob === "string" ? body.offerBlob : "";
        if (!offerBlob) {
          return res.status(400).json({ ok: false, reason: "offer_blob_required", stage });
        }

        let offer: any;
        try {
          offer = parseOfferBlobText(offerBlob);
        } catch (e) {
          return res.status(400).json({
            ok: false,
            reason: "offer_blob_invalid",
            stage,
            error: String(e instanceof Error ? e.message : e)
          });
        }

        const kind = offer.kind === "tick_to_kas" || offer.kind === "ca_to_kas" ? offer.kind : null;
        if (!kind) return res.status(400).json({ ok: false, reason: "offer_kind_invalid", stage });
        if (offer.version !== 1) return res.status(400).json({ ok: false, reason: "offer_version_invalid", stage });
        if (offer.mode !== "open_swap_v2") return res.status(400).json({ ok: false, reason: "offer_mode_invalid", stage });
        if (offer.discovery !== "manual_import") return res.status(400).json({ ok: false, reason: "offer_discovery_invalid", stage });
        if (offer.fillMode !== "full_fill_only") return res.status(400).json({ ok: false, reason: "offer_fill_mode_invalid", stage });
        if (!offer.protocol || typeof offer.protocol !== "object") return res.status(400).json({ ok: false, reason: "offer_protocol_missing", stage });
        if (offer.protocol.makerOp !== "list") return res.status(400).json({ ok: false, reason: "offer_protocol_maker_op_invalid", stage });
        if (offer.protocol.takerOp !== "send") return res.status(400).json({ ok: false, reason: "offer_protocol_taker_op_invalid", stage });
        if (!offer.maker || typeof offer.maker !== "object") return res.status(400).json({ ok: false, reason: "offer_maker_missing", stage });
        const makerWalletType = String(offer.maker.walletType || "").trim().toLowerCase();
        const makerCustodyModel = String(offer.maker.custodyModel || "").trim().toLowerCase();
        const makerIsStandard = makerWalletType === "standard";
        const makerIsBcw = makerWalletType === "compliance" && makerCustodyModel === "broker_1of1";
        if (!makerIsStandard && !makerIsBcw) return res.status(400).json({ ok: false, reason: "offer_maker_wallet_type_invalid", stage });
        if (!offer.maker.walletId) return res.status(400).json({ ok: false, reason: "offer_maker_wallet_id_missing", stage });
        if (!offer.maker.networkId) return res.status(400).json({ ok: false, reason: "offer_maker_network_id_missing", stage });
        if (!offer.maker.kasReceiveAddress) return res.status(400).json({ ok: false, reason: "offer_maker_kas_receive_address_missing", stage });
        if (makerIsStandard && !offer.maker.userPubkey) return res.status(400).json({ ok: false, reason: "offer_maker_user_pubkey_missing", stage });
        if (makerIsBcw && !offer.maker.brokerCustodyKeyRef) return res.status(400).json({ ok: false, reason: "offer_maker_broker_custody_key_ref_missing", stage });
        if (makerIsBcw && !offer.maker.userAuthPubkey) return res.status(400).json({ ok: false, reason: "offer_maker_user_auth_pubkey_missing", stage });
        if (!offer.sell || typeof offer.sell !== "object") return res.status(400).json({ ok: false, reason: "offer_sell_missing", stage });
        if (!offer.buy || typeof offer.buy !== "object") return res.status(400).json({ ok: false, reason: "offer_buy_missing", stage });
        if (offer.sell.type !== "KRC20") return res.status(400).json({ ok: false, reason: "offer_sell_type_invalid", stage });
        if (offer.buy.type !== "KAS") return res.status(400).json({ ok: false, reason: "offer_buy_type_invalid", stage });
        if (!offer.sell.amount) return res.status(400).json({ ok: false, reason: "offer_sell_amount_missing", stage });
        if (!offer.buy.amount) return res.status(400).json({ ok: false, reason: "offer_buy_amount_missing", stage });
        if (!offer.makerSendPskb) return res.status(400).json({ ok: false, reason: "offer_maker_send_pskb_missing", stage });
        if (!offer.listRevealTxid) return res.status(400).json({ ok: false, reason: "offer_list_reveal_txid_missing", stage });
        if (!offer.p2shSendOutpoint || typeof offer.p2shSendOutpoint !== "object") return res.status(400).json({ ok: false, reason: "offer_p2sh_send_outpoint_missing", stage });
        if (!offer.p2shSendSompi) return res.status(400).json({ ok: false, reason: "offer_p2sh_send_sompi_missing", stage });
        if (!offer.sendP2shAddress) return res.status(400).json({ ok: false, reason: "offer_send_p2sh_address_missing", stage });
        if (!offer.sendRedeemScriptHex) return res.status(400).json({ ok: false, reason: "offer_send_redeem_script_hex_missing", stage });
        if (!offer.termsCommitment) return res.status(400).json({ ok: false, reason: "offer_terms_commitment_missing", stage });

        const expiryRejectReason = openSwapOfferExpiryRejectReason(offer);
        if (expiryRejectReason) {
          return res.status(400).json({ ok: false, reason: expiryRejectReason, stage });
        }

        const store = readWalletStore(repoRoot, userId);
        const active = store.active_id ? store.items.find((w) => w.id === store.active_id) ?? null : null;
        if (!active) return res.status(400).json({ ok: false, reason: "active_wallet_missing", stage });
        if (active.state !== "READY") return res.status(400).json({ ok: false, reason: "active_wallet_not_ready", stage });
        if (active.wallet_type !== "standard" && active.wallet_type !== "compliance") {
          return res.status(400).json({ ok: false, reason: "active_wallet_type_invalid", stage });
        }
        if (!!offer.complianceOnly && active.wallet_type !== "compliance") {
          return res.status(409).json({ ok: false, reason: "compliance_wallet_required", stage });
        }

        const isComplianceWallet = active.wallet_type === "compliance";
        const takerNetworkId: WalletNetworkType = active.network;
        const offerAppNetworkKey = normalizeAppNetworkKey(offer.maker.networkId);
        const takerAppNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
        const rpcNetworkId = rpcNetworkIdFromAppNetworkKey(takerAppNetworkKey);
        const takerKasSendAddress = typeof active.address0 === "string" ? active.address0.trim() : "";
        const takerTokenReceiveAddress = takerKasSendAddress;
        const custodyModel = typeof active.custody_model === "string" ? active.custody_model.trim() : "";
        const brokerCustodyKeyRef = typeof active.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const userAuthPubkey = typeof active.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";

        if (isComplianceWallet) {
          if (custodyModel !== "broker_1of1") {
            return res.status(409).json({ ok: false, reason: "bcw_custody_model_required", stage });
          }
          if (!brokerCustodyKeyRef) {
            return res.status(409).json({ ok: false, reason: "bcw_broker_custody_key_ref_missing", stage });
          }
          if (!userAuthPubkey) {
            return res.status(409).json({ ok: false, reason: "bcw_user_auth_pubkey_missing", stage });
          }
        }

        if (
          !takerKasSendAddress ||
          takerKasSendAddress === "PENDING" ||
          !takerTokenReceiveAddress ||
          takerTokenReceiveAddress === "PENDING"
        ) {
          return res.status(400).json({ ok: false, reason: "active_wallet_address_missing", stage });
        }
        if (!offerAppNetworkKey) {
          return res.status(400).json({
            ok: false,
            reason: "offer_network_id_invalid",
            stage,
            offerNetworkId: String(offer.maker.networkId),
            takerNetworkId,
            takerAppNetworkKey
          });
        }
        if (offerAppNetworkKey !== takerAppNetworkKey) {
          return res.status(400).json({
            ok: false,
            reason: "offer_network_mismatch",
            stage,
            offerNetworkId: String(offer.maker.networkId),
            takerNetworkId,
            offerAppNetworkKey,
            takerAppNetworkKey
          });
        }

        const offerId = buildOpenSwapOfferId(
          String(offer.listRevealTxid || ""),
          String(offer.termsCommitment || "")
        );

        const expectedSendJsonHex = buildCanonicalOpenSwapSendJsonHex(kind, offer.sell);
        if (!expectedSendJsonHex) {
          return res.status(400).json({ ok: false, reason: "offer_send_payload_invalid", stage });
        }

        const validation = await validateOpenSwapPskbV2(repoRoot, {
          phase: "accept",
          kind,
          pskb: String(offer.makerSendPskb),
          expectedSendJsonHex
        });
        if (!validation.ok) {
          return res.status(400).json({
            ok: false,
            reason: "maker_send_pskb_invalid",
            stage,
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        const rpc = await getSharedRpc(rpcNetworkId);

        let makerArr: any[];
        try {
          makerArr = decodePskbPayloadArray(String(offer.makerSendPskb));
        } catch (e) {
          return res.status(400).json({
            ok: false,
            reason: "maker_send_pskb_decode_failed",
            stage,
            error: String(e instanceof Error ? e.message : e)
          });
        }
        if (makerArr.length !== 1) {
          return res.status(400).json({ ok: false, reason: "maker_send_pskb_array_len_invalid", stage });
        }

        const makerPskt0: any = makerArr[0] ?? null;
        const makerInputs: any[] = Array.isArray(makerPskt0?.inputs) ? makerPskt0.inputs : [];
        const makerOutputs: any[] = Array.isArray(makerPskt0?.outputs) ? makerPskt0.outputs : [];
        const makerInput0: any = makerInputs[0] ?? null;
        const makerOutput0: any = makerOutputs[0] ?? null;
        if (!makerInput0 || !makerOutput0) {
          return res.status(400).json({ ok: false, reason: "maker_send_pskb_shape_invalid", stage });
        }

        const sigScript0 = typeof makerInput0.signatureScript === "string" ? makerInput0.signatureScript.trim() : "";
        if (!isEvenHexString(sigScript0)) {
          return res.status(400).json({ ok: false, reason: "maker_send_input0_signatureScript_invalid", stage });
        }

        const makerPrevTxid = typeof makerInput0?.previousOutpoint?.transactionId === "string" ? makerInput0.previousOutpoint.transactionId.trim() : "";
        const makerPrevIndex = typeof makerInput0?.previousOutpoint?.index === "number" ? makerInput0.previousOutpoint.index : -1;
        const offerTxid = typeof offer?.p2shSendOutpoint?.txid === "string" ? offer.p2shSendOutpoint.txid.trim() : "";
        const offerVout = typeof offer?.p2shSendOutpoint?.index === "number" ? offer.p2shSendOutpoint.index : -1;
        if (!makerPrevTxid || makerPrevIndex < 0 || makerPrevTxid !== offerTxid || makerPrevIndex !== offerVout) {
          return res.status(400).json({ ok: false, reason: "maker_send_outpoint_mismatch", stage });
        }

        const p2shSompi = readSompi(offer.p2shSendSompi);
        if (p2shSompi === null || p2shSompi <= 0n) {
          return res.status(400).json({ ok: false, reason: "offer_p2sh_send_sompi_invalid", stage });
        }

        const offerU = await rpc.getUtxosByAddresses({ addresses: [String(offer.sendP2shAddress)] });
        const offerEntries: any[] = offerU && Array.isArray((offerU as any).entries) ? (offerU as any).entries : [];
        const offerMatch: any = offerEntries.find((e: any) =>
          e && e.outpoint && e.outpoint.transactionId === offerTxid && e.outpoint.index === offerVout
        );
        if (!offerMatch) {
          return res.status(409).json({ ok: false, reason: "offer_send_outpoint_consumed", stage });
        }

        const makerUtxoEntry: any = makerInput0.utxoEntry && typeof makerInput0.utxoEntry === "object"
          ? makerInput0.utxoEntry
          : makerInput0.utxo && typeof makerInput0.utxo === "object"
            ? makerInput0.utxo
            : null;

        const in0SpkHex = normalizeSpkHex((offerMatch as any)?.scriptPublicKey) || normalizeSpkHex((makerUtxoEntry as any)?.scriptPublicKey);
        if (!in0SpkHex) {
          return res.status(500).json({ ok: false, reason: "offer_send_input0_spk_missing", stage });
        }

        const out0Value = readSompi((makerOutput0 as any).amount ?? (makerOutput0 as any).value);
        if (out0Value === null || out0Value <= 0n) {
          return res.status(500).json({ ok: false, reason: "maker_output0_amount_invalid", stage });
        }

        const out0SpkHex = normalizeSpkHex((makerOutput0 as any).scriptPublicKey);
        if (!out0SpkHex) {
          return res.status(500).json({ ok: false, reason: "maker_output0_spk_invalid", stage });
        }

        const takerU = await rpc.getUtxosByAddresses({ addresses: [takerKasSendAddress] });
        const takerRawEntries: any[] = takerU && Array.isArray((takerU as any).entries) ? (takerU as any).entries : [];
        if (!takerRawEntries.length) {
          return res.status(409).json({ ok: false, reason: "no_utxos", stage });
        }

        const takerCovenantExclusion = applyOpenSwapSendCovenantExclusion({
          networkId: rpcNetworkId,
          address: takerKasSendAddress,
          entries: takerRawEntries,
          inspectionKind: "open_swap_send_finalize_taker_covenant_exclusion_v1"
        });
        let takerEntries: any[] = takerCovenantExclusion.entries;
        if (!takerEntries.length) {
          return res.status(409).json({
            ok: false,
            reason: "open_swap_send_finalize_taker_only_covenant_utxos",
            stage,
            covenant_exclusion: takerCovenantExclusion.exclusion
          });
        }

        takerEntries = takerEntries
          .filter((e: any) => e && e.outpoint && typeof e.outpoint.transactionId === "string" && typeof e.outpoint.index === "number");

        const tokenReceiverValue = 33000000n;
        const makerRefundValue = p2shSompi;
        const takerMinChangeValue = 33000000n;
        const tokenReceiverSpkHex = normalizeSpkHex(payToAddressScript(takerTokenReceiveAddress));
        const changeSpkHex = normalizeSpkHex(payToAddressScript(takerKasSendAddress));
        if (!tokenReceiverSpkHex || !changeSpkHex) {
          return res.status(500).json({ ok: false, reason: "taker_receive_spk_failed", stage });
        }

        const utxo0ForSign: any = {
          outpoint: { transactionId: offerTxid, index: offerVout },
          amount: p2shSompi,
          scriptPublicKey: in0SpkHex,
          blockDaaScore: (offerMatch as any)?.blockDaaScore ?? (makerUtxoEntry as any)?.blockDaaScore ?? 0,
          isCoinbase: (offerMatch as any)?.isCoinbase ?? (makerUtxoEntry as any)?.isCoinbase ?? false
        };

        const requiredMinSompi = out0Value + tokenReceiverValue + takerMinChangeValue;
        const takerAvailableSompi = takerEntries.reduce((acc: bigint, e: any) => acc + (readSompi(e?.amount) ?? 0n), 0n);
        const maxMass = maximumStandardTransactionMass();
        const amountOfTakerEntry = (e: any): bigint => readSompi(e?.amount) ?? 0n;
        const largestTakerEntrySompi = takerEntries.reduce((largest: bigint, e: any) => {
          const amt = amountOfTakerEntry(e);
          return amt > largest ? amt : largest;
        }, 0n);
        const takerEntriesAscending = takerEntries.slice().sort((a: any, b: any) => {
          const aa = amountOfTakerEntry(a);
          const bb = amountOfTakerEntry(b);
          return aa < bb ? -1 : aa > bb ? 1 : 0;
        });
        const takerEntriesDescendingBelowRequired = takerEntriesAscending
          .filter((e: any) => amountOfTakerEntry(e) < requiredMinSompi)
          .slice()
          .reverse();
        const candidateSets: any[][] = [];
        const pushCandidateSet = (items: any[]) => {
          if (items.length) candidateSets.push(items.slice());
        };

        for (const entry of takerEntriesAscending) {
          if (amountOfTakerEntry(entry) >= requiredMinSompi) {
            pushCandidateSet([entry]);
          }
        }

        let descendingTotal = 0n;
        const descendingAccum: any[] = [];
        for (const entry of takerEntriesDescendingBelowRequired) {
          descendingAccum.push(entry);
          descendingTotal += amountOfTakerEntry(entry);
          if (descendingTotal >= requiredMinSompi) {
            pushCandidateSet(descendingAccum);
          }
        }

        let ascendingTotal = 0n;
        const ascendingAccum: any[] = [];
        for (const entry of takerEntriesAscending.filter((e: any) => amountOfTakerEntry(e) < requiredMinSompi)) {
          ascendingAccum.push(entry);
          ascendingTotal += amountOfTakerEntry(entry);
          if (ascendingTotal >= requiredMinSompi) {
            pushCandidateSet(ascendingAccum);
          }
        }

        let boostedTotal = 0n;
        const boostedAccum: any[] = [];
        for (const entry of takerEntriesAscending) {
          boostedAccum.push(entry);
          boostedTotal += amountOfTakerEntry(entry);
          if (boostedTotal >= requiredMinSompi) {
            pushCandidateSet(boostedAccum);
          }
        }

        if (!candidateSets.length && takerEntriesAscending.length) {
          pushCandidateSet(takerEntriesAscending);
        }

        const candidateSetTotal = (items: any[]): bigint => items.reduce((acc: bigint, e: any) => acc + amountOfTakerEntry(e), 0n);
        candidateSets.sort((a: any[], b: any[]) => {
          const aa = candidateSetTotal(a);
          const bb = candidateSetTotal(b);
          if (aa !== bb) return aa < bb ? -1 : 1;
          return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
        });

        let txToSignObj: any = null;
        let lastSelectionFailure = "no_candidate_attempted";
        let lastSelectedCount = 0;
        let lastSelectedTotalSompi = 0n;
        let lastChangeInitSompi: bigint | null = null;
        let lastMassVal: bigint | null = null;
        let lastFeeSompi: bigint | null = null;
        let lastChangeFinalSompi: bigint | null = null;

        for (const selected of candidateSets) {
          const selectedTotal = candidateSetTotal(selected);

          lastSelectedCount = selected.length;
          lastSelectedTotalSompi = selectedTotal;

          if (selectedTotal < requiredMinSompi) {
            lastSelectionFailure = "selected_total_below_required_min";
            continue;
          }

          const inputsUnsigned: any[] = [];
          const inputsForMass: any[] = [];

          const makerInputForTx = {
            previousOutpoint: { transactionId: offerTxid, index: offerVout },
            signatureScript: sigScript0,
            sequence: makerInput0?.sequence ?? 0n,
            sigOpCount: makerInput0?.sigOpCount ?? 1,
            utxo: utxo0ForSign
          };
          inputsUnsigned.push(makerInputForTx);
          inputsForMass.push(makerInputForTx);

          for (let j = 0; j < selected.length; j++) {
            const uj: any = selected[j];
            const takerInputBase = {
              previousOutpoint: { transactionId: String(uj.outpoint.transactionId), index: Number(uj.outpoint.index) },
              sequence: 0n,
              sigOpCount: 1,
              utxo: uj
            };
            inputsUnsigned.push({ ...takerInputBase, signatureScript: "" });
          }

          const totalInSompi = makerRefundValue + selectedTotal;
          const fixedOutputsSompi = out0Value + tokenReceiverValue + makerRefundValue;
          const changeInit = totalInSompi - fixedOutputsSompi;
          lastChangeInitSompi = changeInit;
          if (changeInit < takerMinChangeValue) {
            lastSelectionFailure = "change_init_below_min";
            continue;
          }

          let changeCandidate = changeInit;
          let convergedTxToSignObj: any = null;
          let convergenceFailure: string | null = null;

          for (let pass = 0; pass < OPEN_SWAP_FINALIZE_FEE_CONVERGENCE_MAX_PASSES; pass++) {
            if (changeCandidate < takerMinChangeValue) {
              convergenceFailure = "change_final_below_min";
              break;
            }

            const candidateTxToSignObj: any = {
              version: 0,
              lockTime: 0n,
              gas: 0n,
              payload: "",
              subnetworkId: "0000000000000000000000000000000000000000",
              inputs: inputsUnsigned,
              outputs: [
                { value: out0Value, scriptPublicKey: out0SpkHex },
                { value: tokenReceiverValue, scriptPublicKey: tokenReceiverSpkHex },
                { value: makerRefundValue, scriptPublicKey: out0SpkHex },
                { value: changeCandidate, scriptPublicKey: changeSpkHex }
              ]
            };

            const massVal = openSwapFinalizePresignMass(rpcNetworkId, candidateTxToSignObj, selected.length);
            lastMassVal = massVal;
            if (massVal === null) {
              convergenceFailure = "mass_calc_failed";
              break;
            }
            if (massVal > maxMass) {
              convergenceFailure = "mass_exceeded";
              break;
            }

            const feeVal = openSwapFinalizeToccataRequiredFee(rpcNetworkId, massVal);
            lastFeeSompi = feeVal;

            const nextChange = totalInSompi - (fixedOutputsSompi + feeVal);
            lastChangeFinalSompi = nextChange;
            if (nextChange < takerMinChangeValue) {
              convergenceFailure = "change_final_below_min";
              break;
            }

            if (nextChange === changeCandidate) {
              convergedTxToSignObj = candidateTxToSignObj;
              break;
            }

            changeCandidate = nextChange;
          }

          if (!convergedTxToSignObj) {
            lastSelectionFailure = convergenceFailure || "fee_convergence_failed";
            continue;
          }

          txToSignObj = convergedTxToSignObj;
          break;
        }

        if (!txToSignObj) {
          const candidateAttempts = candidateSets.slice(0, 40).map((selected: any[], idx: number) => {
            const selectedTotal = candidateSetTotal(selected);
            const base = {
              candidateIndex: idx,
              selectedCount: selected.length,
              selectedTotalSompi: selectedTotal.toString(),
              selectedEntryAmountsSompi: selected.map((entry: any) => amountOfTakerEntry(entry).toString())
            };

            if (selectedTotal < requiredMinSompi) {
              return { ...base, failureReason: "selected_total_below_required_min" };
            }

            const totalInSompi = makerRefundValue + selectedTotal;
            const changeInit = totalInSompi - (out0Value + tokenReceiverValue + makerRefundValue);
            if (changeInit < takerMinChangeValue) {
              return {
                ...base,
                changeInitSompi: changeInit.toString(),
                failureReason: "change_init_below_min"
              };
            }

            const makerInputForTx = {
              previousOutpoint: { transactionId: offerTxid, index: offerVout },
              signatureScript: sigScript0,
              sequence: makerInput0?.sequence ?? 0n,
              sigOpCount: makerInput0?.sigOpCount ?? 1,
              utxo: utxo0ForSign
            };
            const inputsUnsigned: any[] = [makerInputForTx];
            for (const uj of selected) {
              const takerInputBase = {
                previousOutpoint: { transactionId: String(uj.outpoint.transactionId), index: Number(uj.outpoint.index) },
                sequence: 0n,
                sigOpCount: 1,
                utxo: uj
              };
              inputsUnsigned.push({ ...takerInputBase, signatureScript: "" });
            }

            const fixedOutputsSompi = out0Value + tokenReceiverValue + makerRefundValue;
            let changeCandidate = changeInit;
            let massVal: bigint | null = null;
            let feeVal: bigint | null = null;
            let changeFinal: bigint | null = null;
            let failureReason: string | null = null;
            let converged = false;

            for (let pass = 0; pass < OPEN_SWAP_FINALIZE_FEE_CONVERGENCE_MAX_PASSES; pass++) {
              if (changeCandidate < takerMinChangeValue) {
                failureReason = "change_final_below_min";
                break;
              }

              const candidateTxToSignObj: any = {
                version: 0,
                lockTime: 0n,
                gas: 0n,
                payload: "",
                subnetworkId: "0000000000000000000000000000000000000000",
                inputs: inputsUnsigned,
                outputs: [
                  { value: out0Value, scriptPublicKey: out0SpkHex },
                  { value: tokenReceiverValue, scriptPublicKey: tokenReceiverSpkHex },
                  { value: makerRefundValue, scriptPublicKey: out0SpkHex },
                  { value: changeCandidate, scriptPublicKey: changeSpkHex }
                ]
              };

              massVal = openSwapFinalizePresignMass(rpcNetworkId, candidateTxToSignObj, selected.length);
              if (massVal === null) {
                failureReason = "mass_calc_failed";
                break;
              }
              if (massVal > maxMass) {
                failureReason = "mass_exceeded";
                break;
              }

              feeVal = openSwapFinalizeToccataRequiredFee(rpcNetworkId, massVal);
              const nextChange = totalInSompi - (fixedOutputsSompi + feeVal);
              changeFinal = nextChange;
              if (nextChange < takerMinChangeValue) {
                failureReason = "change_final_below_min";
                break;
              }
              if (nextChange === changeCandidate) {
                converged = true;
                break;
              }
              changeCandidate = nextChange;
            }

            if (!converged || massVal === null || feeVal === null || changeFinal === null) {
              return {
                ...base,
                changeInitSompi: changeInit.toString(),
                mass: massVal === null ? null : massVal.toString(),
                feeSompi: feeVal === null ? null : feeVal.toString(),
                changeFinalSompi: changeFinal === null ? null : changeFinal.toString(),
                failureReason: failureReason || "fee_convergence_failed"
              };
            }

            return {
              ...base,
              changeInitSompi: changeInit.toString(),
              mass: massVal.toString(),
              feeSompi: feeVal.toString(),
              changeFinalSompi: changeFinal.toString(),
              failureReason: "candidate_would_pass"
            };
          });

          return res.status(409).json({
            ok: false,
            reason: "insufficient_funds_for_offer",
            stage,
            requiredMinSompi: requiredMinSompi.toString(),
            availableSompi: takerAvailableSompi.toString(),
            p2shInSompi: p2shSompi.toString(),
            takerAvailableSompi: takerAvailableSompi.toString(),
            selectionFailure: lastSelectionFailure,
            largestTakerEntrySompi: largestTakerEntrySompi.toString(),
            lastSelectedCount,
            lastSelectedTotalSompi: lastSelectedTotalSompi.toString(),
            lastChangeInitSompi: lastChangeInitSompi === null ? null : lastChangeInitSompi.toString(),
            lastMass: lastMassVal === null ? null : lastMassVal.toString(),
            maxMass: String(maxMass),
            lastFeeSompi: lastFeeSompi === null ? null : lastFeeSompi.toString(),
            lastChangeFinalSompi: lastChangeFinalSompi === null ? null : lastChangeFinalSompi.toString(),
            covenant_exclusion: takerCovenantExclusion.exclusion,
            diagnostics: {
              offerId,
              makerWalletType,
              makerCustodyModel,
              takerWalletType: active.wallet_type,
              takerCustodyModel: custodyModel || null,
              buyAmount: String(offer.buy.amount),
              sellAmount: String(offer.sell.amount),
              tokenReceiverValueSompi: tokenReceiverValue.toString(),
              makerRefundValueSompi: makerRefundValue.toString(),
              takerMinChangeValueSompi: takerMinChangeValue.toString(),
              candidateSetCount: candidateSets.length,
              candidateAttemptsTruncated: candidateSets.length > candidateAttempts.length,
              candidateAttempts
            }
          });
        }

        const signInputIndexes = Array.from({ length: txToSignObj.inputs.length - 1 }, (_v, idx) => idx + 1);
        const txToSignSafeJson = new Transaction(txToSignObj).serializeToSafeJSON();
        const output0MakerKasReceiverSpkHex = normalizeSpkHex(txToSignObj?.outputs?.[0]?.scriptPublicKey);
        const output1TakerTokenReceiverSpkHex = normalizeSpkHex(txToSignObj?.outputs?.[1]?.scriptPublicKey);
        const output2MakerRefundSpkHex = normalizeSpkHex(txToSignObj?.outputs?.[2]?.scriptPublicKey);
        const output3TakerKasChangeSpkHex = normalizeSpkHex(txToSignObj?.outputs?.[3]?.scriptPublicKey);

        if (!output0MakerKasReceiverSpkHex || !output1TakerTokenReceiverSpkHex || !output2MakerRefundSpkHex || !output3TakerKasChangeSpkHex) {
          return res.status(500).json({ ok: false, reason: "open_swap_bcw_role_spk_missing", stage });
        }

        let bcwOpenSwapFinalizeIntent: BcwOpenSwapFinalizeIntentV1 | null = null;
        let bcwOpenSwapFinalizeIntentMessage: string | null = null;

        if (isComplianceWallet) {
          const bcwNetwork = walletNetworkToBcwOpenSwapNetwork(takerNetworkId);
          if (!bcwNetwork) {
            return res.status(400).json({ ok: false, reason: "bcw_open_swap_network_unsupported", stage });
          }

          const createdAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + OPEN_SWAP_FINALIZE_CACHE_TTL_MS).toISOString();

          bcwOpenSwapFinalizeIntent = {
            v: 1,
            purpose: "bcw_open_swap_finalize",
            wallet_id: String(active.id || ""),
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: bcwNetwork,
            broker_custody_key_ref: brokerCustodyKeyRef,
            from_address: takerKasSendAddress,
            offer_id: offerId,
            kind,
            tx_safe_json_sha256: sha256Utf8Hex(txToSignSafeJson),
            sign_input_indexes: signInputIndexes.slice(),
            output0_maker_kas_receiver_spk_hex: output0MakerKasReceiverSpkHex,
            output1_taker_token_receiver_spk_hex: output1TakerTokenReceiverSpkHex,
            output2_maker_refund_spk_hex: output2MakerRefundSpkHex,
            output3_taker_kas_change_spk_hex: output3TakerKasChangeSpkHex,
            expected_send_json_hex: expectedSendJsonHex,
            user_auth_pubkey: userAuthPubkey,
            created_at: createdAt,
            expires_at: expiresAt,
            nonce: newBcwOpenSwapFinalizeNonce()
          };
          bcwOpenSwapFinalizeIntentMessage = canonicalBcwOpenSwapFinalizeIntentMessage(bcwOpenSwapFinalizeIntent);
        }

        const finalizeRid = newOpenSwapFinalizeRid();
        openSwapFinalizeCache.set(finalizeRid, {
          createdAtMs: Date.now(),
          userId,
          networkId: takerNetworkId,
          kind,
          offerId,
          txToSignObj,
          signInputIndexes,
          takerTokenReceiveAddress,
          expectedSendJsonHex,
          makerSendPskt0: makerPskt0,
          isComplianceWallet,
          bcwOpenSwapFinalizeIntent,
          bcwOpenSwapFinalizeIntentMessage,
          txToSignSafeJson
        });

        return res.json({
          ok: true,
          stage: "finalize_prepare",
          finalizeRid,
          notes: [
            "maker_list_taker_send",
            "open_v2_phase1_manual_import_only",
            "cb4b2_finalize_prepare_ready"
          ],
          txToSignSafeJson: isComplianceWallet ? undefined : txToSignSafeJson,
          signInputIndexes: isComplianceWallet ? [] : signInputIndexes,
          custody_model: isComplianceWallet ? "broker_1of1" : undefined,
          bcw_open_swap_finalize_intent: isComplianceWallet ? bcwOpenSwapFinalizeIntent : undefined,
          intent_message: isComplianceWallet ? bcwOpenSwapFinalizeIntentMessage : undefined,
          covenant_exclusion: takerCovenantExclusion.exclusion,
          diagnostics: {
            offerId,
            makerWalletType,
            makerCustodyModel,
            takerWalletType: active.wallet_type,
            takerCustodyModel: custodyModel || null,
            buyAmount: String(offer.buy.amount),
            sellAmount: String(offer.sell.amount),
            p2shInSompi: p2shSompi.toString(),
            tokenReceiverValueSompi: tokenReceiverValue.toString(),
            makerRefundValueSompi: makerRefundValue.toString(),
            takerMinChangeValueSompi: takerMinChangeValue.toString(),
            selectedCount: lastSelectedCount,
            selectedTotalSompi: lastSelectedTotalSompi.toString(),
            changeInitSompi: lastChangeInitSompi === null ? null : lastChangeInitSompi.toString(),
            mass: lastMassVal === null ? null : lastMassVal.toString(),
            feeSompi: lastFeeSompi === null ? null : lastFeeSompi.toString(),
            changeFinalSompi: lastChangeFinalSompi === null ? null : lastChangeFinalSompi.toString(),
            maxMass: String(maxMass)
          },
          sendContext: {
            mode: "open_swap_v2",
            phase: "finalize_prepare",
            networkId: takerNetworkId,
            fromAddress: takerKasSendAddress,
            toAddress: String(offer.maker.kasReceiveAddress),
            takerTokenReceiveAddress,
            asset: "KAS",
            amount: String(offer.buy.amount),
            receiveType: "KRC20",
            receiveAmount: String(offer.sell.amount),
            receiveSymbol: kind === "tick_to_kas"
              ? String(offer.sell.ticker || offer.sell.symbol || "")
              : String(offer.sell.ca || ""),
            validationWarnings: validation.warnings.slice()
          }
        });
      }

      let stage = "finalize_submit";
      const finalizeRid = typeof body?.finalizeRid === "string" ? String(body.finalizeRid).trim() : "";
      if (!finalizeRid) {
        return res.status(400).json({ ok: false, reason: "finalizeRid_required", stage });
      }

      const cached = openSwapFinalizeCache.get(finalizeRid) ?? null;
      if (!cached) {
        return res.status(404).json({ ok: false, reason: "finalizeRid_not_found", stage });
      }
      if (cached.userId !== userId) {
        return res.status(403).json({ ok: false, reason: "finalizeRid_user_mismatch", stage });
      }
      if (Date.now() - cached.createdAtMs > OPEN_SWAP_FINALIZE_CACHE_TTL_MS) {
        openSwapFinalizeCache.delete(finalizeRid);
        return res.status(410).json({ ok: false, reason: "finalizeRid_expired", stage });
      }

      if (cached.isComplianceWallet) {
        if (!bcwOpenSwapFinalizeSubmit) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_finalize_ctx_missing", stage });
        }

        const cachedIntent = cached.bcwOpenSwapFinalizeIntent ?? null;
        const cachedIntentMessage = typeof cached.bcwOpenSwapFinalizeIntentMessage === "string"
          ? cached.bcwOpenSwapFinalizeIntentMessage
          : "";
        const cachedTxToSignSafeJson = typeof cached.txToSignSafeJson === "string"
          ? cached.txToSignSafeJson
          : "";

        if (!cachedIntent || !cachedIntentMessage || !cachedTxToSignSafeJson) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_finalize_cache_missing", stage });
        }

        const submittedIntent = body?.bcw_open_swap_finalize_intent && typeof body.bcw_open_swap_finalize_intent === "object"
          ? body.bcw_open_swap_finalize_intent
          : null;
        if (!submittedIntent) {
          return res.status(400).json({ ok: false, reason: "bcw_open_swap_finalize_intent_required", stage });
        }

        const submittedIntentMessage = canonicalBcwOpenSwapFinalizeIntentMessage(submittedIntent as BcwOpenSwapFinalizeIntentV1);
        if (submittedIntentMessage !== cachedIntentMessage) {
          return res.status(400).json({ ok: false, reason: "bcw_open_swap_finalize_intent_mismatch", stage });
        }

        const bcwAuthSignature = typeof body?.bcw_auth_signature === "string"
          ? String(body.bcw_auth_signature).trim()
          : "";
        if (!isEvenHexString(bcwAuthSignature)) {
          return res.status(400).json({ ok: false, reason: "bcw_auth_signature_invalid", stage });
        }

        const cn = await bcwOpenSwapFinalizeSubmit({
          repoRootPath: repoRoot,
          intent: submittedIntent,
          authSignature: bcwAuthSignature,
          txSafeJson: cachedTxToSignSafeJson
        });

        if (!cn.ok) {
          return res.status(cn.status || 502).json({
            ok: false,
            reason: "bcw_open_swap_finalize_cn_rejected",
            stage,
            cn: cn.data
          });
        }

        const submitTxid = typeof (cn.data as any)?.txid === "string" ? String((cn.data as any).txid) : "";
        if (!submitTxid) {
          return res.status(502).json({
            ok: false,
            reason: "bcw_open_swap_finalize_missing_txid",
            stage,
            cn: cn.data
          });
        }

        const existingOffer = getOpenSwapOffer(repoRoot, cached.offerId);
        let entitlementRecorderWarning = "";
        if (existingOffer && existingOffer.state === "open") {
          const filledAt = new Date().toISOString();
          upsertOpenSwapOffer(repoRoot, {
            ...existingOffer,
            state: "filled",
            updatedAt: filledAt
          });

          const receipt = buildOpenSwapMakerFillReceipt(existingOffer, cached, submitTxid, filledAt);
          const entitlementRecorderResult = recordEntitlementTokenSaleFromMakerFillReceipt(repoRoot, receipt, userId);
          entitlementRecorderWarning = entitlementRecorderResult.warning;
          warnEntitlementRecorder(entitlementRecorderWarning);
          queueEntitlementPurchaseNotification(repoRoot, userId, entitlementRecorderResult);
          queueOperatorEntitlementPurchaseNotification(repoRoot, userId, entitlementRecorderResult);

          const makerUserId =
            typeof existingOffer.makerUserId === "string"
              ? existingOffer.makerUserId.trim()
              : "";

          if (makerUserId) {
            queueUserNotification(
              repoRoot,
              makerUserId,
              "maker_offer_filled",
              "Token Depot — Maker offer filled",
              formatOpenSwapMakerFillReceiptText(receipt)
            );
          }
        }

        openSwapFinalizeCache.delete(finalizeRid);

        return res.json({
          ok: true,
          stage: "bcw_open_swap_finalize_submit",
          notes: [
            "maker_list_taker_send",
            "open_v2_phase1_manual_import_only",
            "bcw_open_swap_finalize_submit_ready"
          ],
          custody_model: "broker_1of1",
          txid: submitTxid,
          cn: cn.data,
          ...(entitlementRecorderWarning ? { entitlement_recorder_warning: entitlementRecorderWarning } : {})
        });
      }

      const signatureScripts: any[] = Array.isArray(body?.signatureScripts) ? body.signatureScripts : [];
      if (signatureScripts.length !== cached.signInputIndexes.length) {
        return res.status(400).json({
          ok: false,
          reason: "signatureScripts_count_mismatch",
          stage,
          expected: cached.signInputIndexes.length,
          received: signatureScripts.length
        });
      }

      const signaturesByIndex = new Map<number, string>();
      for (let i = 0; i < cached.signInputIndexes.length; i++) {
        const inputIndex = cached.signInputIndexes[i];
        const sigHex = typeof signatureScripts[i] === "string" ? signatureScripts[i].trim() : "";
        if (!isEvenHexString(sigHex)) {
          return res.status(400).json({ ok: false, reason: `signatureScript_invalid_input_${inputIndex}`, stage });
        }
        signaturesByIndex.set(inputIndex, sigHex);
      }

      const txFinalObj = cloneTxObjectWithSignatures(cached.txToSignObj, signaturesByIndex);
      const txFinal = new Transaction(txFinalObj);

      const cachedAppNetworkKey = appNetworkKeyFromWalletNetwork(cached.networkId);
      const cachedRpcNetworkId = rpcNetworkIdFromAppNetworkKey(cachedAppNetworkKey);

      const massVal = calculateTransactionMass(cachedRpcNetworkId, txFinal);
      if (massVal > maximumStandardTransactionMass()) {
        return res.status(409).json({ ok: false, reason: "tx_mass_exceeds_max", stage, mass: massVal.toString() });
      }

      const actualFee = openSwapFinalizeTxFee(txFinalObj);
      if (actualFee === null) {
        return res.status(500).json({ ok: false, reason: "finalize_fee_calc_failed", stage });
      }
      const requiredFee = openSwapFinalizeToccataRequiredFee(cachedRpcNetworkId, massVal);
      if (actualFee < requiredFee) {
        return res.status(409).json({
          ok: false,
          reason: "finalize_fee_under_minimum",
          stage,
          feeSompi: actualFee.toString(),
          requiredFeeSompi: requiredFee.toString(),
          mass: massVal.toString()
        });
      }

      const finalizePskb = buildFinalizePskb(cached.makerSendPskt0, txFinalObj);
      const output0KasReceiverSpkHex = normalizeSpkHex(cached.txToSignObj?.outputs?.[0]?.scriptPublicKey);
      const output1TokenReceiverSpkHex = normalizeSpkHex(cached.txToSignObj?.outputs?.[1]?.scriptPublicKey);
      const output2MakerRefundSpkHex = normalizeSpkHex(cached.txToSignObj?.outputs?.[2]?.scriptPublicKey);
      const output3ChangeSpkHex = normalizeSpkHex(cached.txToSignObj?.outputs?.[3]?.scriptPublicKey);
      if (!output0KasReceiverSpkHex || !output1TokenReceiverSpkHex || !output2MakerRefundSpkHex || !output3ChangeSpkHex) {
        return res.status(500).json({ ok: false, reason: "finalize_expected_role_spk_missing", stage });
      }

      const finalValidation = await validateOpenSwapPskbV2(repoRoot, {
        phase: "finalize",
        kind: cached.kind,
        pskb: finalizePskb,
        expectedSendJsonHex: cached.expectedSendJsonHex,
        expectedFinalizeRoles: {
          output0KasReceiverSpkHex,
          output1TokenReceiverSpkHex,
          output2MakerRefundSpkHex,
          output3ChangeSpkHex
        }
      });
      if (!finalValidation.ok) {
        return res.status(400).json({
          ok: false,
          reason: "finalize_pskb_invalid",
          stage,
          errors: finalValidation.errors,
          warnings: finalValidation.warnings
        });
      }

      const rpc = await getSharedRpc(cachedRpcNetworkId);
      const submitRes = await rpc.submitTransaction({ transaction: txFinal, allowOrphan: false });
      const submitTxid = submitRes && typeof (submitRes as any).transactionId === "string"
        ? String((submitRes as any).transactionId)
        : String((txFinal as any).id || "");
      if (!submitTxid) {
        return res.status(502).json({ ok: false, reason: "finalize_submit_missing_txid", stage });
      }

      const existingOffer = getOpenSwapOffer(repoRoot, cached.offerId);
      let entitlementRecorderWarning = "";
      if (existingOffer && existingOffer.state === "open") {
        const filledAt = new Date().toISOString();
        upsertOpenSwapOffer(repoRoot, {
          ...existingOffer,
          state: "filled",
          updatedAt: filledAt
        });

        const receipt = buildOpenSwapMakerFillReceipt(existingOffer, cached, submitTxid, filledAt);
        const entitlementRecorderResult = recordEntitlementTokenSaleFromMakerFillReceipt(repoRoot, receipt, userId);
        entitlementRecorderWarning = entitlementRecorderResult.warning;
        warnEntitlementRecorder(entitlementRecorderWarning);
        queueEntitlementPurchaseNotification(repoRoot, userId, entitlementRecorderResult);
        queueOperatorEntitlementPurchaseNotification(repoRoot, userId, entitlementRecorderResult);

        const makerUserId =
          typeof existingOffer.makerUserId === "string"
            ? existingOffer.makerUserId.trim()
            : "";

        if (makerUserId) {
          queueUserNotification(
            repoRoot,
            makerUserId,
            "maker_offer_filled",
            "Token Depot — Maker offer filled",
            formatOpenSwapMakerFillReceiptText(receipt)
          );
        }
      }

      openSwapFinalizeCache.delete(finalizeRid);

      return res.json({
        ok: true,
        stage: "finalize_submit",
        notes: [
          "maker_list_taker_send",
          "open_v2_phase1_manual_import_only",
          "cb4b2_finalize_submit_ready"
        ],
        txid: submitTxid,
        finalizePskb,
        validationWarnings: finalValidation.warnings.slice(),
        ...(entitlementRecorderWarning ? { entitlement_recorder_warning: entitlementRecorderWarning } : {})
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        reason: "open_swap_finalize_failed",
        error: String(e instanceof Error ? e.message : e)
      });
    }
  });
}
