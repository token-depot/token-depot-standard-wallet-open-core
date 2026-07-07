import type { Express } from "express";
import type { AppNetworkKey, KasplexNetworkId, RpcNetworkId } from "../types";
import crypto from "node:crypto";
import { readWalletStore } from "../storage/walletStore";
import { listUsers, readUserProfile, type UserNotificationSettings } from "../storage/userStore";
import { listOpenSwapOffers, upsertOpenSwapOffer } from "../storage/openSwapOffersStore";
import { getTokenMetadataCacheEntry } from "../storage/tokenMetadataCacheStore";
import { sendNotificationEmail } from "../email/smtp";
import {
  addressPrefixFromAppNetworkKey,
  applyKrc20ToccataFeeRateFloor,
  kasplexNetworkIdFromAppNetworkKey,
  krc20ToccataFeeRateFloorFromAppNetworkKey,
  normalizeAppNetworkKey,
  rpcNetworkIdFromAppNetworkKey
} from "../networks";
import {
  RpcClient,
  createTransactions,
  kaspaToSompi,
  ScriptBuilder,
  Opcodes,
  addressFromScriptPublicKey,
  FeeSource,
  Transaction,
  PSKB,
  PSKT,
  SighashType,
  PublicKey,
  createAddress,
  payToAddressScript
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

export type SwapModeOpenV2Ctx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: RpcNetworkId) => Promise<RpcClient>;
  kasplexGetAddressTokenList: (network: KasplexNetworkId, address: string) => Promise<any>;
  resolveKrc20TokenMetadata?: (input: {
    networkId: AppNetworkKey;
    lookup: {
      kind: "ca" | "tick";
      value: string;
    };
    options?: {
      timeoutMs?: number;
    };
  }) => Promise<{
    ok: boolean;
    data?: {
      identity?: {
        ca?: string | null;
        name?: string | null;
        decimals?: number | null;
      };
    };
  }>;
  getAppConfig: (repoRootPath: string) => any;
  cnRecipientGatesFromPolicy?: (cfg: any) => {
    regulated_cas: string[];
    recipient_allowlist: string[];
  };
  sleepMs: (ms: number) => Promise<void>;
  decodePskbPayloadArray: (pskb: string) => any[];
  encodePskbPayloadArray: (payloadArr: any[]) => string;
  normalizeOpCheckSigSignature64: (sig: any, tag: string) => Uint8Array;
  encodePushOnlyP2shSigScript: (sig: Uint8Array, sighashType: number, redeemScriptHex: string) => string;
  bcwOpenSwapMakerSubmit?: (params: {
    repoRootPath: string;
    intent: unknown;
    authSignature: string;
  }) => Promise<{ ok: boolean; status: number; data: any }>;
  bcwOpenSwapCancelSubmit?: (params: {
    repoRootPath: string;
    intent: unknown;
    authSignature: string;
    txSafeJson: string;
    sendRedeemScriptHex: string;
  }) => Promise<{ ok: boolean; status: number; data: any }>;

  validateOpenSwapPskbV2: (
    repoRootPath: string,
    args: {
      phase: "offer" | "accept" | "finalize";
      kind: "tick_to_kas" | "ca_to_kas";
      pskb: string;
      expectedSendJsonHex?: string;
    }
  ) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
};

type OpenSwapOfferPrepCacheEntry = {
  createdAtMs: number;
  userId: string;
  walletId: string;
  networkId: RpcNetworkId;
  feeRate: number;
  makerAddress0: string;
  makerUserPubkey: string;
  normalized: any;
  offerDraftBase: any;
  offerTermsForHash: any;
  listRedeemScriptHex: string;
  listP2shAddress: string;
  sendRedeemScriptHex: string;
  sendP2shAddress: string;
  makerListPayload: any;
  makerSendPayload: any;
  commitPtxs: any[];
  commitTxids?: string[];
  txToSignObj?: any;
  txToSignSafeJson?: string;
  revealTxToSubmitSafeJson?: string;
  makerListPskb?: string;
  listRevealTxid?: string;
  p2shSendIndex?: number;
  p2shSendSompi?: string;
  sendTxToSignObj?: any;
  sendTxToSignSafeJson?: string;
};

type OpenSwapCancelPrepCacheEntry = {
  createdAtMs: number;
  userId: string;
  walletId: string;
  offerId: string;
  networkId: RpcNetworkId;
  walletType: "standard" | "compliance";
  txToSignSafeJson: string;
  sendRedeemScriptHex: string;
  bcwOpenSwapCancelIntent?: BcwOpenSwapCancelIntentV1;
  intentMessage?: string;
};

const openSwapOfferPrepCache = new Map<string, OpenSwapOfferPrepCacheEntry>();
const openSwapCancelPrepCache = new Map<string, OpenSwapCancelPrepCacheEntry>();

function sweepOpenSwapOfferPrepCache(nowMs: number) {
  const ttlMs = 3 * 60 * 1000;
  for (const [rid, e] of openSwapOfferPrepCache.entries()) {
    if (nowMs - e.createdAtMs > ttlMs) openSwapOfferPrepCache.delete(rid);
  }
}

function sweepOpenSwapCancelPrepCache(nowMs: number) {
  const ttlMs = 3 * 60 * 1000;
  for (const [rid, e] of openSwapCancelPrepCache.entries()) {
    if (nowMs - e.createdAtMs > ttlMs) openSwapCancelPrepCache.delete(rid);
  }
}

function appNetworkKeyFromOpenSwapRpcNetworkId(networkId: RpcNetworkId): AppNetworkKey {
  return networkId === "testnet-10" ? "tn10" : "mainnet";
}

function openSwapToccataFeeRateFloor(networkId: RpcNetworkId): number {
  return krc20ToccataFeeRateFloorFromAppNetworkKey(appNetworkKeyFromOpenSwapRpcNetworkId(networkId));
}

function openSwapCancelFeeRateFloor(networkId: RpcNetworkId): number {
  const toccataFloor = openSwapToccataFeeRateFloor(networkId);
  return networkId === "testnet-10" ? Math.max(200, toccataFloor) : toccataFloor;
}

function openSwapHexByteLength(hex: unknown, errorReason: string): bigint {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(errorReason);
  }
  return BigInt(hex.length / 2);
}

function openSwapTransactionMassWithSignatureScripts(tx: any, errorReason: string): bigint {
  const rawMass = tx && typeof tx === "object" ? tx.mass : null;
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

  const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
  const signatureScriptBytes = inputs.reduce((sum: bigint, input: any) => {
    const script = input && typeof input === "object" ? input.signatureScript : "";
    if (script === undefined || script === null || script === "") return sum;
    return sum + openSwapHexByteLength(script, errorReason);
  }, 0n);

  return baseMass + signatureScriptBytes;
}

function openSwapToccataRequiredFee(networkId: RpcNetworkId, tx: any, errorReason: string): bigint {
  return openSwapTransactionMassWithSignatureScripts(tx, errorReason) * BigInt(openSwapToccataFeeRateFloor(networkId));
}


const OPEN_SWAP_COMMIT_MAX_CANDIDATE_INPUTS = 4;
const OPEN_SWAP_COMMIT_MAX_CANDIDATE_ATTEMPTS = 48;
const OPEN_SWAP_COMMIT_RECOMMENDED_RESERVE_SOMPI = 5000000n;

type OpenSwapCommitFundingSelection = {
  ok: true;
  created: any;
  entries: any[];
  selectedCount: number;
  selectedTotalSompi: string;
} | {
  ok: false;
  reason: "no_usable_open_swap_commit_utxo";
  detail: string;
  neededSompi: string;
  neededKas: string;
  recommendedSelfSendSompi: string;
  recommendedSelfSendKas: string;
  totalAvailableSompi: string;
  totalAvailableKas: string;
  largestUtxoSompi: string;
  largestUtxoKas: string;
  utxoCount: number;
  validUtxoCount: number;
  candidateInputLimit: number;
  candidateAttempts: number;
  lastSelectionError: string;
};

function readOpenSwapCommitSompi(value: any): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  }
  if (value && typeof value === "object") {
    for (const key of ["sompi", "amount", "value", "valueSompi", "value_sompi"]) {
      const inner = readOpenSwapCommitSompi((value as any)[key]);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function readOpenSwapCommitEntrySompi(entry: any): bigint | null {
  return readOpenSwapCommitSompi((entry as any)?.utxoEntry?.amount ?? (entry as any)?.amount ?? (entry as any)?.utxo?.amount);
}

function formatOpenSwapCommitKasFromSompi(value: bigint): string {
  const whole = value / 100000000n;
  const frac = value % 100000000n;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

function openSwapCommitRecommendedReserveSompi(feeRate: number): bigint {
  const rate = Number.isFinite(feeRate) && feeRate > 0 ? Math.ceil(feeRate) : 1;
  const feeBasedReserve = BigInt(rate) * 10000n;
  return feeBasedReserve > OPEN_SWAP_COMMIT_RECOMMENDED_RESERVE_SOMPI ? feeBasedReserve : OPEN_SWAP_COMMIT_RECOMMENDED_RESERVE_SOMPI;
}

function openSwapCommitEntrySortKey(entry: any): string {
  const txid = typeof (entry as any)?.outpoint?.transactionId === "string" ? String((entry as any).outpoint.transactionId) : "";
  const index = Number((entry as any)?.outpoint?.index ?? 0);
  return `${txid}:${Number.isFinite(index) ? index : 0}`;
}

function openSwapCommitCandidateKey(items: { entry: any; amount: bigint }[]): string {
  return items.map((item) => openSwapCommitEntrySortKey(item.entry)).sort().join("|");
}

async function selectOpenSwapCommitFundingEntries(args: {
  ownerEntries: any[];
  commitAmountSompi: bigint;
  listP2shAddress: string;
  changeAddress: string;
  effectiveFeeRate: number;
  networkId: RpcNetworkId;
}): Promise<OpenSwapCommitFundingSelection> {
  const validEntries = args.ownerEntries
    .map((entry) => ({ entry, amount: readOpenSwapCommitEntrySompi(entry) }))
    .filter((item): item is { entry: any; amount: bigint } => item.amount !== null && item.amount > 0n)
    .sort((a, b) => {
      if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
      const ak = openSwapCommitEntrySortKey(a.entry);
      const bk = openSwapCommitEntrySortKey(b.entry);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });

  const totalAvailableSompi = validEntries.reduce((acc, item) => acc + item.amount, 0n);
  const largestUtxoSompi = validEntries.reduce((largest, item) => item.amount > largest ? item.amount : largest, 0n);
  const reserveSompi = openSwapCommitRecommendedReserveSompi(args.effectiveFeeRate);
  const recommendedSelfSendSompi = args.commitAmountSompi + reserveSompi;
  const neededKas = formatOpenSwapCommitKasFromSompi(args.commitAmountSompi);
  const recommendedSelfSendKas = formatOpenSwapCommitKasFromSompi(recommendedSelfSendSompi);

  const makeFailure = (candidateAttempts: number, lastSelectionError: string): OpenSwapCommitFundingSelection => ({
    ok: false,
    reason: "no_usable_open_swap_commit_utxo",
    detail: `No usable UTXO is available to create this offer. This wallet has funds, but not in a UTXO size/shape that can safely build this transaction. Needed: approximately ${neededKas} KAS plus network fee in one spendable UTXO, or in a small number of compatible UTXOs. To fix this, send yourself about ${recommendedSelfSendKas} KAS from another wallet, or switch to a wallet that has a suitable UTXO. Then refresh holdings and try again.`,
    neededSompi: args.commitAmountSompi.toString(),
    neededKas,
    recommendedSelfSendSompi: recommendedSelfSendSompi.toString(),
    recommendedSelfSendKas,
    totalAvailableSompi: totalAvailableSompi.toString(),
    totalAvailableKas: formatOpenSwapCommitKasFromSompi(totalAvailableSompi),
    largestUtxoSompi: largestUtxoSompi.toString(),
    largestUtxoKas: formatOpenSwapCommitKasFromSompi(largestUtxoSompi),
    utxoCount: args.ownerEntries.length,
    validUtxoCount: validEntries.length,
    candidateInputLimit: OPEN_SWAP_COMMIT_MAX_CANDIDATE_INPUTS,
    candidateAttempts,
    lastSelectionError
  });

  if (!validEntries.length) {
    return makeFailure(0, "no_valid_utxos");
  }

  const candidateSets: { entry: any; amount: bigint }[][] = [];
  const seenCandidates = new Set<string>();
  const pushCandidate = (items: { entry: any; amount: bigint }[]) => {
    if (!items.length || items.length > OPEN_SWAP_COMMIT_MAX_CANDIDATE_INPUTS) return;
    const total = items.reduce((acc, item) => acc + item.amount, 0n);
    if (total < args.commitAmountSompi) return;
    const key = openSwapCommitCandidateKey(items);
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    candidateSets.push(items.slice());
  };

  for (const item of validEntries) {
    if (item.amount >= args.commitAmountSompi) pushCandidate([item]);
  }

  const belowTarget = validEntries.filter((item) => item.amount < args.commitAmountSompi);
  const descendingBelowTarget = belowTarget.slice().reverse();

  let descendingTotal = 0n;
  const descendingAccum: { entry: any; amount: bigint }[] = [];
  for (const item of descendingBelowTarget) {
    if (descendingAccum.length >= OPEN_SWAP_COMMIT_MAX_CANDIDATE_INPUTS) break;
    descendingAccum.push(item);
    descendingTotal += item.amount;
    if (descendingTotal >= args.commitAmountSompi) pushCandidate(descendingAccum);
  }

  let ascendingTotal = 0n;
  const ascendingAccum: { entry: any; amount: bigint }[] = [];
  for (const item of belowTarget) {
    if (ascendingAccum.length >= OPEN_SWAP_COMMIT_MAX_CANDIDATE_INPUTS) break;
    ascendingAccum.push(item);
    ascendingTotal += item.amount;
    if (ascendingTotal >= args.commitAmountSompi) pushCandidate(ascendingAccum);
  }

  const comboWindow = validEntries.slice(0, Math.min(validEntries.length, 24));
  for (let i = 0; i < comboWindow.length; i++) {
    for (let j = i + 1; j < comboWindow.length; j++) {
      pushCandidate([comboWindow[i], comboWindow[j]]);
    }
  }

  candidateSets.sort((a, b) => {
    const at = a.reduce((acc, item) => acc + item.amount, 0n);
    const bt = b.reduce((acc, item) => acc + item.amount, 0n);
    if (a.length !== b.length) return a.length - b.length;
    if (at !== bt) return at < bt ? -1 : 1;
    return openSwapCommitCandidateKey(a) < openSwapCommitCandidateKey(b) ? -1 : 1;
  });

  const attempts = candidateSets.slice(0, OPEN_SWAP_COMMIT_MAX_CANDIDATE_ATTEMPTS);
  let lastSelectionError = attempts.length ? "no_candidate_succeeded" : "no_candidate_set";

  for (const candidate of attempts) {
    const entries = candidate.map((item) => item.entry);
    const selectedTotalSompi = candidate.reduce((acc, item) => acc + item.amount, 0n);
    try {
      const created = await createTransactions({
        outputs: [{ address: args.listP2shAddress, amount: args.commitAmountSompi }],
        changeAddress: args.changeAddress,
        feeRate: args.effectiveFeeRate,
        priorityFee: { amount: 0n, source: FeeSource.SenderPays },
        entries,
        networkId: args.networkId
      });
      const transactions: any[] = created && Array.isArray((created as any).transactions) ? (created as any).transactions : [];
      if (!transactions.length) {
        lastSelectionError = "candidate_unexpected_empty_batch";
        continue;
      }
      return {
        ok: true,
        created,
        entries,
        selectedCount: entries.length,
        selectedTotalSompi: selectedTotalSompi.toString()
      };
    } catch (e: any) {
      lastSelectionError = e && typeof e.message === "string" ? e.message.slice(0, 180) : String(e).slice(0, 180);
    }
  }

  return makeFailure(attempts.length, lastSelectionError);
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

function queueNewOpenOfferNotifications(
  repoRoot: string,
  subject: string,
  text: string
): void {
  try {
    const users = listUsers(repoRoot);
    for (const user of users) {
      const userId = String(user && user.id ? user.id : "").trim();
      if (!userId) continue;
      queueUserNotification(repoRoot, userId, "new_offers", subject, text);
    }
  } catch {
    return;
  }
}

type OpenOfferBatchNotification = {
  id: string;
  index: number;
  total: number;
};

function normalizeOpenOfferBatchNotification(body: any): OpenOfferBatchNotification | null {
  const id = typeof body?.openOfferBatchId === "string" ? body.openOfferBatchId.trim() : "";
  const index = Number(body?.openOfferBatchIndex);
  const total = Number(body?.openOfferBatchTotal);

  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  if (!Number.isSafeInteger(index) || index < 1) return null;
  if (!Number.isSafeInteger(total) || total <= 1 || total > 1000) return null;
  if (index > total) return null;

  return { id, index, total };
}

function shouldQueueOpenOfferBatchNotification(batch: OpenOfferBatchNotification | null): boolean {
  if (!batch || batch.total <= 1) return true;
  return batch.index === batch.total;
}

function openOfferNotificationSubject(audience: "maker" | "users", batch: OpenOfferBatchNotification | null): string {
  if (batch && batch.total > 1) {
    return audience === "maker"
      ? "Token Depot — Maker offers created"
      : "Token Depot — New open offers";
  }

  return audience === "maker"
    ? "Token Depot — Maker offer created"
    : "Token Depot — New open offer";
}

function buildOpenOfferNotificationText(input: {
  audience: "maker" | "users";
  batch: OpenOfferBatchNotification | null;
  offerId: string;
  networkId: string;
  kind: string;
  sellAsset: string;
  sellAmount: string;
  buyAmountKas: string;
  offerDescription: string;
  offerInfoUrl: string;
}): string {
  const batch = input.batch && input.batch.total > 1 ? input.batch : null;
  const lines: string[] = [];

  lines.push(
    input.audience === "maker"
      ? (batch ? `Created ${batch.total} live open offers.` : "An open maker offer was created.")
      : (batch ? `Now available: ${batch.total} live open offers.` : "A new open offer is available.")
  );

  lines.push("");
  if (batch) {
    lines.push(`Batch ID: ${batch.id}`);
    lines.push(`Batch size: ${batch.total}`);
    lines.push(`Latest offer ID: ${input.offerId}`);
  } else {
    lines.push(`Offer ID: ${input.offerId}`);
  }

  lines.push(`Network: ${input.networkId}`);
  lines.push(`Kind: ${input.kind}`);
  lines.push(`Sell asset: ${input.sellAsset}`);
  lines.push(`Sell amount: ${input.sellAmount}`);
  lines.push(`Buy amount KAS: ${input.buyAmountKas}`);

  if (input.offerDescription) {
    lines.push("");
    lines.push("Offer description / terms:");
    lines.push(input.offerDescription);
  }

  if (input.offerInfoUrl) {
    lines.push("");
    lines.push(`More information: ${input.offerInfoUrl}`);
  }

  return lines.join("\n");
}

function parseOpenSwapSellSymbol(raw: unknown): { kind: ""; symbol: ""; ticker: ""; caHex: "" } | { kind: "TICK"; symbol: string; ticker: string; caHex: "" } | { kind: "CA"; symbol: string; ticker: ""; caHex: string } {
  const sym = typeof raw === "string" ? raw.trim() : "";
  if (!sym) return { kind: "", symbol: "", ticker: "", caHex: "" };

  if (/^CA:/i.test(sym)) {
    const caHex = sym.slice(3).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(caHex)) return { kind: "", symbol: "", ticker: "", caHex: "" };
    return { kind: "CA", symbol: `CA:${caHex}`, ticker: "", caHex };
  }

  const ticker = sym.toUpperCase();
  if (!/^[A-Za-z0-9]{1,16}$/.test(ticker)) return { kind: "", symbol: "", ticker: "", caHex: "" };
  return { kind: "TICK", symbol: ticker, ticker, caHex: "" };
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

type BcwOpenSwapMakerNetworkInput = "testnet" | "mainnet";

type BcwOpenSwapMakerIntentV1 = {
  v: 1;
  purpose: "bcw_open_swap_maker";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: BcwOpenSwapMakerNetworkInput;
  broker_custody_key_ref: string;
  from_address: string;
  maker_kas_receive_address: string;
  kind: "tick_to_kas" | "ca_to_kas";
  tick: string;
  ca: string;
  sell_amount_raw: string;
  buy_amount_sompi: string;
  ttl_seconds: number;
  user_auth_pubkey: string;
  created_at: string;
  expires_at: string;
  nonce: string;
};

function walletNetworkToBcwOpenSwapMakerNetwork(raw: unknown): BcwOpenSwapMakerNetworkInput | "" {
  const appNetworkKey = normalizeAppNetworkKey(raw);
  if (!appNetworkKey) return "";
  if (appNetworkKey === "tn10") return "testnet";
  if (appNetworkKey === "mainnet") return "mainnet";
  return "";
}

function normalizeBcwOpenSwapMakerTtlSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return -1;
  const ttl = Math.round(n);
  return ttl === 0 || (ttl >= 60 && ttl <= 168 * 60 * 60) ? ttl : -1;
}

function newBcwOpenSwapMakerNonce(): string {
  return `BCWOPENMAKERREQ_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("hex")}`;
}

function canonicalBcwOpenSwapMakerIntentMessage(intent: BcwOpenSwapMakerIntentV1): string {
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
    kind: intent.kind,
    tick: intent.tick,
    ca: intent.ca,
    sell_amount_raw: intent.sell_amount_raw,
    buy_amount_sompi: intent.buy_amount_sompi,
    ttl_seconds: intent.ttl_seconds,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    nonce: intent.nonce
  });
}

function normalizeBcwOpenSwapMakerIntent(raw: unknown): BcwOpenSwapMakerIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network = input.network === "testnet" || input.network === "mainnet" ? input.network : "";
  const kind = input.kind === "tick_to_kas" || input.kind === "ca_to_kas" ? input.kind : "";
  const ttlSeconds = normalizeBcwOpenSwapMakerTtlSeconds(input.ttl_seconds);

  const intent: BcwOpenSwapMakerIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_open_swap_maker" ? "bcw_open_swap_maker" : "" as "bcw_open_swap_maker",
    wallet_id: typeof input.wallet_id === "string" ? input.wallet_id.trim() : "",
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network: network as BcwOpenSwapMakerNetworkInput,
    broker_custody_key_ref: typeof input.broker_custody_key_ref === "string" ? input.broker_custody_key_ref.trim() : "",
    from_address: typeof input.from_address === "string" ? input.from_address.trim() : "",
    maker_kas_receive_address: typeof input.maker_kas_receive_address === "string" ? input.maker_kas_receive_address.trim() : "",
    kind: kind as "tick_to_kas" | "ca_to_kas",
    tick: typeof input.tick === "string" ? input.tick.trim().toUpperCase() : "",
    ca: typeof input.ca === "string" ? input.ca.trim().toLowerCase() : "",
    sell_amount_raw: typeof input.sell_amount_raw === "string" || typeof input.sell_amount_raw === "number" ? String(input.sell_amount_raw).trim() : "",
    buy_amount_sompi: typeof input.buy_amount_sompi === "string" || typeof input.buy_amount_sompi === "number" ? String(input.buy_amount_sompi).trim() : "",
    ttl_seconds: ttlSeconds,
    user_auth_pubkey: typeof input.user_auth_pubkey === "string" ? input.user_auth_pubkey.trim() : "",
    created_at: typeof input.created_at === "string" ? input.created_at.trim() : "",
    expires_at: typeof input.expires_at === "string" ? input.expires_at.trim() : "",
    nonce: typeof input.nonce === "string" ? input.nonce.trim() : ""
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_open_swap_maker") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (intent.network !== "testnet" && intent.network !== "mainnet") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.maker_kas_receive_address) return null;
  if (intent.kind !== "tick_to_kas" && intent.kind !== "ca_to_kas") return null;
  if (!intent.sell_amount_raw || !/^[0-9]+$/.test(intent.sell_amount_raw) || BigInt(intent.sell_amount_raw) <= 0n) return null;
  if (!intent.buy_amount_sompi || !/^[0-9]+$/.test(intent.buy_amount_sompi) || BigInt(intent.buy_amount_sompi) <= 0n) return null;
  if (intent.ttl_seconds !== 0 && (intent.ttl_seconds < 60 || intent.ttl_seconds > 168 * 60 * 60)) return null;
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(intent.user_auth_pubkey)) return null;
  if (!intent.created_at || !intent.nonce) return null;
  if (intent.ttl_seconds === 0 && intent.expires_at) return null;
  if (intent.ttl_seconds > 0 && !intent.expires_at) return null;
  if (!/^BCWOPENMAKERREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;

  if (intent.kind === "ca_to_kas") {
    if (!/^[0-9a-f]{64}$/.test(intent.ca)) return null;
    if (intent.tick) return null;
  } else {
    if (!/^[A-Z0-9]{1,16}$/.test(intent.tick)) return null;
    if (intent.ca) return null;
  }

  return intent;
}

function formatBcwOpenSwapMakerKasFromSompi(raw: string): string {
  const s = String(raw || "").trim();
  if (!/^[0-9]+$/.test(s)) return "";

  const n = BigInt(s);
  const whole = n / 100000000n;
  const frac = n % 100000000n;
  if (frac === 0n) return whole.toString();

  const fracText = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracText}`;
}

type BcwOpenSwapCancelIntentV1 = {
  v: 1;
  purpose: "bcw_open_swap_cancel";
  wallet_id: string;
  wallet_type: "compliance";
  custody_model: "broker_1of1";
  network: BcwOpenSwapMakerNetworkInput;
  broker_custody_key_ref: string;
  from_address: string;
  maker_kas_receive_address: string;
  offer_id: string;
  p2sh_send_outpoint_txid: string;
  p2sh_send_outpoint_index: number;
  p2sh_send_sompi: string;
  send_p2sh_address: string;
  send_redeem_script_sha256: string;
  tx_safe_json_sha256: string;
  user_auth_pubkey: string;
  created_at: string;
  nonce: string;
};

function newBcwOpenSwapCancelNonce(): string {
  return `BCWOPENCANCELREQ_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("hex")}`;
}

function canonicalBcwOpenSwapCancelIntentMessage(intent: BcwOpenSwapCancelIntentV1): string {
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
    offer_id: intent.offer_id,
    p2sh_send_outpoint_txid: intent.p2sh_send_outpoint_txid,
    p2sh_send_outpoint_index: intent.p2sh_send_outpoint_index,
    p2sh_send_sompi: intent.p2sh_send_sompi,
    send_p2sh_address: intent.send_p2sh_address,
    send_redeem_script_sha256: intent.send_redeem_script_sha256,
    tx_safe_json_sha256: intent.tx_safe_json_sha256,
    user_auth_pubkey: intent.user_auth_pubkey,
    created_at: intent.created_at,
    nonce: intent.nonce
  });
}

function normalizeBcwOpenSwapCancelIntent(raw: unknown): BcwOpenSwapCancelIntentV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const network = input.network === "testnet" || input.network === "mainnet" ? input.network : "";
  const outpointIndex = Number(input.p2sh_send_outpoint_index ?? -1);

  const intent: BcwOpenSwapCancelIntentV1 = {
    v: input.v === 1 ? 1 : 0 as 1,
    purpose: input.purpose === "bcw_open_swap_cancel" ? "bcw_open_swap_cancel" : "" as "bcw_open_swap_cancel",
    wallet_id: typeof input.wallet_id === "string" ? input.wallet_id.trim() : "",
    wallet_type: input.wallet_type === "compliance" ? "compliance" : "" as "compliance",
    custody_model: input.custody_model === "broker_1of1" ? "broker_1of1" : "" as "broker_1of1",
    network: network as BcwOpenSwapMakerNetworkInput,
    broker_custody_key_ref: typeof input.broker_custody_key_ref === "string" ? input.broker_custody_key_ref.trim() : "",
    from_address: typeof input.from_address === "string" ? input.from_address.trim() : "",
    maker_kas_receive_address: typeof input.maker_kas_receive_address === "string" ? input.maker_kas_receive_address.trim() : "",
    offer_id: typeof input.offer_id === "string" ? input.offer_id.trim() : "",
    p2sh_send_outpoint_txid: typeof input.p2sh_send_outpoint_txid === "string" ? input.p2sh_send_outpoint_txid.trim().toLowerCase() : "",
    p2sh_send_outpoint_index: Number.isInteger(outpointIndex) ? outpointIndex : -1,
    p2sh_send_sompi: typeof input.p2sh_send_sompi === "string" || typeof input.p2sh_send_sompi === "number" ? String(input.p2sh_send_sompi).trim() : "",
    send_p2sh_address: typeof input.send_p2sh_address === "string" ? input.send_p2sh_address.trim() : "",
    send_redeem_script_sha256: typeof input.send_redeem_script_sha256 === "string" ? input.send_redeem_script_sha256.trim().toLowerCase() : "",
    tx_safe_json_sha256: typeof input.tx_safe_json_sha256 === "string" ? input.tx_safe_json_sha256.trim().toLowerCase() : "",
    user_auth_pubkey: typeof input.user_auth_pubkey === "string" ? input.user_auth_pubkey.trim() : "",
    created_at: typeof input.created_at === "string" ? input.created_at.trim() : "",
    nonce: typeof input.nonce === "string" ? input.nonce.trim() : ""
  };

  if (intent.v !== 1) return null;
  if (intent.purpose !== "bcw_open_swap_cancel") return null;
  if (intent.wallet_type !== "compliance") return null;
  if (intent.custody_model !== "broker_1of1") return null;
  if (intent.network !== "testnet") return null;
  if (!intent.wallet_id || !intent.broker_custody_key_ref) return null;
  if (!intent.from_address || !intent.maker_kas_receive_address) return null;
  if (!intent.offer_id) return null;
  if (!/^[0-9a-f]{64}$/.test(intent.p2sh_send_outpoint_txid)) return null;
  if (!Number.isInteger(intent.p2sh_send_outpoint_index) || intent.p2sh_send_outpoint_index < 0) return null;
  if (!/^[0-9]+$/.test(intent.p2sh_send_sompi) || BigInt(intent.p2sh_send_sompi) <= 0n) return null;
  if (!intent.send_p2sh_address) return null;
  if (!/^[0-9a-f]{64}$/.test(intent.send_redeem_script_sha256)) return null;
  if (!/^[0-9a-f]{64}$/.test(intent.tx_safe_json_sha256)) return null;
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(intent.user_auth_pubkey)) return null;
  if (!intent.created_at || !/^BCWOPENCANCELREQ_[A-Za-z0-9_-]+$/.test(intent.nonce)) return null;

  return intent;
}

function readActiveOpenSwapMaker(repoRoot: string, userId: string): any | null {
  const store = readWalletStore(repoRoot, userId);
  const items = Array.isArray(store?.items) ? store.items : [];
  const activeId = typeof store?.active_id === "string" ? store.active_id.trim() : "";
  if (!activeId) return null;
  return items.find((it: any) => it && it.id === activeId) ?? null;
}

function normalizeOpenSwapBoardNetwork(raw: unknown): RpcNetworkId | "" {
  const appNetworkKey = normalizeAppNetworkKey(raw);
  return appNetworkKey ? rpcNetworkIdFromAppNetworkKey(appNetworkKey) : "";
}

function normalizeOpenSwapBoardState(raw: unknown): "open" | "filled" | "expired" | "cancelled" | "" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!v || v === "all") return "";
  if (v === "open" || v === "filled" || v === "expired" || v === "cancelled") return v;
  return "";
}

function sanitizeOpenOfferDescription(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  return value.slice(0, 2000);
}

function sanitizeOpenOfferInfoUrl(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString().slice(0, 500);
  } catch {
    return "";
  }
}

function analyzeOpenSwapRequest(body: any, active: any) {
  const blockers: string[] = [];
  const notes: string[] = [];

  const walletType = typeof active?.wallet_type === "string" ? active.wallet_type.trim() : "";
  const custodyModel = typeof active?.custody_model === "string" ? active.custody_model.trim() : "";
  const appNetworkKey = normalizeAppNetworkKey(active?.network);
  const networkId: RpcNetworkId | "" = appNetworkKey ? rpcNetworkIdFromAppNetworkKey(appNetworkKey) : "";
  const makerAddress = typeof active?.address0 === "string" ? active.address0.trim() : "";
  const userPubkey = typeof active?.user_pubkey === "string" ? active.user_pubkey.trim() : "";
  const brokerCustodyKeyRef = typeof active?.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
  const userAuthPubkey = typeof active?.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
  const isStandardWallet = walletType === "standard";
  const isBcwBrokerCustody = walletType === "compliance" && custodyModel === "broker_1of1";

  if (!walletType) blockers.push("active_wallet_type_missing");
  if (!isStandardWallet && !isBcwBrokerCustody) blockers.push("wallet_unsupported_for_open_maker");
  if (!networkId) blockers.push("active_wallet_network_missing");
  if (!makerAddress) blockers.push("active_wallet_address_missing");
  if (appNetworkKey && makerAddress && !makerAddress.startsWith(`${addressPrefixFromAppNetworkKey(appNetworkKey)}:`)) {
    blockers.push("active_wallet_address_missing");
  }

  if (isStandardWallet && (!userPubkey || !/^(02|03)[0-9a-fA-F]{64}$/.test(userPubkey))) {
    blockers.push("wallet_missing_user_pubkey");
  }

  if (isBcwBrokerCustody) {
    if (!brokerCustodyKeyRef) blockers.push("bcw_broker_custody_key_ref_missing");
    if (!userAuthPubkey || !/^(02|03)[0-9a-fA-F]{64}$/.test(userAuthPubkey)) {
      blockers.push("bcw_user_auth_pubkey_missing");
    }
  }

  const sell = body && typeof body.sell === "object" ? body.sell : {};
  const buy = body && typeof body.buy === "object" ? body.buy : {};

  const sellType = typeof sell.type === "string" ? sell.type.trim().toUpperCase() : "";
  const buyType = typeof buy.type === "string" ? buy.type.trim().toUpperCase() : "";
  const buySymbol = typeof buy.symbol === "string" ? buy.symbol.trim().toUpperCase() : "";

  if (sellType !== "KRC20") blockers.push("sell_type_invalid");
  if (buyType !== "KAS") blockers.push("buy_asset_invalid");
  if (buyType === "KAS" && buySymbol && buySymbol !== "KAS") blockers.push("buy_asset_invalid");

  const parsedSell = parseOpenSwapSellSymbol(sell.symbol);
  if (!parsedSell.kind) blockers.push("sell_asset_invalid");

  const sellAmountStr =
    typeof body?.sell_amount === "string" || typeof body?.sell_amount === "number"
      ? String(body.sell_amount).trim()
      : typeof body?.amount === "string" || typeof body?.amount === "number"
        ? String(body.amount).trim()
        : "";

  if (!sellAmountStr) {
    blockers.push("invalid_amount");
  } else if (!/^[0-9]+(\.[0-9]+)?$/.test(sellAmountStr)) {
    blockers.push("invalid_amount");
  } else if (!(Number(sellAmountStr) > 0)) {
    blockers.push("amount_must_be_positive");
  }

  const buyAmountStr =
    typeof body?.buy_amount === "string" || typeof body?.buy_amount === "number"
      ? String(body.buy_amount).trim()
      : "";

  if (!buyAmountStr) {
    blockers.push("invalid_amount");
  } else if (!/^[0-9]+(\.[0-9]+)?$/.test(buyAmountStr)) {
    blockers.push("invalid_amount");
  } else if (!(Number(buyAmountStr) > 0)) {
    blockers.push("amount_must_be_positive");
  }

  const offerDescription = sanitizeOpenOfferDescription(
    body?.offerDescription ?? body?.offer_description ?? body?.description
  );
  const offerInfoUrl = sanitizeOpenOfferInfoUrl(
    body?.offerInfoUrl ?? body?.offer_info_url ?? body?.info_url
  );
  const openOfferBatch = normalizeOpenOfferBatchNotification(body);

  const ttlRaw =
    typeof body?.ttl === "number" || typeof body?.ttl === "string"
      ? Number(body.ttl)
      : NaN;

  if (!Number.isFinite(ttlRaw)) {
    blockers.push("ttl_invalid");
  } else {
    const ttl = Math.round(ttlRaw);
    if (ttl !== 0 && (ttl < 60 || ttl > 168 * 60 * 60)) blockers.push("ttl_out_of_range");
  }

  const partialEnabled = !!(body?.partial && typeof body.partial === "object" && body.partial.enabled);
  if (partialEnabled) blockers.push("partial_fields_invalid");

  notes.push("maker_list_taker_send");
  notes.push("open_v2_phase1_manual_import_only");
  notes.push("full_fill_only");

  return {
    blockers,
    notes,
    normalized: {
      kind: parsedSell.kind === "CA" ? "ca_to_kas" : "tick_to_kas",
      maker: {
        walletId: typeof active?.id === "string" ? active.id : "",
        walletType,
        custodyModel,
        networkId,
        kasReceiveAddress: makerAddress,
        userPubkey,
        brokerCustodyKeyRef,
        userAuthPubkey
      },
      sell: {
        type: "KRC20",
        kind: parsedSell.kind,
        symbol: parsedSell.symbol,
        ticker: parsedSell.ticker || null,
        ca: parsedSell.caHex || null,
        name: typeof sell.name === "string" ? sell.name.trim().slice(0, 128) : "",
        amount: sellAmountStr
      },
      buy: {
        type: "KAS",
        symbol: "KAS",
        amount: buyAmountStr
      },
      offerDescription,
      offerInfoUrl,
      openOfferBatch,
      ttl: Number.isFinite(ttlRaw) ? Math.round(ttlRaw) : null,
      partial: { enabled: false }
    }
  };
}

function toBaseUnits(humanIn: string, dec: number): string | null {
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
}

function bytesToHex(v: any): string {
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
}

function spkToHex(spk: any): string {
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
}

async function resolveOpenSwapSellMeta(ctx: SwapModeOpenV2Ctx, normalized: any, active: any) {
  const appNetworkKey = normalizeAppNetworkKey(active.network);
  if (!appNetworkKey) {
    throw new Error("active_wallet_network_missing");
  }

  const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
  const kasplexNetwork = kasplexNetworkIdFromAppNetworkKey(appNetworkKey);
  const isBcwBrokerCustody = normalized?.maker?.walletType === "compliance" && normalized?.maker?.custodyModel === "broker_1of1";
  let kasplexSenderAddress = "";

  if (isBcwBrokerCustody) {
    kasplexSenderAddress = String(active.address0 || "").trim();
  } else {
    const userPub = new PublicKey(String(active.user_pubkey || "").trim());
    const kasplexSenderAddrObj = createAddress(userPub, networkId);
    kasplexSenderAddress = kasplexSenderAddrObj ? kasplexSenderAddrObj.toString() : "";
  }

  if (!kasplexSenderAddress) {
    throw new Error("krc20_sender_address_failed");
  }

  const holdings = await ctx.kasplexGetAddressTokenList(kasplexNetwork, kasplexSenderAddress);

  let tokenDec: number | null = null;
  let heldAmount: number | null = null;
  let sellName: string | null = null;

  if (normalized.kind === "tick_to_kas") {
    const tick = String(normalized.sell.ticker || "").trim().toUpperCase();
    tokenDec =
      holdings && holdings.token_dec && Object.prototype.hasOwnProperty.call(holdings.token_dec, tick)
        ? (holdings.token_dec as any)[tick]
        : null;
    heldAmount =
      holdings && holdings.tokens && Object.prototype.hasOwnProperty.call(holdings.tokens, tick)
        ? Number((holdings.tokens as any)[tick])
        : null;
  } else {
    const caHex = String(normalized.sell.ca || "").trim().toLowerCase();
    const issue = Array.isArray(holdings && (holdings as any).issue) ? (holdings as any).issue : [];
    const hit = issue.find((x: any) => String(x && x.ca ? x.ca : "").trim().toLowerCase() === caHex) ?? null;
    tokenDec = hit && typeof hit.dec === "number" ? hit.dec : null;
    heldAmount = hit && hit.amount !== undefined ? Number(hit.amount) : null;
    sellName = hit && typeof hit.name === "string" ? hit.name : null;
  }

  if (typeof tokenDec !== "number" || !Number.isFinite(tokenDec) || tokenDec < 0 || tokenDec > 18) {
    throw new Error("krc20_sender_balance_insufficient");
  }

  const baseAmountStr = toBaseUnits(String(normalized.sell.amount || ""), tokenDec);
  if (!baseAmountStr || baseAmountStr === "0") {
    throw new Error("invalid_amt_precision");
  }

  const sellAmountNum = Number(normalized.sell.amount);
  if (!Number.isFinite(sellAmountNum) || sellAmountNum <= 0) {
    throw new Error("invalid_amount");
  }

  if (heldAmount == null || !Number.isFinite(heldAmount) || heldAmount < sellAmountNum) {
    throw new Error("krc20_sender_balance_insufficient");
  }

  return {
    networkId,
    kasplexSenderAddress,
    tokenDec,
    heldAmount,
    sellName,
    baseAmountStr
  };
}

function buildOpenSwapPskbForOffer(txToSignObj: any, signatureScriptHex: string, redeemScriptHex: string, ctx: SwapModeOpenV2Ctx): string {
  let pskt = new PSKT(undefined);
  pskt = pskt.inputsModifiable();
  pskt = pskt.outputsModifiable();
  pskt = pskt.toConstructor();

  const input0 = txToSignObj && Array.isArray(txToSignObj.inputs) ? txToSignObj.inputs[0] : null;
  if (!input0) throw new Error("tx_to_sign_missing_input0");

  const input0ForPskt: any = {
    previousOutpoint: input0.previousOutpoint,
    signatureScript: signatureScriptHex,
    sequence: input0.sequence,
    sigOpCount: input0.sigOpCount,
    sighashType: SighashType.SingleAnyOneCanPay,
    utxo: input0.utxo
  };

  pskt = pskt.inputAndRedeemScript(
    input0ForPskt,
    {
      redeemScript: redeemScriptHex,
      sighashType: SighashType.SingleAnyOneCanPay
    }
  );

  const outputs: any[] = Array.isArray(txToSignObj.outputs) ? txToSignObj.outputs : [];
  for (const out of outputs) {
    const valueAny = out && out.value;
    const value = typeof valueAny === "bigint" ? valueAny : BigInt(String(valueAny || 0));
    pskt = pskt.output({
      value,
      scriptPublicKey: out.scriptPublicKey
    });
  }

  const bundle = new PSKB();
  bundle.add(pskt);

  const arr: any[] = ctx.decodePskbPayloadArray(bundle.serialize());
  if (!Array.isArray(arr) || arr.length !== 1) throw new Error("pskb_array_len_must_be_1");
  const p0: any = arr[0] ?? null;
  const global0: any = p0 && typeof p0 === "object" ? (p0 as any).global : null;
  const input0Out: any = p0 && Array.isArray((p0 as any).inputs) ? (p0 as any).inputs[0] : null;
  if (!global0 || !input0Out) throw new Error("pskb_unexpected_shape");

  global0.inputsModifiable = true;
  global0.outputsModifiable = true;
  input0Out.sighashType = SighashType.SingleAnyOneCanPay;
  input0Out.signatureScript = signatureScriptHex;

  return ctx.encodePskbPayloadArray(arr);
}

function buildOpenSwapSendTxToSignObj(args: {
  listRevealTxid: string;
  p2shSendIndex: number;
  p2shSendSompi: bigint;
  sendP2shAddress: string;
  makerKasReceiveAddress: string;
  makerAskSompi: bigint;
}): any {
  const sendP2shSpkHex = spkToHex(payToAddressScript(args.sendP2shAddress));
  if (!sendP2shSpkHex) throw new Error("send_p2sh_spk_failed");

  const makerKasReceiveSpkHex = spkToHex(payToAddressScript(args.makerKasReceiveAddress));
  if (!makerKasReceiveSpkHex) throw new Error("maker_receive_spk_failed");

  if (args.makerAskSompi <= 0n) throw new Error("maker_ask_sompi_invalid");

  return {
    version: 0,
    lockTime: 0n,
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
    inputs: [
      {
        previousOutpoint: {
          transactionId: args.listRevealTxid,
          index: args.p2shSendIndex
        },
        sequence: 0n,
        sigOpCount: 1,
        utxo: {
          outpoint: {
            transactionId: args.listRevealTxid,
            index: args.p2shSendIndex
          },
          amount: args.p2shSendSompi,
          scriptPublicKey: sendP2shSpkHex,
          blockDaaScore: 0,
          isCoinbase: false
        }
      }
    ],
    outputs: [
      {
        value: args.makerAskSompi,
        scriptPublicKey: makerKasReceiveSpkHex
      }
    ]
  };
}

function buildOpenSwapTermsCommitment(offerTerms: any): string {
  const raw = JSON.stringify(offerTerms);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function registerSwapModeOpenV2Routes(app: Express, ctx: SwapModeOpenV2Ctx): void {
  const {
    repoRoot,
    ensureKaspaReady,
    getSharedRpc,
    kasplexGetAddressTokenList,
    getAppConfig,
    cnRecipientGatesFromPolicy,
    sleepMs,
    decodePskbPayloadArray,
    encodePskbPayloadArray,
    normalizeOpCheckSigSignature64,
    encodePushOnlyP2shSigScript,
    bcwOpenSwapMakerSubmit,
    bcwOpenSwapCancelSubmit,
    validateOpenSwapPskbV2
  } = ctx;

  void kasplexGetAddressTokenList;
  void decodePskbPayloadArray;
  void encodePskbPayloadArray;

  app.get("/api/open-swaps/list", async (req, res) => {
    const userId = String((res.locals as any).td_user_id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const active = readActiveOpenSwapMaker(repoRoot, userId);
    const rawState = typeof (req as any).query?.state === "string" ? (req as any).query.state.trim() : "";
    const rawNetwork = typeof (req as any).query?.network === "string" ? (req as any).query.network.trim() : "";
    const stateFilter = normalizeOpenSwapBoardState(rawState);
    const queryNetwork = normalizeOpenSwapBoardNetwork(rawNetwork);
    const activeNetwork = normalizeOpenSwapBoardNetwork(active?.network);
    const networkFilter = queryNetwork || activeNetwork || "";

    if (rawState && !stateFilter && rawState.toLowerCase() !== "all") {
      return res.status(400).json({ ok: false, reason: "invalid_state" });
    }

    if (rawNetwork && !queryNetwork) {
      return res.status(400).json({ ok: false, reason: "invalid_network" });
    }

    const openSwapSellNameFromRecord = async (item: any): Promise<string> => {
      if (!item || typeof item !== "object") return "";
      if (item.kind !== "ca_to_kas") return "";

      const draft = item.offerDraft && typeof item.offerDraft === "object" ? item.offerDraft : null;
      const draftSell = draft && draft.sell && typeof draft.sell === "object" ? draft.sell : null;
      const draftName = draftSell && typeof draftSell.name === "string" ? draftSell.name.trim() : "";
      if (draftName) return draftName;

      const caRaw = draftSell && typeof draftSell.ca === "string" ? draftSell.ca : item.sellSymbol;
      const caHex = String(caRaw || "").trim().replace(/^CA:/i, "").toLowerCase();
      if (!caHex || !/^[0-9a-f]+$/.test(caHex)) return "";

      const networkKey = normalizeAppNetworkKey(item.networkId);
      if (!networkKey) return "";

      try {
        const entry = getTokenMetadataCacheEntry(repoRoot, networkKey, caHex);
        const name = entry && entry.metadata && entry.metadata.identity && entry.metadata.identity.name
          ? String(entry.metadata.identity.name).trim()
          : "";
        if (name && name !== `CA:${caHex}`) return name;
      } catch {}

      if (!ctx.resolveKrc20TokenMetadata) return "";
      try {
        const metadata = await ctx.resolveKrc20TokenMetadata({
          networkId: networkKey,
          lookup: { kind: "ca", value: caHex },
          options: { timeoutMs: 3000 }
        });
        const name = metadata && metadata.ok === true && metadata.data?.identity?.name
          ? String(metadata.data.identity.name).trim()
          : "";
        return name && name !== `CA:${caHex}` ? name : "";
      } catch {
        return "";
      }
    };

    const items = await Promise.all(listOpenSwapOffers(repoRoot, {
      state: stateFilter || undefined,
      networkId: networkFilter || undefined
    }).map(async (item) => ({
      offerId: item.offerId,
      state: item.state,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      mode: item.mode,
      discovery: item.discovery,
      fillMode: item.fillMode,
      kind: item.kind,
      networkId: item.networkId,
      sellSymbol: item.sellSymbol,
      sellName: await openSwapSellNameFromRecord(item),
      sellAmount: item.sellAmount,
      buyAmountKas: item.buyAmountKas,
      makerWalletId: item.makerWalletId,
      makerWalletType: item.makerWalletType,
      makerKasReceiveAddress: item.makerKasReceiveAddress,
      termsCommitment: item.termsCommitment,
      offerDescription: item.offerDescription || "",
      offerInfoUrl: item.offerInfoUrl || "",
      complianceOnly: !!(item.offerDraft && item.offerDraft.complianceOnly),
      offerBlob: item.offerBlob
    })));

    return res.json({
      ok: true,
      items,
      state: stateFilter || "all",
      networkId: networkFilter || null
    });
  });

  app.get("/api/open-swaps/mine", async (req, res) => {
    try {
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const historyRaw: any = (req as any).query ? (req as any).query.history : undefined;
      const includeHistory = historyRaw === "1" || historyRaw === "true" || historyRaw === "yes";

      const active = readActiveOpenSwapMaker(repoRoot, userId);
      const activeWalletId = typeof active?.id === "string" ? active.id.trim() : "";
      if (!activeWalletId) {
        return res.json({ ok: true, items: [], active_wallet_id: "", history: includeHistory });
      }

      const openSwapSellNameFromRecord = (item: any): string => {
        if (!item || typeof item !== "object") return "";
        if (item.kind !== "ca_to_kas") return "";

        const draft = item.offerDraft && typeof item.offerDraft === "object" ? item.offerDraft : null;
        const draftSell = draft && draft.sell && typeof draft.sell === "object" ? draft.sell : null;
        const draftName = draftSell && typeof draftSell.name === "string" ? draftSell.name.trim() : "";
        if (draftName) return draftName;

        const caRaw = draftSell && typeof draftSell.ca === "string" ? draftSell.ca : item.sellSymbol;
        const caHex = String(caRaw || "").trim().replace(/^CA:/i, "").toLowerCase();
        if (!caHex || !/^[0-9a-f]+$/.test(caHex)) return "";

        const networkKey = normalizeAppNetworkKey(item.networkId);
        if (!networkKey) return "";

        try {
          const entry = getTokenMetadataCacheEntry(repoRoot, networkKey, caHex);
          const name = entry && entry.metadata && entry.metadata.identity && entry.metadata.identity.name
            ? String(entry.metadata.identity.name).trim()
            : "";
          if (name && name !== `CA:${caHex}`) return name;
        } catch {}

        return "";
      };

      const mineRaw = listOpenSwapOffers(repoRoot).filter((item) => {
        if (String(item.makerWalletId || "").trim() !== activeWalletId) return false;
        if (includeHistory) return true;
        return item.state === "open";
      });

      const items = mineRaw.map((item) => ({
        offerId: item.offerId,
        state: item.state,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        mode: item.mode,
        discovery: item.discovery,
        fillMode: item.fillMode,
        kind: item.kind,
        networkId: item.networkId,
        sellSymbol: item.sellSymbol,
        sellName: openSwapSellNameFromRecord(item),
        sellAmount: item.sellAmount,
        buyAmountKas: item.buyAmountKas,
        makerWalletId: item.makerWalletId,
        makerWalletType: item.makerWalletType,
        makerKasReceiveAddress: item.makerKasReceiveAddress,
        termsCommitment: item.termsCommitment,
        offerDescription: item.offerDescription || "",
        offerInfoUrl: item.offerInfoUrl || "",
        complianceOnly: !!(item.offerDraft && item.offerDraft.complianceOnly),
        cancelTxid: item.offerDraft && typeof item.offerDraft.cancelTxid === "string" ? item.offerDraft.cancelTxid : "",
        cancelledAt: item.offerDraft && typeof item.offerDraft.cancelledAt === "string" ? item.offerDraft.cancelledAt : "",
        cancelFailedAt: item.offerDraft && typeof item.offerDraft.cancelFailedAt === "string" ? item.offerDraft.cancelFailedAt : "",
        cancelFailureReason: item.offerDraft && typeof item.offerDraft.cancelFailureReason === "string" ? item.offerDraft.cancelFailureReason : "",
        cancelFailureCount: item.offerDraft && Number.isFinite(Number(item.offerDraft.cancelFailureCount)) ? Number(item.offerDraft.cancelFailureCount) : 0,
        offerBlob: item.offerBlob
      }));

      return res.json({ ok: true, items, active_wallet_id: activeWalletId, history: includeHistory });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "open_swaps_mine_failed", error: String(err) });
    }
  });

  app.post("/api/open-swaps/offer/expire", async (req, res) => {
    let stage = "expire_start";
    let cancelFailureOffer: any = null;

    try {
      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json", stage });
      }

      const requestStage = typeof body.stage === "string" ? body.stage.trim() : "";
      if (requestStage !== "prepare" && requestStage !== "submit") {
        return res.status(400).json({ ok: false, reason: "invalid_stage", stage });
      }

      const offerId = typeof body.offerId === "string" ? body.offerId.trim() : "";
      if (!offerId) {
        return res.status(400).json({ ok: false, reason: "missing_offer_id", stage });
      }

      const active = readActiveOpenSwapMaker(repoRoot, userId);
      const activeWalletId = typeof active?.id === "string" ? active.id.trim() : "";
      if (!activeWalletId) {
        return res.status(409).json({ ok: false, reason: "no_active_wallet", stage });
      }

      const offer = listOpenSwapOffers(repoRoot).find((item) => item.offerId === offerId) ?? null;
      if (!offer) {
        return res.status(404).json({ ok: false, reason: "offer_not_found", stage });
      }
      cancelFailureOffer = offer;

      const makerWalletId = typeof offer.makerWalletId === "string" ? offer.makerWalletId.trim() : "";
      if (makerWalletId !== activeWalletId) {
        return res.status(403).json({ ok: false, reason: "offer_not_owned_by_active_wallet", stage });
      }

      if (offer.state !== "open" && offer.state !== "expired") {
        return res.status(409).json({ ok: false, reason: "offer_not_cancelable", state: offer.state, stage });
      }

      const markCancelFailure = (reason: string): void => {
        const nowIso = new Date().toISOString();
        const currentDraft: any = offer.offerDraft && typeof offer.offerDraft === "object" ? offer.offerDraft : {};
        const previousCount = Number.isFinite(Number(currentDraft.cancelFailureCount)) ? Number(currentDraft.cancelFailureCount) : 0;
        try {
          upsertOpenSwapOffer(repoRoot, Object.assign({}, offer, {
            updatedAt: nowIso,
            offerDraft: Object.assign({}, currentDraft, {
              cancelFailedAt: nowIso,
              cancelFailureReason: reason,
              cancelFailureCount: previousCount + 1
            })
          }));
        } catch {}
      };

      const draft: any = offer.offerDraft && typeof offer.offerDraft === "object" ? offer.offerDraft : null;
      const p2shSendOutpointRaw = draft && draft.p2shSendOutpoint && typeof draft.p2shSendOutpoint === "object" ? draft.p2shSendOutpoint : null;
      const p2shSendOutpoint = {
        txid: typeof p2shSendOutpointRaw?.txid === "string" ? p2shSendOutpointRaw.txid.trim() : "",
        index: Number(p2shSendOutpointRaw?.index ?? -1)
      };
      const p2shSendSompiRaw = typeof draft?.p2shSendSompi === "string" ? draft.p2shSendSompi.trim() : "";
      const sendP2shAddress = typeof draft?.sendP2shAddress === "string" ? draft.sendP2shAddress.trim() : "";
      const sendRedeemScriptHex = typeof draft?.sendRedeemScriptHex === "string" ? draft.sendRedeemScriptHex.trim() : "";
      const makerKasReceiveAddress = typeof offer.makerKasReceiveAddress === "string" ? offer.makerKasReceiveAddress.trim() : "";

      if (!/^[0-9a-f]{64}$/.test(p2shSendOutpoint.txid) || !Number.isInteger(p2shSendOutpoint.index) || p2shSendOutpoint.index < 0) {
        markCancelFailure("p2sh_send_outpoint_missing");
        return res.status(409).json({ ok: false, reason: "p2sh_send_outpoint_missing", stage });
      }
      if (!/^[0-9]+$/.test(p2shSendSompiRaw)) {
        markCancelFailure("p2sh_send_sompi_missing");
        return res.status(409).json({ ok: false, reason: "p2sh_send_sompi_missing", stage });
      }
      if (!sendP2shAddress) {
        markCancelFailure("send_p2sh_address_missing");
        return res.status(409).json({ ok: false, reason: "send_p2sh_address_missing", stage });
      }
      if (!/^[0-9a-f]+$/.test(sendRedeemScriptHex)) {
        markCancelFailure("send_redeem_script_hex_missing");
        return res.status(409).json({ ok: false, reason: "send_redeem_script_hex_missing", stage });
      }
      if (!makerKasReceiveAddress) {
        markCancelFailure("maker_receive_address_missing");
        return res.status(409).json({ ok: false, reason: "maker_receive_address_missing", stage });
      }

      await ensureKaspaReady(repoRoot);
      const networkId = offer.networkId as RpcNetworkId;
      const rpc = await getSharedRpc(networkId);

      if (requestStage === "prepare") {
        stage = "cancel_prepare";
        sweepOpenSwapCancelPrepCache(Date.now());

        const utxos = await rpc.getUtxosByAddresses({ addresses: [sendP2shAddress] });
        const entries: any[] = utxos && Array.isArray((utxos as any).entries) ? (utxos as any).entries : [];
        const sendEntry = entries.find((entry: any) => {
          const op = entry && entry.outpoint ? entry.outpoint : null;
          const txid = typeof op?.transactionId === "string" ? op.transactionId.trim() : "";
          const index = Number(op?.index ?? -1);
          return txid === p2shSendOutpoint.txid && index === p2shSendOutpoint.index;
        });

        if (!sendEntry) {
          markCancelFailure("p2sh_send_utxo_spent_or_missing");
          return res.status(409).json({ ok: false, reason: "p2sh_send_utxo_spent_or_missing", stage });
        }

        const p2shSendSompi = BigInt(p2shSendSompiRaw);
        const buildCancel = async (feeRateToUse: number) => {
          const created = await createTransactions({
            priorityEntries: [sendEntry],
            entries: [],
            changeAddress: makerKasReceiveAddress,
            outputs: [],
            feeRate: feeRateToUse,
            priorityFee: 0n,
            networkId
          });
          const transactions: any[] = created && Array.isArray((created as any).transactions) ? (created as any).transactions : [];
          if (transactions.length !== 1) throw new Error("unexpected_cancel_batch");
          const cancel0 = transactions[0];

          const inputIndex0 = cancel0.transaction.inputs.findIndex((input: any) => {
            const op = input && input.previousOutpoint ? input.previousOutpoint : null;
            const txid = typeof op?.transactionId === "string" ? op.transactionId.trim() : "";
            const index = Number(op?.index ?? -1);
            return txid === p2shSendOutpoint.txid && index === p2shSendOutpoint.index;
          });
          if (inputIndex0 === -1) throw new Error("p2sh_send_input_not_found");
          if (inputIndex0 !== 0) throw new Error("p2sh_send_input_not_input0");

          const dummySig = new Uint8Array(64);
          const dummySigScriptHex = encodePushOnlyP2shSigScript(dummySig, SighashType.SingleAnyOneCanPay, sendRedeemScriptHex);
          cancel0.fillInput(0, dummySigScriptHex);

          const requiredFee = openSwapToccataRequiredFee(networkId, cancel0.transaction, "cancel_tx_mass_exceeds_standard");

          return { cancel0, requiredFee };
        };

        const feeRateFloor = openSwapCancelFeeRateFloor(networkId);
        let cancelFeeRate = feeRateFloor;
        let cancelBuilt = await buildCancel(cancelFeeRate);
        for (let pass = 0; pass < 4 && cancelBuilt.cancel0.feeAmount < cancelBuilt.requiredFee; pass++) {
          const currentFee = cancelBuilt.cancel0.feeAmount > 0n ? cancelBuilt.cancel0.feeAmount : 1n;
          const scale = 1000000n;
          const scaled = (cancelBuilt.requiredFee * scale + currentFee - 1n) / currentFee;
          const feeRateMultiplier = Number(scaled) / 1_000_000;
          const bumpedFeeRate = Math.max(feeRateFloor, cancelFeeRate * feeRateMultiplier * 1.02, cancelFeeRate + 0.000001);
          if (!Number.isFinite(bumpedFeeRate) || bumpedFeeRate <= cancelFeeRate) break;
          cancelFeeRate = bumpedFeeRate;
          cancelBuilt = await buildCancel(cancelFeeRate);
        }
        if (cancelBuilt.cancel0.feeAmount < cancelBuilt.requiredFee) {
          markCancelFailure("cancel_fee_under_minimum");
          return res.status(500).json({
            ok: false,
            reason: "cancel_fee_under_minimum",
            stage,
            feeSompi: cancelBuilt.cancel0.feeAmount.toString(),
            requiredFeeSompi: cancelBuilt.requiredFee.toString(),
            feeRate: cancelFeeRate
          });
        }

        const input0: any = (cancelBuilt.cancel0.transaction as any).inputs?.[0] ?? null;
        const op0: any = input0 && typeof input0 === "object" ? input0.previousOutpoint : null;
        const op0TxidHex = bytesToHex(op0 && (op0 as any).transactionId);
        if (!op0TxidHex) {
          markCancelFailure("cancel_outpoint_txid_invalid");
          return res.status(500).json({ ok: false, reason: "cancel_outpoint_txid_invalid", stage });
        }

        const txToSignObj: any = {
          version: (cancelBuilt.cancel0.transaction as any).version,
          lockTime: (cancelBuilt.cancel0.transaction as any).lockTime,
          subnetworkId: (cancelBuilt.cancel0.transaction as any).subnetworkId,
          gas: (cancelBuilt.cancel0.transaction as any).gas,
          payload: (cancelBuilt.cancel0.transaction as any).payload,
          inputs: [
            {
              previousOutpoint: { transactionId: op0TxidHex, index: Number((op0 as any).index) },
              sequence: (input0 as any).sequence,
              sigOpCount: (input0 as any).sigOpCount,
              utxo: (input0 as any).utxo
            }
          ],
          outputs: Array.isArray((cancelBuilt.cancel0.transaction as any).outputs)
            ? (cancelBuilt.cancel0.transaction as any).outputs.map((out: any) => {
                const spkHex = spkToHex(out && out.scriptPublicKey);
                if (!spkHex) throw new Error("cancel_output_scriptPublicKey_invalid");
                return {
                  value: typeof out?.value === "bigint" ? out.value : BigInt(String(out?.value || 0)),
                  scriptPublicKey: spkHex
                };
              })
            : []
        };

        if (!Array.isArray(txToSignObj.outputs) || txToSignObj.outputs.length !== 1) {
          markCancelFailure("cancel_output_count_invalid");
          return res.status(500).json({ ok: false, reason: "cancel_output_count_invalid", outputCount: txToSignObj.outputs.length, stage });
        }

        const cancelRid = `OCANCEL_${crypto.randomBytes(12).toString("hex")}`;
        const txToSignSafeJson = new Transaction(txToSignObj).serializeToSafeJSON();
        const makerWalletType = typeof offer.makerWalletType === "string" ? offer.makerWalletType.trim() : "";

        if (makerWalletType === "compliance") {
          const activeWalletType = typeof active?.wallet_type === "string" ? active.wallet_type.trim() : "";
          const activeCustodyModel = typeof active?.custody_model === "string" ? active.custody_model.trim() : "";
          const activeBrokerCustodyKeyRef = typeof active?.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
          const activeUserAuthPubkey = typeof active?.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
          const activeAddress = typeof active?.address0 === "string" ? active.address0.trim() : "";
          const activeNetwork = walletNetworkToBcwOpenSwapMakerNetwork(active?.network);

          if (activeWalletType !== "compliance" || activeCustodyModel !== "broker_1of1") {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_cancel_wallet_not_broker_custody", stage });
          }
          if (activeNetwork !== "testnet" || networkId !== "testnet-10") {
            return res.status(403).json({ ok: false, reason: "bcw_local_dev_testnet_only", stage });
          }
          if (!activeBrokerCustodyKeyRef) {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_cancel_key_ref_missing", stage });
          }
          if (!/^(02|03)[0-9a-fA-F]{64}$/.test(activeUserAuthPubkey)) {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_cancel_auth_pubkey_missing", stage });
          }
          if (!activeAddress || activeAddress !== makerKasReceiveAddress) {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_cancel_address_mismatch", stage });
          }

          const createdAt = new Date().toISOString();
          const intent: BcwOpenSwapCancelIntentV1 = {
            v: 1,
            purpose: "bcw_open_swap_cancel",
            wallet_id: activeWalletId,
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: "testnet",
            broker_custody_key_ref: activeBrokerCustodyKeyRef,
            from_address: activeAddress,
            maker_kas_receive_address: makerKasReceiveAddress,
            offer_id: offerId,
            p2sh_send_outpoint_txid: p2shSendOutpoint.txid,
            p2sh_send_outpoint_index: p2shSendOutpoint.index,
            p2sh_send_sompi: p2shSendSompi.toString(),
            send_p2sh_address: sendP2shAddress,
            send_redeem_script_sha256: crypto.createHash("sha256").update(sendRedeemScriptHex, "utf8").digest("hex"),
            tx_safe_json_sha256: crypto.createHash("sha256").update(txToSignSafeJson, "utf8").digest("hex"),
            user_auth_pubkey: activeUserAuthPubkey,
            created_at: createdAt,
            nonce: newBcwOpenSwapCancelNonce()
          };

          const normalizedIntent = normalizeBcwOpenSwapCancelIntent(intent);
          if (!normalizedIntent) {
            return res.status(500).json({ ok: false, reason: "bcw_open_swap_cancel_intent_build_failed", stage });
          }

          const intentMessage = canonicalBcwOpenSwapCancelIntentMessage(normalizedIntent);
          openSwapCancelPrepCache.set(cancelRid, {
            createdAtMs: Date.now(),
            userId,
            walletId: activeWalletId,
            offerId,
            networkId,
            walletType: "compliance",
            txToSignSafeJson,
            sendRedeemScriptHex,
            bcwOpenSwapCancelIntent: normalizedIntent,
            intentMessage
          });

          return res.json({
            ok: true,
            stage: "bcw_open_swap_cancel_intent",
            cancelRid,
            offerId,
            bcw_open_swap_cancel_intent: normalizedIntent,
            intent_message: intentMessage,
            sign_mode: "bcw_auth",
            p2shSendOutpoint,
            p2shSendSompi: p2shSendSompi.toString(),
            sendP2shAddress,
            makerKasReceiveAddress,
            outputCount: txToSignObj.outputs.length
          });
        }

        openSwapCancelPrepCache.set(cancelRid, {
          createdAtMs: Date.now(),
          userId,
          walletId: activeWalletId,
          offerId,
          networkId,
          walletType: "standard",
          txToSignSafeJson,
          sendRedeemScriptHex
        });

        return res.json({
          ok: true,
          stage: "cancel_prepare",
          cancelRid,
          offerId,
          txToSignSafeJson,
          sighashType: "SingleAnyOneCanPay",
          p2shSendOutpoint,
          p2shSendSompi: p2shSendSompi.toString(),
          sendP2shAddress,
          makerKasReceiveAddress,
          outputCount: txToSignObj.outputs.length
        });
      }

      stage = "cancel_submit";
      const cancelRid = typeof body.cancelRid === "string" ? body.cancelRid.trim() : "";
      const signature0 = typeof body.signature0 === "string" ? body.signature0.trim() : "";
      if (!cancelRid) {
        return res.status(400).json({ ok: false, reason: "missing_cancelRid", stage });
      }
      if (!signature0) {
        return res.status(400).json({ ok: false, reason: "missing_signature0", stage });
      }

      const cached = openSwapCancelPrepCache.get(cancelRid) ?? null;
      if (!cached || cached.userId !== userId || cached.walletId !== activeWalletId || cached.offerId !== offerId) {
        return res.status(409).json({ ok: false, reason: "cancelRid_not_prepared", stage });
      }
      if (cached.walletType === "compliance") {
        if (!cached.bcwOpenSwapCancelIntent) {
          markCancelFailure("bcw_open_swap_cancel_intent_missing");
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_cancel_intent_missing", stage });
        }
        if (!bcwOpenSwapCancelSubmit) {
          markCancelFailure("bcw_open_swap_cancel_submit_not_configured");
          return res.status(501).json({ ok: false, reason: "bcw_open_swap_cancel_submit_not_configured", stage });
        }

        const cnRes = await bcwOpenSwapCancelSubmit({
          repoRootPath: repoRoot,
          intent: cached.bcwOpenSwapCancelIntent,
          authSignature: signature0,
          txSafeJson: cached.txToSignSafeJson,
          sendRedeemScriptHex: cached.sendRedeemScriptHex
        });

        if (!cnRes.ok) {
          const reason =
            cnRes.data && typeof cnRes.data.reason === "string" && cnRes.data.reason.trim()
              ? cnRes.data.reason.trim()
              : "bcw_open_swap_cancel_submit_failed";
          markCancelFailure(reason);
          return res.status(cnRes.status || 502).json(Object.assign({ ok: false, stage }, cnRes.data || { reason }));
        }

        const cancelTxid =
          cnRes.data && typeof cnRes.data.cancelTxid === "string" ? cnRes.data.cancelTxid.trim() : "";
        if (!/^[0-9a-f]{64}$/i.test(cancelTxid)) {
          markCancelFailure("bcw_cancel_submit_missing_txid");
          return res.status(502).json({ ok: false, reason: "bcw_cancel_submit_missing_txid", stage });
        }

        openSwapCancelPrepCache.delete(cancelRid);
        const nowIso = new Date().toISOString();
        const cancelled = upsertOpenSwapOffer(repoRoot, Object.assign({}, offer, {
          state: "cancelled",
          expiresAt: nowIso,
          updatedAt: nowIso,
          offerDraft: Object.assign({}, offer.offerDraft || {}, {
            cancelTxid,
            cancelledAt: nowIso
          })
        }));

        return res.json({
          ok: true,
          stage: "bcw_cancel_submit",
          offerId: cancelled.offerId,
          state: cancelled.state,
          expiresAt: cancelled.expiresAt,
          cancelTxid,
          cancelledAt: nowIso
        });
      }

      const sendSig0 = normalizeOpCheckSigSignature64(signature0, "open_swap_cancel.signature0");
      const sigScriptHex0 = encodePushOnlyP2shSigScript(sendSig0, SighashType.SingleAnyOneCanPay, cached.sendRedeemScriptHex);
      const txToSubmit = Transaction.deserializeFromSafeJSON(cached.txToSignSafeJson);
      const txInputs: any[] = Array.isArray(txToSubmit.inputs) ? txToSubmit.inputs : [];
      if (!txInputs[0]) {
        markCancelFailure("cancel_tx_missing_input0");
        return res.status(500).json({ ok: false, reason: "cancel_tx_missing_input0", stage });
      }
      txInputs[0].signatureScript = sigScriptHex0;
      txToSubmit.inputs = txInputs;
      txToSubmit.finalize();

      const outputs: any[] = Array.isArray(txToSubmit.outputs) ? txToSubmit.outputs : [];
      if (outputs.length !== 1) {
        markCancelFailure("cancel_output_count_invalid");
        return res.status(500).json({ ok: false, reason: "cancel_output_count_invalid", outputCount: outputs.length, stage });
      }

      const submitRes = await rpc.submitTransaction({ transaction: txToSubmit, allowOrphan: false });
      const cancelTxid = submitRes && typeof (submitRes as any).transactionId === "string" ? String((submitRes as any).transactionId) : "";
      if (!cancelTxid) {
        markCancelFailure("cancel_submit_missing_txid");
        return res.status(502).json({ ok: false, reason: "cancel_submit_missing_txid", stage });
      }

      openSwapCancelPrepCache.delete(cancelRid);
      const nowIso = new Date().toISOString();
      const cancelled = upsertOpenSwapOffer(repoRoot, Object.assign({}, offer, {
        state: "cancelled",
        expiresAt: nowIso,
        updatedAt: nowIso,
        offerDraft: Object.assign({}, offer.offerDraft || {}, {
          cancelTxid,
          cancelledAt: nowIso
        })
      }));

      return res.json({
        ok: true,
        stage: "cancel_submit",
        offerId: cancelled.offerId,
        state: cancelled.state,
        expiresAt: cancelled.expiresAt,
        cancelTxid,
        active_wallet_id: activeWalletId
      });
    } catch (err) {
      const errorText = String(err && typeof (err as any).message === "string" ? (err as any).message : err);
      try {
        if (cancelFailureOffer && (stage === "cancel_prepare" || stage === "cancel_submit")) {
          const nowIso = new Date().toISOString();
          const currentDraft: any = cancelFailureOffer.offerDraft && typeof cancelFailureOffer.offerDraft === "object" ? cancelFailureOffer.offerDraft : {};
          const previousCount = Number.isFinite(Number(currentDraft.cancelFailureCount)) ? Number(currentDraft.cancelFailureCount) : 0;
          upsertOpenSwapOffer(repoRoot, Object.assign({}, cancelFailureOffer, {
            updatedAt: nowIso,
            offerDraft: Object.assign({}, currentDraft, {
              cancelFailedAt: nowIso,
              cancelFailureReason: errorText.slice(0, 240),
              cancelFailureCount: previousCount + 1
            })
          }));
        }
      } catch {}
      return res.status(500).json({ ok: false, reason: "open_swap_offer_cancel_failed", stage, error: errorText });
    }
  });

  app.post("/api/open-swaps/analyze", async (req, res) => {
    const userId = String((res.locals as any).td_user_id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }

    const body: any = (req as any).body ?? null;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ ok: false, reason: "invalid_json", blockers: ["invalid_json"], notes: [] });
    }

    const active = readActiveOpenSwapMaker(repoRoot, userId);
    if (!active) {
      return res.status(400).json({ ok: false, reason: "active_wallet_missing", blockers: ["active_wallet_missing"], notes: [] });
    }

    const out = analyzeOpenSwapRequest(body, active);
    return res.json({
      ok: out.blockers.length === 0,
      blockers: out.blockers,
      notes: out.notes,
      normalized: out.normalized
    });
  });

  app.post("/api/open-swaps/offer", async (req, res) => {
    let stage = "load_request";

    try {
      sweepOpenSwapOfferPrepCache(Date.now());

      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, reason: "invalid_json" });
      }

      const reqStage = typeof body.stage === "string" ? body.stage.trim() : "";
      const offerRid = typeof body.offerRid === "string" ? body.offerRid.trim() : "";
      const isPrepare = reqStage === "prepare";
      const isCommitSubmit = reqStage === "commit_submit";
      const isRevealSubmit = reqStage === "reveal_submit";
      const isSendSubmit = reqStage === "send_submit";
      const isBcwMakerSubmit = reqStage === "bcw_maker_submit";

      if (!isPrepare && !isCommitSubmit && !isRevealSubmit && !isSendSubmit && !isBcwMakerSubmit) {
        return res.status(400).json({
          ok: false,
          reason: "invalid_stage",
          allowedStages: ["prepare", "commit_submit", "reveal_submit", "send_submit", "bcw_maker_submit"]
        });
      }

      if (!isPrepare && !isBcwMakerSubmit && !offerRid) {
        return res.status(400).json({ ok: false, reason: "missing_offerRid" });
      }

      if (isPrepare && offerRid) {
        return res.status(400).json({ ok: false, reason: "offerRid_not_allowed_on_prepare" });
      }

      if (isBcwMakerSubmit && offerRid) {
        return res.status(400).json({ ok: false, reason: "offerRid_not_allowed_on_bcw_maker_submit" });
      }

      if (isPrepare) {
        stage = "load_wallet";
        const active = readActiveOpenSwapMaker(repoRoot, userId);
        if (!active) {
          return res.status(400).json({ ok: false, reason: "active_wallet_missing" });
        }

        const out = analyzeOpenSwapRequest(body, active);
        if (out.blockers.length) {
          return res.status(400).json({
            ok: false,
            reason: "invalid_offer_request",
            blockers: out.blockers,
            notes: out.notes,
            normalized: out.normalized
          });
        }

        stage = "kaspa_ready";
        await ensureKaspaReady(repoRoot);

        const normalized = out.normalized;
        const appNetworkKey = normalizeAppNetworkKey(active.network);
        if (!appNetworkKey) {
          return res.status(409).json({ ok: false, reason: "wallet_network_invalid" });
        }

        const networkId = rpcNetworkIdFromAppNetworkKey(appNetworkKey);
        const expectedPrefix = `${addressPrefixFromAppNetworkKey(appNetworkKey)}:`;
        if (!String(normalized.maker.kasReceiveAddress || "").startsWith(expectedPrefix)) {
          return res.status(400).json({ ok: false, reason: "invalid_makerReceiveAddress_network" });
        }

        stage = "rpc_ready";
        const rpc = await getSharedRpc(networkId);
        const fee = await rpc.getFeeEstimate();
        const feeRate =
          fee &&
          fee.estimate &&
          Array.isArray(fee.estimate.normalBuckets) &&
          fee.estimate.normalBuckets.length > 0 &&
          typeof fee.estimate.normalBuckets[0].feerate === "number"
            ? fee.estimate.normalBuckets[0].feerate
            : 0;
        if (!feeRate || feeRate <= 0) {
          return res.status(502).json({ ok: false, reason: "fee_rate_unavailable" });
        }

        const cfg = getAppConfig(repoRoot);
        const feeRateMin = cfg && typeof cfg.fee_rate_min === "number" && Number.isFinite(cfg.fee_rate_min) ? cfg.fee_rate_min : 0;
        const configuredFeeRate = feeRate < feeRateMin ? feeRateMin : feeRate;
        const effectiveFeeRate = applyKrc20ToccataFeeRateFloor(appNetworkKey, configuredFeeRate);

        stage = "resolve_sell_meta";
        let sellMeta: any;
        try {
          sellMeta = await resolveOpenSwapSellMeta(ctx, normalized, active);
        } catch (e: any) {
          const reason = e instanceof Error ? e.message : String(e);
          const status = reason === "invalid_amt_precision" ? 400 : 409;
          return res.status(status).json({
            ok: false,
            reason,
            blockers: [reason],
            notes: out.notes,
            normalized
          });
        }

        if (normalized.maker.walletType === "compliance" && normalized.maker.custodyModel === "broker_1of1") {
          stage = "bcw_prepare_intent";
          const bcwNetwork = walletNetworkToBcwOpenSwapMakerNetwork(active.network);
          if (!bcwNetwork) {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_network_invalid" });
          }

          const makerAskSompi = kaspaToSompi(String(normalized?.buy?.amount || ""));
          if (makerAskSompi === undefined || makerAskSompi <= 0n) {
            return res.status(400).json({ ok: false, reason: "bcw_open_swap_maker_buy_amount_invalid" });
          }

          const createdAtMs = Date.now();
          const createdAt = new Date(createdAtMs).toISOString();
          const ttlSeconds = Number(normalized.ttl || 0);
          const expiresAt = ttlSeconds > 0 ? new Date(createdAtMs + ttlSeconds * 1000).toISOString() : "";
          const intent: BcwOpenSwapMakerIntentV1 = {
            v: 1,
            purpose: "bcw_open_swap_maker",
            wallet_id: String(normalized.maker.walletId || "").trim(),
            wallet_type: "compliance",
            custody_model: "broker_1of1",
            network: bcwNetwork,
            broker_custody_key_ref: String(normalized.maker.brokerCustodyKeyRef || "").trim(),
            from_address: String(normalized.maker.kasReceiveAddress || "").trim(),
            maker_kas_receive_address: String(normalized.maker.kasReceiveAddress || "").trim(),
            kind: normalized.kind === "ca_to_kas" ? "ca_to_kas" : "tick_to_kas",
            tick: normalized.kind === "ca_to_kas" ? "" : String(normalized.sell.ticker || "").trim().toUpperCase(),
            ca: normalized.kind === "ca_to_kas" ? String(normalized.sell.ca || "").trim().toLowerCase() : "",
            sell_amount_raw: String(sellMeta.baseAmountStr),
            buy_amount_sompi: makerAskSompi.toString(),
            ttl_seconds: ttlSeconds,
            user_auth_pubkey: String(normalized.maker.userAuthPubkey || "").trim(),
            created_at: createdAt,
            expires_at: expiresAt,
            nonce: newBcwOpenSwapMakerNonce()
          };

          const normalizedIntent = normalizeBcwOpenSwapMakerIntent(intent);
          if (!normalizedIntent) {
            return res.status(500).json({ ok: false, reason: "bcw_open_swap_maker_intent_build_failed" });
          }

          const intentMessage = canonicalBcwOpenSwapMakerIntentMessage(normalizedIntent);
          return res.json({
            ok: true,
            stage: "bcw_open_swap_maker_intent",
            notes: [...out.notes, "bcw_open_swap_maker_auth_required"],
            normalized,
            bcw_open_swap_maker_intent: normalizedIntent,
            intent_message: intentMessage,
            sign_mode: "bcw_auth"
          });
        }

        stage = "build_scripts";
        const userPub = new PublicKey(String(active.user_pubkey || "").trim());
        const userPubXOnly = userPub.toXOnlyPublicKey().toString();

        const makerListPayload =
          normalized.kind === "ca_to_kas"
            ? {
                p: "krc-20",
                op: "list",
                ca: String(normalized.sell.ca || "").trim().toLowerCase(),
                amt: String(sellMeta.baseAmountStr)
              }
            : {
                p: "krc-20",
                op: "list",
                tick: String(normalized.sell.ticker || "").trim().toUpperCase(),
                amt: String(sellMeta.baseAmountStr)
              };

        const sendKind: "tick_to_kas" | "ca_to_kas" = normalized.kind === "ca_to_kas" ? "ca_to_kas" : "tick_to_kas";
        const makerSendJson = buildCanonicalOpenSwapSendJson(sendKind, normalized.sell);
        if (!makerSendJson) {
          return res.status(500).json({ ok: false, reason: "maker_send_payload_invalid" });
        }
        const makerSendPayload = JSON.parse(makerSendJson);

        const listScript = new ScriptBuilder()
          .addData(userPubXOnly)
          .addOp(Opcodes.OpCheckSig)
          .addOp(Opcodes.OpFalse)
          .addOp(Opcodes.OpIf)
          .addData(Buffer.from("kasplex"))
          .addI64(0n)
          .addData(Buffer.from(JSON.stringify(makerListPayload)))
          .addOp(Opcodes.OpEndIf);

        const listRedeemScriptHex = listScript.toString();
        const listP2shAddressObj = addressFromScriptPublicKey(listScript.createPayToScriptHashScript(), networkId);
        const listP2shAddress = listP2shAddressObj ? listP2shAddressObj.toString() : "";
        if (!listP2shAddress) {
          return res.status(500).json({ ok: false, reason: "p2sh_list_address_failed" });
        }

        const sendScript = new ScriptBuilder()
          .addData(userPubXOnly)
          .addOp(Opcodes.OpCheckSig)
          .addOp(Opcodes.OpFalse)
          .addOp(Opcodes.OpIf)
          .addData(Buffer.from("kasplex"))
          .addI64(0n)
          .addData(Buffer.from(makerSendJson))
          .addOp(Opcodes.OpEndIf);

        const sendRedeemScriptHex = sendScript.toString();
        const sendP2shAddressObj = addressFromScriptPublicKey(sendScript.createPayToScriptHashScript(), networkId);
        const sendP2shAddress = sendP2shAddressObj ? sendP2shAddressObj.toString() : "";
        if (!sendP2shAddress) {
          return res.status(500).json({ ok: false, reason: "p2sh_send_address_failed" });
        }

        stage = "commit_build";
        const commitAmountSompi = kaspaToSompi("0.3");
        if (commitAmountSompi === undefined || commitAmountSompi <= 0n) {
          return res.status(500).json({ ok: false, reason: "invalid_commit_amount" });
        }

        const ownerUtxos = await rpc.getUtxosByAddresses({ addresses: [String(active.address0 || "").trim()] });
        const ownerEntries = ownerUtxos && Array.isArray((ownerUtxos as any).entries) ? (ownerUtxos as any).entries : [];
        if (!ownerEntries.length) {
          return res.status(409).json({ ok: false, reason: "no_utxos" });
        }

        const commitFunding = await selectOpenSwapCommitFundingEntries({
          ownerEntries,
          commitAmountSompi,
          listP2shAddress,
          changeAddress: String(active.address0 || "").trim(),
          effectiveFeeRate,
          networkId
        });
        if (!commitFunding.ok) {
          return res.status(409).json({
            ok: false,
            reason: commitFunding.reason,
            stage,
            detail: commitFunding.detail,
            neededSompi: commitFunding.neededSompi,
            neededKas: commitFunding.neededKas,
            recommendedSelfSendSompi: commitFunding.recommendedSelfSendSompi,
            recommendedSelfSendKas: commitFunding.recommendedSelfSendKas,
            totalAvailableSompi: commitFunding.totalAvailableSompi,
            totalAvailableKas: commitFunding.totalAvailableKas,
            largestUtxoSompi: commitFunding.largestUtxoSompi,
            largestUtxoKas: commitFunding.largestUtxoKas,
            utxoCount: commitFunding.utxoCount,
            validUtxoCount: commitFunding.validUtxoCount,
            candidateInputLimit: commitFunding.candidateInputLimit,
            candidateAttempts: commitFunding.candidateAttempts,
            lastSelectionError: commitFunding.lastSelectionError
          });
        }

        const commitCreated = commitFunding.created;
        const commitPtxs: any[] = commitCreated && Array.isArray((commitCreated as any).transactions) ? (commitCreated as any).transactions : [];
        if (!commitPtxs.length) {
          return res.status(500).json({ ok: false, reason: "unexpected_commit_batch" });
        }

        const rid = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
        const createdAtMs = Date.now();
        const createdAt = new Date(createdAtMs).toISOString();
        const ttlSeconds = Number(normalized.ttl || 0);
        const expiresAt = ttlSeconds > 0 ? new Date(createdAtMs + ttlSeconds * 1000).toISOString() : "";
        const complianceOnly = (() => {
          if (normalized.kind !== "ca_to_kas") return false;
          const ca = typeof normalized?.sell?.ca === "string" ? normalized.sell.ca.trim().toLowerCase() : "";
          if (!/^[0-9a-f]{64}$/.test(ca)) return false;
          if (!cnRecipientGatesFromPolicy) return false;
          try {
            const gates = cnRecipientGatesFromPolicy(cfg);
            return Array.isArray(gates.regulated_cas) && gates.regulated_cas.includes(ca);
          } catch {
            return false;
          }
        })();

        const sellDisplayName = normalized.kind === "ca_to_kas"
          ? String((sellMeta && sellMeta.sellName) || normalized.sell?.name || "").trim().slice(0, 128)
          : "";
        const sellForDisplay = sellDisplayName ? { ...normalized.sell, name: sellDisplayName } : normalized.sell;
        const normalizedForDisplay = sellForDisplay === normalized.sell ? normalized : { ...normalized, sell: sellForDisplay };

        const offerTermsForHash = {
          version: 1,
          mode: "open_swap_v2",
          discovery: "manual_import",
          fillMode: "full_fill_only",
          protocol: { makerOp: "list", takerOp: "send" },
          kind: normalized.kind,
          maker: {
            walletId: normalized.maker.walletId,
            walletType: normalized.maker.walletType,
            networkId: normalized.maker.networkId,
            kasReceiveAddress: normalized.maker.kasReceiveAddress,
            userPubkey: normalized.maker.userPubkey
          },
          sell: normalized.sell,
          buy: normalized.buy,
          ttl: normalized.ttl,
          partial: normalized.partial,
          complianceOnly,
          makerListPayload,
          makerSendPayload,
          sendP2shAddress,
          sendRedeemScriptHex
        };

        const offerDraftBase = {
          version: 1,
          mode: "open_swap_v2",
          discovery: "manual_import",
          fillMode: "full_fill_only",
          protocol: {
            makerOp: "list",
            takerOp: "send"
          },
          kind: normalized.kind,
          maker: normalized.maker,
          sell: sellForDisplay,
          buy: normalized.buy,
          ttl: normalized.ttl,
          partial: normalized.partial,
          complianceOnly,
          offerDescription: normalized.offerDescription,
          offerInfoUrl: normalized.offerInfoUrl,
          createdAt,
          expiresAt,
          makerListPayload,
          makerSendPayload,
          sendP2shAddress,
          sendRedeemScriptHex
        };

        openSwapOfferPrepCache.set(rid, {
          createdAtMs,
          userId,
          walletId: String(active.id || "").trim(),
          networkId,
          feeRate: effectiveFeeRate,
          makerAddress0: String(active.address0 || "").trim(),
          makerUserPubkey: String(active.user_pubkey || "").trim(),
          normalized: normalizedForDisplay,
          offerDraftBase,
          offerTermsForHash,
          listRedeemScriptHex,
          listP2shAddress,
          sendRedeemScriptHex,
          sendP2shAddress,
          makerListPayload,
          makerSendPayload,
          commitPtxs
        });

        const unsignedCommit = commitPtxs.map((ptx: any) => ({
          tx: ptx.serializeToSafeJSON(),
          inputCount: Array.isArray(ptx.getUtxoEntries?.()) ? ptx.getUtxoEntries().length : 0
        }));

        return res.json({
          ok: true,
          stage: "prepare",
          notes: [...out.notes, "cb2c_prepare_commit_signing_required"],
          normalized: normalizedForDisplay,
          offerRid: rid,
          offerDraft: offerDraftBase,
          offerBlob: JSON.stringify(offerDraftBase),
          unsignedCommit,
          sign_mode: "standard"
        });
      }

      if (isBcwMakerSubmit) {
        stage = "bcw_maker_submit";
        if (!bcwOpenSwapMakerSubmit) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_maker_submit_unavailable", stage });
        }

        const intent = normalizeBcwOpenSwapMakerIntent(body.bcw_open_swap_maker_intent);
        const authSignature = typeof body.bcw_auth_signature === "string" ? body.bcw_auth_signature.trim() : "";

        if (!intent) {
          return res.status(400).json({ ok: false, reason: "bcw_open_swap_maker_intent_invalid", stage });
        }
        if (!authSignature) {
          return res.status(400).json({ ok: false, reason: "bcw_auth_signature_required", stage });
        }

        const active = readActiveOpenSwapMaker(repoRoot, userId);
        if (!active) {
          return res.status(400).json({ ok: false, reason: "active_wallet_missing", stage });
        }

        const activeWalletId = typeof active?.id === "string" ? active.id.trim() : "";
        const activeWalletType = typeof active?.wallet_type === "string" ? active.wallet_type.trim() : "";
        const activeCustodyModel = typeof active?.custody_model === "string" ? active.custody_model.trim() : "";
        const activeBrokerCustodyKeyRef = typeof active?.broker_custody_key_ref === "string" ? active.broker_custody_key_ref.trim() : "";
        const activeUserAuthPubkey = typeof active?.user_auth_pubkey === "string" ? active.user_auth_pubkey.trim() : "";
        const activeAddress = typeof active?.address0 === "string" ? active.address0.trim() : "";
        const activeNetwork = walletNetworkToBcwOpenSwapMakerNetwork(active?.network);

        if (activeWalletId !== intent.wallet_id) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_wallet_mismatch", stage });
        }
        if (activeWalletType !== "compliance" || activeCustodyModel !== "broker_1of1") {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_wallet_not_broker_custody", stage });
        }
        if (activeNetwork !== intent.network) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_network_mismatch", stage });
        }
        if (activeBrokerCustodyKeyRef !== intent.broker_custody_key_ref) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_key_ref_mismatch", stage });
        }
        if (activeUserAuthPubkey !== intent.user_auth_pubkey) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_auth_pubkey_mismatch", stage });
        }
        if (activeAddress !== intent.from_address || activeAddress !== intent.maker_kas_receive_address) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_address_mismatch", stage });
        }

        const expectedIntentMessage = canonicalBcwOpenSwapMakerIntentMessage(intent);
        const submittedIntentMessage = typeof body.intent_message === "string" ? body.intent_message.trim() : "";
        if (submittedIntentMessage && submittedIntentMessage !== expectedIntentMessage) {
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_intent_message_mismatch", stage });
        }

        const replay = analyzeOpenSwapRequest(body, active);
        if (replay.blockers.length) {
          return res.status(400).json({
            ok: false,
            reason: "bcw_open_swap_maker_request_replay_invalid",
            blockers: replay.blockers,
            stage
          });
        }

        let sellAmountDisplay = "";
        try {
          const replaySellMeta = await resolveOpenSwapSellMeta(ctx, replay.normalized, active);
          if (String(replaySellMeta.baseAmountStr || "") !== intent.sell_amount_raw) {
            return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_sell_amount_mismatch", stage });
          }
          sellAmountDisplay = String(replay.normalized?.sell?.amount || "").trim();
        } catch (e: any) {
          const reason = e instanceof Error ? e.message : String(e);
          return res.status(409).json({ ok: false, reason: "bcw_open_swap_maker_sell_amount_replay_failed", detail: reason, stage });
        }

        if (!sellAmountDisplay) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_maker_sell_amount_display_missing", stage });
        }

        const cnRes = await bcwOpenSwapMakerSubmit({
          repoRootPath: repoRoot,
          intent,
          authSignature
        });

        if (!cnRes.ok) {
          return res.status(cnRes.status || 502).json({
            ok: false,
            reason: "bcw_open_swap_maker_cn_rejected",
            stage,
            cn: cnRes.data
          });
        }

        const cn = cnRes.data && typeof cnRes.data === "object" ? cnRes.data : null;
        const makerListPskb = typeof cn?.makerListPskb === "string" ? cn.makerListPskb.trim() : "";
        const makerSendPskb = typeof cn?.makerSendPskb === "string" ? cn.makerSendPskb.trim() : "";
        const listRevealTxid = typeof cn?.listRevealTxid === "string" ? cn.listRevealTxid.trim() : "";
        const sendP2shAddress = typeof cn?.sendP2shAddress === "string" ? cn.sendP2shAddress.trim() : "";
        const sendRedeemScriptHex = typeof cn?.sendRedeemScriptHex === "string" ? cn.sendRedeemScriptHex.trim() : "";
        const p2shSendSompi = typeof cn?.p2shSendSompi === "string" ? cn.p2shSendSompi.trim() : "";
        const rawOutpoint = cn && typeof cn.p2shSendOutpoint === "object" ? cn.p2shSendOutpoint : null;
        const p2shSendOutpoint = {
          txid: typeof rawOutpoint?.txid === "string" ? rawOutpoint.txid.trim() : "",
          index: typeof rawOutpoint?.index === "number" ? rawOutpoint.index : -1
        };

        if (!makerListPskb || !makerSendPskb || !listRevealTxid || !sendP2shAddress || !sendRedeemScriptHex) {
          return res.status(502).json({ ok: false, reason: "bcw_open_swap_maker_cn_artifacts_missing", stage, cn });
        }
        if (p2shSendOutpoint.txid !== listRevealTxid || p2shSendOutpoint.index < 0 || !p2shSendSompi) {
          return res.status(502).json({ ok: false, reason: "bcw_open_swap_maker_cn_outpoint_invalid", stage, cn });
        }

        const kind: "tick_to_kas" | "ca_to_kas" = intent.kind === "ca_to_kas" ? "ca_to_kas" : "tick_to_kas";
        const listValidation = await validateOpenSwapPskbV2(repoRoot, {
          phase: "offer",
          kind,
          pskb: makerListPskb
        });
        if (!listValidation.ok) {
          return res.status(502).json({
            ok: false,
            reason: "bcw_open_swap_maker_list_pskb_invalid",
            stage,
            errors: listValidation.errors,
            warnings: listValidation.warnings
          });
        }

        const expectedSendJsonHex = buildCanonicalOpenSwapSendJsonHex(kind, { ticker: intent.tick, ca: intent.ca });
        if (!expectedSendJsonHex) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_maker_send_payload_invalid", stage });
        }

        const sendValidation = await validateOpenSwapPskbV2(repoRoot, {
          phase: "accept",
          kind,
          pskb: makerSendPskb,
          expectedSendJsonHex
        });
        if (!sendValidation.ok) {
          return res.status(502).json({
            ok: false,
            reason: "bcw_open_swap_maker_send_pskb_invalid",
            stage,
            errors: sendValidation.errors,
            warnings: sendValidation.warnings
          });
        }

        const buyAmountKas = formatBcwOpenSwapMakerKasFromSompi(intent.buy_amount_sompi);
        if (!buyAmountKas) {
          return res.status(500).json({ ok: false, reason: "bcw_open_swap_maker_buy_amount_format_failed", stage });
        }

        const networkId: RpcNetworkId = intent.network === "testnet" ? "testnet-10" : "mainnet";
        const sellSymbol = kind === "ca_to_kas" ? intent.ca : intent.tick;
        const normalized = {
          kind,
          maker: {
            walletId: intent.wallet_id,
            walletType: "compliance",
            custodyModel: "broker_1of1",
            networkId,
            kasReceiveAddress: intent.maker_kas_receive_address,
            userPubkey: "",
            brokerCustodyKeyRef: intent.broker_custody_key_ref,
            userAuthPubkey: intent.user_auth_pubkey
          },
          sell: {
            type: "KRC20",
            kind: kind === "ca_to_kas" ? "CA" : "TICK",
            symbol: sellSymbol,
            ticker: kind === "ca_to_kas" ? null : intent.tick,
            ca: kind === "ca_to_kas" ? intent.ca : null,
            amount: sellAmountDisplay
          },
          buy: {
            type: "KAS",
            symbol: "KAS",
            amount: buyAmountKas
          },
          offerDescription: String(replay.normalized?.offerDescription || ""),
          offerInfoUrl: String(replay.normalized?.offerInfoUrl || ""),
          openOfferBatch: replay.normalized?.openOfferBatch || null,
          ttl: intent.ttl_seconds,
          partial: { enabled: false }
        };

        const listPayloadJson = typeof cn?.listPayloadJson === "string" ? cn.listPayloadJson.trim() : "";
        const sendPayloadJson = typeof cn?.sendPayloadJson === "string" ? cn.sendPayloadJson.trim() : "";
        const makerListPayload = listPayloadJson ? JSON.parse(listPayloadJson) : null;
        const makerSendPayload = sendPayloadJson ? JSON.parse(sendPayloadJson) : null;
        if (!makerListPayload || !makerSendPayload) {
          return res.status(502).json({ ok: false, reason: "bcw_open_swap_maker_payloads_missing", stage, cn });
        }

        const cfg = getAppConfig(repoRoot);
        const complianceOnly = (() => {
          if (kind !== "ca_to_kas") return false;
          if (!cnRecipientGatesFromPolicy) return false;
          try {
            const gates = cnRecipientGatesFromPolicy(cfg);
            return Array.isArray(gates.regulated_cas) && gates.regulated_cas.includes(intent.ca);
          } catch {
            return false;
          }
        })();

        const createdAt = typeof intent.created_at === "string" ? intent.created_at : new Date().toISOString();
        const expiresAt = typeof intent.expires_at === "string" ? intent.expires_at : "";
        const bcwSellName = (() => {
          if (kind !== "ca_to_kas") return "";
          const networkKey = normalizeAppNetworkKey(networkId);
          if (!networkKey || !intent.ca) return "";
          try {
            const entry = getTokenMetadataCacheEntry(repoRoot, networkKey, intent.ca);
            const name = entry && entry.metadata && entry.metadata.identity && entry.metadata.identity.name
              ? String(entry.metadata.identity.name).trim()
              : "";
            return name && name !== `CA:${intent.ca}` ? name.slice(0, 128) : "";
          } catch {
            return "";
          }
        })();
        const bcwSellForDisplay = bcwSellName ? { ...normalized.sell, name: bcwSellName } : normalized.sell;

        const offerTermsForHash = {
          version: 1,
          mode: "open_swap_v2",
          discovery: "manual_import",
          fillMode: "full_fill_only",
          protocol: { makerOp: "list", takerOp: "send" },
          kind,
          maker: {
            walletId: intent.wallet_id,
            walletType: "compliance",
            custodyModel: "broker_1of1",
            networkId,
            kasReceiveAddress: intent.maker_kas_receive_address,
            brokerCustodyKeyRef: intent.broker_custody_key_ref,
            userAuthPubkey: intent.user_auth_pubkey
          },
          sell: normalized.sell,
          buy: normalized.buy,
          ttl: intent.ttl_seconds,
          partial: { enabled: false },
          complianceOnly,
          makerListPayload,
          makerSendPayload,
          sendP2shAddress,
          sendRedeemScriptHex
        };

        const termsCommitment = buildOpenSwapTermsCommitment(offerTermsForHash);
        const finalOfferDraft = {
          version: 1,
          mode: "open_swap_v2",
          discovery: "manual_import",
          fillMode: "full_fill_only",
          protocol: { makerOp: "list", takerOp: "send" },
          kind,
          maker: normalized.maker,
          sell: bcwSellForDisplay,
          buy: normalized.buy,
          ttl: intent.ttl_seconds,
          partial: { enabled: false },
          complianceOnly,
          offerDescription: normalized.offerDescription,
          offerInfoUrl: normalized.offerInfoUrl,
          createdAt,
          expiresAt,
          makerListPayload,
          makerSendPayload,
          termsCommitment,
          makerListPskb,
          makerSendPskb,
          listCommitTxids: Array.isArray(cn?.listCommitTxids) ? cn.listCommitTxids : [],
          listRevealTxid,
          p2shSendOutpoint,
          p2shSendSompi,
          sendP2shAddress,
          sendRedeemScriptHex
        };

        const offerBlob = JSON.stringify(finalOfferDraft);
        const offerId = crypto.createHash("sha256").update(`${listRevealTxid}\n${termsCommitment}`, "utf8").digest("hex").slice(0, 24);

        upsertOpenSwapOffer(repoRoot, {
          offerId,
          state: "open",
          createdAt,
          expiresAt,
          updatedAt: new Date().toISOString(),
          mode: "open_swap_v2",
          discovery: "manual_import",
          fillMode: "full_fill_only",
          kind,
          networkId,
          sellSymbol,
          sellAmount: sellAmountDisplay,
          buyAmountKas,
          makerUserId: userId,
          makerWalletId: intent.wallet_id,
          makerWalletType: "compliance",
          makerKasReceiveAddress: intent.maker_kas_receive_address,
          termsCommitment,
          offerDescription: normalized.offerDescription,
          offerInfoUrl: normalized.offerInfoUrl,
          offerBlob,
          offerDraft: finalOfferDraft
        });

        const notificationBatch = normalized.openOfferBatch || null;
        if (shouldQueueOpenOfferBatchNotification(notificationBatch)) {
          queueUserNotification(
            repoRoot,
            userId,
            "maker_offer_created",
            openOfferNotificationSubject("maker", notificationBatch),
            buildOpenOfferNotificationText({
              audience: "maker",
              batch: notificationBatch,
              offerId,
              networkId,
              kind,
              sellAsset: sellSymbol,
              sellAmount: sellAmountDisplay || intent.sell_amount_raw,
              buyAmountKas,
              offerDescription: String(normalized.offerDescription || ""),
              offerInfoUrl: String(normalized.offerInfoUrl || "")
            })
          );

          queueNewOpenOfferNotifications(
            repoRoot,
            openOfferNotificationSubject("users", notificationBatch),
            buildOpenOfferNotificationText({
              audience: "users",
              batch: notificationBatch,
              offerId,
              networkId,
              kind,
              sellAsset: sellSymbol,
              sellAmount: sellAmountDisplay || intent.sell_amount_raw,
              buyAmountKas,
              offerDescription: String(normalized.offerDescription || ""),
              offerInfoUrl: String(normalized.offerInfoUrl || "")
            })
          );
        }

        return res.json({
          ok: true,
          stage: "bcw_maker_submit",
          notes: [
            "maker_list_taker_send",
            "open_v2_phase1_manual_import_only",
            "full_fill_only",
            "bcw_open_swap_maker_pskbs_ready"
          ],
          offerId,
          normalized,
          offerDraft: finalOfferDraft,
          offerBlob,
          makerListPskb,
          makerSendPskb,
          listCommitTxids: finalOfferDraft.listCommitTxids,
          listRevealTxid,
          p2shSendOutpoint,
          p2shSendSompi,
          sendP2shAddress,
          sendRedeemScriptHex,
          termsCommitment,
          cn
        });
      }

      stage = "offerRid_cache_load";
      const cached = openSwapOfferPrepCache.get(offerRid) ?? null;
      if (!cached) {
        return res.status(409).json({ ok: false, reason: "offerRid_not_found", stage });
      }
      if (cached.userId !== userId) {
        return res.status(403).json({ ok: false, reason: "offerRid_wrong_user", stage });
      }

      const active = readActiveOpenSwapMaker(repoRoot, userId);
      if (!active) {
        return res.status(400).json({ ok: false, reason: "active_wallet_missing" });
      }
      if (String(active.id || "").trim() !== cached.walletId) {
        return res.status(409).json({ ok: false, reason: "offerRid_wrong_wallet", stage });
      }

      stage = "rpc_ready";
      await ensureKaspaReady(repoRoot);
      const rpc = await getSharedRpc(cached.networkId);

      if (isCommitSubmit) {
        stage = "commit_submit";
        const commitInputSigs = Array.isArray(body.commitInputSigs) ? body.commitInputSigs : null;
        if (!commitInputSigs) {
          return res.status(400).json({ ok: false, reason: "invalid_commitInputSigs", stage });
        }
        if (commitInputSigs.length !== cached.commitPtxs.length) {
          return res.status(400).json({ ok: false, reason: "commitInputSigs_wrong_length", stage });
        }

        const commitTxids: string[] = [];
        for (let ti = 0; ti < cached.commitPtxs.length; ti++) {
          const ptx = cached.commitPtxs[ti];
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

        cached.commitTxids = commitTxids;

        stage = "p2sh_wait";
        const deadlineMs = Date.now() + 120000;
        const wanted = new Set(commitTxids);
        let commitEntry: any = null;

        while (Date.now() < deadlineMs) {
          try {
            const p2sh = await rpc.getUtxosByAddresses({ addresses: [cached.listP2shAddress] });
            const list = p2sh && Array.isArray((p2sh as any).entries) ? (p2sh as any).entries : [];
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
          return res.status(504).json({ ok: false, reason: "p2sh_commit_utxo_timeout", stage });
        }

        const buildReveal = async (feeRateToUse: number) => {
          const created = await createTransactions({
            priorityEntries: [commitEntry],
            entries: [],
            changeAddress: cached.sendP2shAddress,
            outputs: [],
            feeRate: feeRateToUse,
            priorityFee: 0n,
            networkId: cached.networkId
          });
          const transactions: any[] = created && Array.isArray((created as any).transactions) ? (created as any).transactions : [];
          if (transactions.length !== 1) throw new Error("unexpected_reveal_batch");
          const reveal0 = transactions[0];

          const wantedTxid = String(commitEntry?.outpoint?.transactionId || "");
          const wantedIdx = Number(commitEntry?.outpoint?.index ?? -1);
          const inputIndex0 = reveal0.transaction.inputs.findIndex((input: any) => {
            const op = input && input.previousOutpoint ? input.previousOutpoint : null;
            const tid = op && typeof op.transactionId === "string" ? op.transactionId : "";
            const idx = op && typeof op.index === "number" ? op.index : -1;
            return tid === wantedTxid && idx === wantedIdx;
          });
          if (inputIndex0 === -1) throw new Error("p2sh_input_not_found");
          if (inputIndex0 !== 0) throw new Error("p2sh_input_not_input0");

          const dummySig = new Uint8Array(64);
          const dummySigScriptHex = encodePushOnlyP2shSigScript(dummySig, SighashType.SingleAnyOneCanPay, cached.listRedeemScriptHex);
          reveal0.fillInput(0, dummySigScriptHex);

          const requiredFee = openSwapToccataRequiredFee(cached.networkId, reveal0.transaction, "reveal_tx_mass_exceeds_standard");

          return { reveal0, requiredFee };
        };

        stage = "reveal_build";
        let revealBuilt = await buildReveal(cached.feeRate);
        if (revealBuilt.reveal0.feeAmount < revealBuilt.requiredFee) {
          const currentFee = revealBuilt.reveal0.feeAmount > 0n ? revealBuilt.reveal0.feeAmount : 1n;
          const scale = 1000000n;
          const scaled = (revealBuilt.requiredFee * scale + currentFee - 1n) / currentFee;
          const neededFeeRate = Math.max(1.0, cached.feeRate * (Number(scaled) / 1_000_000));
          const bumpedFeeRate = Math.max(cached.feeRate, neededFeeRate);
          revealBuilt = await buildReveal(bumpedFeeRate);
          cached.feeRate = bumpedFeeRate;
          if (revealBuilt.reveal0.feeAmount < revealBuilt.requiredFee) {
            return res.status(500).json({ ok: false, reason: "reveal_fee_under_minimum", stage });
          }
        }

        const reveal0 = revealBuilt.reveal0;
        const input0: any = (reveal0.transaction as any).inputs?.[0] ?? null;
        const op0: any = input0 && typeof input0 === "object" ? input0.previousOutpoint : null;
        const op0TxidHex = bytesToHex(op0 && (op0 as any).transactionId);
        if (!op0TxidHex) {
          return res.status(500).json({ ok: false, reason: "commit_outpoint_txid_invalid", stage });
        }

        const txToSignObj: any = {
          version: (reveal0.transaction as any).version,
          lockTime: (reveal0.transaction as any).lockTime,
          subnetworkId: (reveal0.transaction as any).subnetworkId,
          gas: (reveal0.transaction as any).gas,
          payload: (reveal0.transaction as any).payload,
          inputs: [
            {
              previousOutpoint: { transactionId: op0TxidHex, index: Number((op0 as any).index) },
              sequence: (input0 as any).sequence,
              sigOpCount: (input0 as any).sigOpCount,
              utxo: (input0 as any).utxo
            }
          ],
          outputs: Array.isArray((reveal0.transaction as any).outputs)
            ? (reveal0.transaction as any).outputs.map((out: any) => {
                const spkHex = spkToHex(out && out.scriptPublicKey);
                if (!spkHex) throw new Error("reveal_output_scriptPublicKey_invalid");
                return {
                  value: typeof out?.value === "bigint" ? out.value : BigInt(String(out?.value || 0)),
                  scriptPublicKey: spkHex
                };
              })
            : []
        };

        if (!Array.isArray(txToSignObj.outputs) || !txToSignObj.outputs.length) {
          return res.status(500).json({ ok: false, reason: "reveal_outputs_missing", stage });
        }

        const txToSignSafeJson = new Transaction(txToSignObj).serializeToSafeJSON();
        cached.txToSignObj = txToSignObj;
        cached.txToSignSafeJson = txToSignSafeJson;

        return res.json({
          ok: true,
          stage: "commit_submit",
          offerRid,
          commitTxids,
          txToSignSafeJson,
          sighashType: "SingleAnyOneCanPay"
        });
      }

      if (isSendSubmit) {
        stage = "send_submit";
        if (
          !cached.commitTxids ||
          !cached.revealTxToSubmitSafeJson ||
          !cached.makerListPskb ||
          !cached.listRevealTxid ||
          typeof cached.p2shSendIndex !== "number" ||
          !cached.p2shSendSompi ||
          !cached.sendTxToSignObj ||
          !cached.sendTxToSignSafeJson
        ) {
          return res.status(409).json({ ok: false, reason: "offerRid_not_send_prepared", stage });
        }

        const sendSignature0 = typeof body.sendSignature0 === "string" ? body.sendSignature0.trim() : "";
        if (!sendSignature0) {
          return res.status(400).json({ ok: false, reason: "missing_sendSignature0", stage });
        }

        const sendSig0 = normalizeOpCheckSigSignature64(sendSignature0, "open_swap_v2.sendSignature0");
        const sendSigScriptHex0 = encodePushOnlyP2shSigScript(sendSig0, SighashType.SingleAnyOneCanPay, cached.sendRedeemScriptHex);
        const makerSendPskb = buildOpenSwapPskbForOffer(cached.sendTxToSignObj, sendSigScriptHex0, cached.sendRedeemScriptHex, ctx);
        const expectedSendJsonHex = buildCanonicalOpenSwapSendJsonHex(cached.normalized.kind, cached.normalized.sell);
        if (!expectedSendJsonHex) {
          return res.status(500).json({ ok: false, reason: "maker_send_payload_invalid", stage });
        }

        const sendValidation = await validateOpenSwapPskbV2(repoRoot, {
          phase: "accept",
          kind: cached.normalized.kind,
          pskb: makerSendPskb,
          expectedSendJsonHex
        });
        if (!sendValidation.ok) {
          return res.status(400).json({
            ok: false,
            reason: "maker_send_pskb_invalid",
            stage,
            errors: sendValidation.errors,
            warnings: sendValidation.warnings
          });
        }

        const txToSubmit = Transaction.deserializeFromSafeJSON(cached.revealTxToSubmitSafeJson);
        const submitRes = await rpc.submitTransaction({ transaction: txToSubmit, allowOrphan: false });
        const submitTxid = submitRes && typeof (submitRes as any).transactionId === "string" ? String((submitRes as any).transactionId) : "";
        if (!submitTxid) {
          return res.status(502).json({ ok: false, reason: "reveal_submit_missing_txid", stage });
        }
        if (submitTxid !== cached.listRevealTxid) {
          return res.status(500).json({ ok: false, reason: "reveal_submit_txid_mismatch", stage });
        }

        const termsCommitment = buildOpenSwapTermsCommitment(cached.offerTermsForHash);
        const finalOfferDraft = {
          ...cached.offerDraftBase,
          termsCommitment,
          makerListPskb: cached.makerListPskb,
          makerSendPskb,
          listCommitTxids: cached.commitTxids,
          listRevealTxid: cached.listRevealTxid,
          p2shSendOutpoint: { txid: cached.listRevealTxid, index: cached.p2shSendIndex },
          p2shSendSompi: cached.p2shSendSompi,
          sendP2shAddress: cached.sendP2shAddress,
          sendRedeemScriptHex: cached.sendRedeemScriptHex
        };

        const offerBlob = JSON.stringify(finalOfferDraft);
        const offerId = crypto.createHash("sha256").update(`${cached.listRevealTxid}\n${termsCommitment}`, "utf8").digest("hex").slice(0, 24);

        upsertOpenSwapOffer(repoRoot, {
          offerId,
          state: "open",
          createdAt: String(cached.offerDraftBase?.createdAt || new Date().toISOString()),
          expiresAt: String(cached.offerDraftBase?.expiresAt || ""),
          updatedAt: new Date().toISOString(),
          mode: "open_swap_v2",
          discovery: String(cached.offerDraftBase?.discovery || "manual_import"),
          fillMode: String(cached.offerDraftBase?.fillMode || "full_fill_only"),
          kind: cached.normalized.kind === "ca_to_kas" ? "ca_to_kas" : "tick_to_kas",
          networkId: cached.networkId,
          sellSymbol: String(cached.normalized?.sell?.symbol || ""),
          sellAmount: String(cached.normalized?.sell?.amount || ""),
          buyAmountKas: String(cached.normalized?.buy?.amount || ""),
          makerUserId: userId,
          makerWalletId: String(cached.normalized?.maker?.walletId || ""),
          makerWalletType: String(cached.normalized?.maker?.walletType || ""),
          makerKasReceiveAddress: String(cached.normalized?.maker?.kasReceiveAddress || ""),
          termsCommitment,
          offerDescription: String(cached.offerDraftBase?.offerDescription || ""),
          offerInfoUrl: String(cached.offerDraftBase?.offerInfoUrl || ""),
          offerBlob,
          offerDraft: finalOfferDraft
        });

        const notificationBatch = cached.normalized?.openOfferBatch || null;
        if (shouldQueueOpenOfferBatchNotification(notificationBatch)) {
          queueUserNotification(
            repoRoot,
            userId,
            "maker_offer_created",
            openOfferNotificationSubject("maker", notificationBatch),
            buildOpenOfferNotificationText({
              audience: "maker",
              batch: notificationBatch,
              offerId,
              networkId: cached.networkId,
              kind: String(cached.normalized.kind || ""),
              sellAsset: String(cached.normalized?.sell?.symbol || ""),
              sellAmount: String(cached.normalized?.sell?.amount || ""),
              buyAmountKas: String(cached.normalized?.buy?.amount || ""),
              offerDescription: String(cached.offerDraftBase?.offerDescription || ""),
              offerInfoUrl: String(cached.offerDraftBase?.offerInfoUrl || "")
            })
          );

          queueNewOpenOfferNotifications(
            repoRoot,
            openOfferNotificationSubject("users", notificationBatch),
            buildOpenOfferNotificationText({
              audience: "users",
              batch: notificationBatch,
              offerId,
              networkId: cached.networkId,
              kind: String(cached.normalized.kind || ""),
              sellAsset: String(cached.normalized?.sell?.symbol || ""),
              sellAmount: String(cached.normalized?.sell?.amount || ""),
              buyAmountKas: String(cached.normalized?.buy?.amount || ""),
              offerDescription: String(cached.offerDraftBase?.offerDescription || ""),
              offerInfoUrl: String(cached.offerDraftBase?.offerInfoUrl || "")
            })
          );
        }

        openSwapOfferPrepCache.delete(offerRid);

        return res.json({
          ok: true,
          stage: "send_submit",
          notes: [
            "maker_list_taker_send",
            "open_v2_phase1_manual_import_only",
            "full_fill_only",
            "cb2c_maker_list_pskb_ready",
            "cb4a_maker_send_pskb_ready"
          ],
          offerId,
          normalized: cached.normalized,
          offerDraft: finalOfferDraft,
          offerBlob,
          makerListPskb: cached.makerListPskb,
          makerSendPskb,
          listCommitTxids: cached.commitTxids,
          listRevealTxid: cached.listRevealTxid,
          p2shSendOutpoint: finalOfferDraft.p2shSendOutpoint,
          p2shSendSompi: finalOfferDraft.p2shSendSompi,
          sendP2shAddress: cached.sendP2shAddress,
          sendRedeemScriptHex: cached.sendRedeemScriptHex,
          termsCommitment
        });
      }

      stage = "reveal_submit";
      if (!cached.commitTxids || !cached.txToSignObj || !cached.txToSignSafeJson) {
        return res.status(409).json({ ok: false, reason: "offerRid_not_committed", stage });
      }

      const signature0 = typeof body.signature0 === "string" ? body.signature0.trim() : "";
      if (!signature0) {
        return res.status(400).json({ ok: false, reason: "missing_signature0", stage });
      }

      const sig0 = normalizeOpCheckSigSignature64(signature0, "open_swap_v2.signature0");
      const sigScriptHex0 = encodePushOnlyP2shSigScript(sig0, SighashType.SingleAnyOneCanPay, cached.listRedeemScriptHex);

      const txToSign = Transaction.deserializeFromSafeJSON(cached.txToSignSafeJson);
      const txInputs: any[] = Array.isArray(txToSign.inputs) ? txToSign.inputs : [];
      if (!txInputs[0]) {
        return res.status(500).json({ ok: false, reason: "tx_to_sign_missing_input0", stage });
      }
      txInputs[0].signatureScript = sigScriptHex0;
      txToSign.inputs = txInputs;
      txToSign.finalize();

      const makerListPskb = buildOpenSwapPskbForOffer(cached.txToSignObj, sigScriptHex0, cached.listRedeemScriptHex, ctx);
      const v = await validateOpenSwapPskbV2(repoRoot, { phase: "offer", kind: cached.normalized.kind, pskb: makerListPskb });
      if (!v.ok) {
        return res.status(500).json({
          ok: false,
          reason: "open_swap_offer_internal_validation_failed",
          stage,
          errors: v.errors,
          warnings: v.warnings
        });
      }

      const listRevealTxid = String((txToSign as any).id || "").trim();
      if (!listRevealTxid) {
        return res.status(500).json({ ok: false, reason: "reveal_local_txid_missing", stage });
      }

      const outputs: any[] = Array.isArray(txToSign.outputs) ? txToSign.outputs : [];
      let p2shSendIndex = -1;
      let p2shSendSompi = 0n;

      for (let i = 0; i < outputs.length; i++) {
        const out = outputs[i];
        const addrObj = addressFromScriptPublicKey(out && out.scriptPublicKey ? out.scriptPublicKey : null, cached.networkId);
        const addr = addrObj ? addrObj.toString() : "";
        if (addr && addr === cached.sendP2shAddress) {
          p2shSendIndex = i;
          p2shSendSompi = typeof out?.value === "bigint" ? out.value : BigInt(String(out?.value || 0));
          break;
        }
      }

      if (p2shSendIndex < 0 || p2shSendSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "p2sh_send_output_not_found", stage });
      }

      const makerAskSompi = kaspaToSompi(String(cached.normalized?.buy?.amount || ""));
      if (makerAskSompi === undefined || makerAskSompi <= 0n) {
        return res.status(500).json({ ok: false, reason: "maker_ask_sompi_invalid", stage });
      }

      const sendTxToSignObj = buildOpenSwapSendTxToSignObj({
        listRevealTxid,
        p2shSendIndex,
        p2shSendSompi,
        sendP2shAddress: cached.sendP2shAddress,
        makerKasReceiveAddress: String(cached.normalized?.maker?.kasReceiveAddress || "").trim(),
        makerAskSompi
      });
      const sendTxToSignSafeJson = new Transaction(sendTxToSignObj).serializeToSafeJSON();

      cached.revealTxToSubmitSafeJson = txToSign.serializeToSafeJSON();
      cached.makerListPskb = makerListPskb;
      cached.listRevealTxid = listRevealTxid;
      cached.p2shSendIndex = p2shSendIndex;
      cached.p2shSendSompi = p2shSendSompi.toString();
      cached.sendTxToSignObj = sendTxToSignObj;
      cached.sendTxToSignSafeJson = sendTxToSignSafeJson;

      return res.json({
        ok: true,
        stage: "send_prepare",
        offerRid,
        sendTxToSignSafeJson,
        sighashType: "SingleAnyOneCanPay",
        listRevealTxid,
        p2shSendOutpoint: { txid: listRevealTxid, index: p2shSendIndex },
        p2shSendSompi: p2shSendSompi.toString(),
        sendP2shAddress: cached.sendP2shAddress,
        sendRedeemScriptHex: cached.sendRedeemScriptHex
      });
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        reason: "open_swap_offer_failed",
        stage,
        error: String(err && err.message ? err.message : err)
      });
    }
  });
}
