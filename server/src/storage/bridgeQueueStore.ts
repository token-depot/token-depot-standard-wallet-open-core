import fs from "fs";
import path from "path";
import crypto from "crypto";

export type BridgeQueuePurchase = {
  id: string;
  type: "purchase";

  createdAt: string; // ISO
  updatedAt: string; // ISO
  status: string;    // string for forward-compat

  userId: string;
  networkId: string;

  ca: string;        // lowercase CA hex
  amountRaw: string; // raw token amount string as entered (UI-decimals aware)

  userKrcReceiveAddress: string;
  declaredPaymentSenderAddress?: string;

  depositChain?: string;
  depositTxid?: string;
  depositSender?: string;

  inventoryKaspaAddressSnapshot?: string;
  fulfillSourceKaspaAddressSnapshot?: string;

  paymentAmountRaw?: string;
  actualPaymentAmountRaw?: string;
  settlementWrappedAmountRaw?: string;
  paymentAssetRef?: string;

  fireblocksInventoryCompositeKeySnapshot?: string;
  fireblocksVaultAccountIdSnapshot?: string;
  fireblocksAssetIdSnapshot?: string;
  fireblocksReceiveAddressSnapshot?: string;
  fireblocksExternalTxId?: string;
  fireblocksTxId?: string;
  fireblocksStatus?: string;
  fireblocksSubStatus?: string;
  fireblocksUpdatedAt?: string;
  fireblocksError?: string;

  priceBpsSnapshot?: number;

  expiresAt?: string;

  brokerNotes?: string;
  fulfillTxid?: string;
  fulfillmentBatchId?: string;
  fulfillmentExecutionNonce?: string;
};

export type BridgeQueueRedeem = {
  id: string;
  type: "redeem";

  createdAt: string; // ISO
  updatedAt: string; // ISO
  status: string;    // string for forward-compat

  userId: string;
  networkId: string;

  ca: string;        // lowercase CA hex
  amountRaw: string; // raw token amount string as entered (UI-decimals aware)

  redeemTo: string;  // external destination address/string

  sourceWalletKind?: "cw_active" | "external_declared";
  sourceWalletAddress?: string;
  sourceTransferTxid?: string;

  redeemFeeBpsSnapshot?: number;
  payoutAmountRawSnapshot?: string;

  burnTxid?: string;   // legacy field from pre-source-bound redeem flow
  payoutTxid?: string; // external chain txid (final chain reference only)

  fireblocksInventoryCompositeKeySnapshot?: string;
  fireblocksVaultAccountIdSnapshot?: string;
  fireblocksAssetIdSnapshot?: string;
  fireblocksExternalTxId?: string;
  fireblocksTxId?: string;
  fireblocksStatus?: string;
  fireblocksSubStatus?: string;
  fireblocksUpdatedAt?: string;
  fireblocksError?: string;

  brokerNotes?: string;
};

export type BridgeQueueStoreV1 = {
  version: 1;
  purchases: BridgeQueuePurchase[];
  redeems: BridgeQueueRedeem[];
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "bridge-queue.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStoreFile(p: string): void {
  const dir = path.dirname(p);
  ensureDir(dir);
  if (!fs.existsSync(p)) {
    const initial: BridgeQueueStoreV1 = { version: 1, purchases: [], redeems: [] };
    fs.writeFileSync(p, JSON.stringify(initial, null, 2) + "\n", "utf8");
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: "p" | "r"): string {
  // short, unique-enough for v1: "p_" / "r_" + 12 hex chars
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function newBridgePurchaseId(): string {
  return newId("p");
}

export function readBridgeQueueStore(repoRoot: string): BridgeQueueStoreV1 {
  const p = storePath(repoRoot);
  ensureStoreFile(p);

  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as BridgeQueueStoreV1;

  if (!parsed || typeof parsed !== "object") throw new Error("bridge-queue.v1.json: invalid JSON root");
  if ((parsed as any).version !== 1) throw new Error("bridge-queue.v1.json: unsupported version");
  if (!Array.isArray((parsed as any).purchases)) throw new Error("bridge-queue.v1.json: purchases must be an array");
  if (!Array.isArray((parsed as any).redeems)) throw new Error("bridge-queue.v1.json: redeems must be an array");

  return parsed;
}

export function writeBridgeQueueStore(repoRoot: string, store: BridgeQueueStoreV1): void {
  const p = storePath(repoRoot);
  atomicWriteJson(p, store);
}

export function readBridgeQueueRaw(repoRoot: string): { filename: string; content: string } {
  const p = storePath(repoRoot);
  ensureStoreFile(p);
  return {
    filename: path.basename(p),
    content: fs.readFileSync(p, { encoding: "utf-8" })
  };
}

export function clearBridgeQueueStore(repoRoot: string): {
  filename: string;
  clearedPurchases: number;
  clearedRedeems: number;
} {
  const store = readBridgeQueueStore(repoRoot);
  writeBridgeQueueStore(repoRoot, { version: 1, purchases: [], redeems: [] });
  return {
    filename: path.basename(storePath(repoRoot)),
    clearedPurchases: Array.isArray(store.purchases) ? store.purchases.length : 0,
    clearedRedeems: Array.isArray(store.redeems) ? store.redeems.length : 0
  };
}

export type NewPurchaseInput = Omit<BridgeQueuePurchase, "id" | "type" | "createdAt" | "updatedAt"> & {
  id?: string;
  status?: string;
};

export function addBridgePurchase(repoRoot: string, input: NewPurchaseInput): BridgeQueuePurchase {
  const store = readBridgeQueueStore(repoRoot);
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const id = requestedId || newBridgePurchaseId();

  if (store.purchases.some((x) => x && x.id === id)) {
    throw new Error("purchase_id_exists");
  }

  const rec: BridgeQueuePurchase = {
    id,
    type: "purchase",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: typeof input.status === "string" && input.status.trim() ? input.status.trim() : "new",
    userId: String(input.userId || "").trim(),
    networkId: String(input.networkId || "").trim(),
    ca: String(input.ca || "").trim().toLowerCase(),
    amountRaw: String(input.amountRaw || "").trim(),
    userKrcReceiveAddress: String(input.userKrcReceiveAddress || "").trim(),
    declaredPaymentSenderAddress:
      typeof input.declaredPaymentSenderAddress === "string" ? input.declaredPaymentSenderAddress.trim() : undefined,
    depositChain: typeof input.depositChain === "string" ? input.depositChain.trim() : undefined,
    depositTxid: typeof input.depositTxid === "string" ? input.depositTxid.trim() : undefined,
    depositSender: typeof input.depositSender === "string" ? input.depositSender.trim() : undefined,
    inventoryKaspaAddressSnapshot:
      typeof input.inventoryKaspaAddressSnapshot === "string" ? input.inventoryKaspaAddressSnapshot.trim() : undefined,
    fulfillSourceKaspaAddressSnapshot:
      typeof input.fulfillSourceKaspaAddressSnapshot === "string" ? input.fulfillSourceKaspaAddressSnapshot.trim() : undefined,
    paymentAmountRaw: typeof input.paymentAmountRaw === "string" ? input.paymentAmountRaw.trim() : undefined,
    actualPaymentAmountRaw:
      typeof input.actualPaymentAmountRaw === "string" ? input.actualPaymentAmountRaw.trim() : undefined,
    settlementWrappedAmountRaw:
      typeof input.settlementWrappedAmountRaw === "string" ? input.settlementWrappedAmountRaw.trim() : undefined,
    paymentAssetRef: typeof input.paymentAssetRef === "string" ? input.paymentAssetRef.trim() : undefined,
    fireblocksInventoryCompositeKeySnapshot:
      typeof input.fireblocksInventoryCompositeKeySnapshot === "string" ? input.fireblocksInventoryCompositeKeySnapshot.trim() : undefined,
    fireblocksVaultAccountIdSnapshot:
      typeof input.fireblocksVaultAccountIdSnapshot === "string" ? input.fireblocksVaultAccountIdSnapshot.trim() : undefined,
    fireblocksAssetIdSnapshot:
      typeof input.fireblocksAssetIdSnapshot === "string" ? input.fireblocksAssetIdSnapshot.trim() : undefined,
    fireblocksReceiveAddressSnapshot:
      typeof input.fireblocksReceiveAddressSnapshot === "string" ? input.fireblocksReceiveAddressSnapshot.trim() : undefined,
    fireblocksExternalTxId:
      typeof input.fireblocksExternalTxId === "string" ? input.fireblocksExternalTxId.trim() : undefined,
    fireblocksTxId:
      typeof input.fireblocksTxId === "string" ? input.fireblocksTxId.trim() : undefined,
    fireblocksStatus:
      typeof input.fireblocksStatus === "string" ? input.fireblocksStatus.trim() : undefined,
    fireblocksSubStatus:
      typeof input.fireblocksSubStatus === "string" ? input.fireblocksSubStatus.trim() : undefined,
    fireblocksUpdatedAt:
      typeof input.fireblocksUpdatedAt === "string" ? input.fireblocksUpdatedAt.trim() : undefined,
    fireblocksError:
      typeof input.fireblocksError === "string" ? input.fireblocksError.trim() : undefined,
    priceBpsSnapshot:
      typeof input.priceBpsSnapshot === "number" && Number.isFinite(input.priceBpsSnapshot) ? input.priceBpsSnapshot : undefined,
    expiresAt:
      typeof input.expiresAt === "string" ? input.expiresAt.trim() : undefined,
    brokerNotes: typeof input.brokerNotes === "string" ? input.brokerNotes : undefined,
    fulfillTxid: typeof input.fulfillTxid === "string" ? input.fulfillTxid.trim() : undefined,
    fulfillmentBatchId:
      typeof input.fulfillmentBatchId === "string" ? input.fulfillmentBatchId.trim() : undefined,
    fulfillmentExecutionNonce:
      typeof input.fulfillmentExecutionNonce === "string" ? input.fulfillmentExecutionNonce.trim() : undefined
  };

  store.purchases.unshift(rec);
  writeBridgeQueueStore(repoRoot, store);
  return rec;
}

export type NewRedeemInput = Omit<BridgeQueueRedeem, "id" | "type" | "createdAt" | "updatedAt"> & {
  status?: string;
};

export function addBridgeRedeem(repoRoot: string, input: NewRedeemInput): BridgeQueueRedeem {
  const store = readBridgeQueueStore(repoRoot);

  const rec: BridgeQueueRedeem = {
    id: newId("r"),
    type: "redeem",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: typeof input.status === "string" && input.status.trim() ? input.status.trim() : "new",
    userId: String(input.userId || "").trim(),
    networkId: String(input.networkId || "").trim(),
    ca: String(input.ca || "").trim().toLowerCase(),
    amountRaw: String(input.amountRaw || "").trim(),
    redeemTo: String(input.redeemTo || "").trim(),
    sourceWalletKind:
      input.sourceWalletKind === "external_declared"
        ? "external_declared"
        : input.sourceWalletKind === "cw_active"
          ? "cw_active"
          : undefined,
    sourceWalletAddress:
      typeof input.sourceWalletAddress === "string" ? input.sourceWalletAddress.trim() : undefined,
    sourceTransferTxid:
      typeof input.sourceTransferTxid === "string" ? input.sourceTransferTxid.trim() : undefined,
    redeemFeeBpsSnapshot:
      typeof input.redeemFeeBpsSnapshot === "number" && Number.isFinite(input.redeemFeeBpsSnapshot)
        ? input.redeemFeeBpsSnapshot
        : undefined,
    payoutAmountRawSnapshot:
      typeof input.payoutAmountRawSnapshot === "string" ? input.payoutAmountRawSnapshot.trim() : undefined,
    burnTxid: typeof input.burnTxid === "string" ? input.burnTxid.trim() : undefined,
    payoutTxid: typeof input.payoutTxid === "string" ? input.payoutTxid.trim() : undefined,
    fireblocksInventoryCompositeKeySnapshot:
      typeof input.fireblocksInventoryCompositeKeySnapshot === "string" ? input.fireblocksInventoryCompositeKeySnapshot.trim() : undefined,
    fireblocksVaultAccountIdSnapshot:
      typeof input.fireblocksVaultAccountIdSnapshot === "string" ? input.fireblocksVaultAccountIdSnapshot.trim() : undefined,
    fireblocksAssetIdSnapshot:
      typeof input.fireblocksAssetIdSnapshot === "string" ? input.fireblocksAssetIdSnapshot.trim() : undefined,
    fireblocksExternalTxId:
      typeof input.fireblocksExternalTxId === "string" ? input.fireblocksExternalTxId.trim() : undefined,
    fireblocksTxId:
      typeof input.fireblocksTxId === "string" ? input.fireblocksTxId.trim() : undefined,
    fireblocksStatus:
      typeof input.fireblocksStatus === "string" ? input.fireblocksStatus.trim() : undefined,
    fireblocksSubStatus:
      typeof input.fireblocksSubStatus === "string" ? input.fireblocksSubStatus.trim() : undefined,
    fireblocksUpdatedAt:
      typeof input.fireblocksUpdatedAt === "string" ? input.fireblocksUpdatedAt.trim() : undefined,
    fireblocksError:
      typeof input.fireblocksError === "string" ? input.fireblocksError.trim() : undefined,
    brokerNotes: typeof input.brokerNotes === "string" ? input.brokerNotes : undefined
  };

  store.redeems.unshift(rec);
  writeBridgeQueueStore(repoRoot, store);
  return rec;
}

export function updateBridgePurchase(
  repoRoot: string,
  id: string,
  patch: Partial<
    Pick<
      BridgeQueuePurchase,
      | "status"
      | "depositChain"
      | "depositTxid"
      | "depositSender"
      | "brokerNotes"
      | "fulfillTxid"
      | "fulfillmentBatchId"
      | "fulfillmentExecutionNonce"
      | "fireblocksExternalTxId"
      | "fireblocksTxId"
      | "fireblocksStatus"
      | "fireblocksSubStatus"
      | "fireblocksUpdatedAt"
      | "fireblocksError"
      | "actualPaymentAmountRaw"
      | "settlementWrappedAmountRaw"
      | "expiresAt"
    >
  >
): BridgeQueuePurchase {
  const store = readBridgeQueueStore(repoRoot);
  const idx = store.purchases.findIndex((x) => x && x.id === id);
  if (idx < 0) throw new Error("purchase_not_found");

  const cur = store.purchases[idx];
  const next: BridgeQueuePurchase = { ...cur, ...patch, updatedAt: nowIso() };

  if (typeof next.status === "string") next.status = next.status.trim();
  if (typeof next.depositChain === "string") next.depositChain = next.depositChain.trim();
  if (typeof next.depositTxid === "string") next.depositTxid = next.depositTxid.trim();
  if (typeof next.depositSender === "string") next.depositSender = next.depositSender.trim();
  if (typeof next.fulfillTxid === "string") next.fulfillTxid = next.fulfillTxid.trim();
  if (typeof next.fulfillmentBatchId === "string") next.fulfillmentBatchId = next.fulfillmentBatchId.trim();
  if (typeof next.fulfillmentExecutionNonce === "string") next.fulfillmentExecutionNonce = next.fulfillmentExecutionNonce.trim();
  if (typeof next.fireblocksExternalTxId === "string") next.fireblocksExternalTxId = next.fireblocksExternalTxId.trim();
  if (typeof next.fireblocksTxId === "string") next.fireblocksTxId = next.fireblocksTxId.trim();
  if (typeof next.fireblocksStatus === "string") next.fireblocksStatus = next.fireblocksStatus.trim();
  if (typeof next.fireblocksSubStatus === "string") next.fireblocksSubStatus = next.fireblocksSubStatus.trim();
  if (typeof next.fireblocksUpdatedAt === "string") next.fireblocksUpdatedAt = next.fireblocksUpdatedAt.trim();
  if (typeof next.fireblocksError === "string") next.fireblocksError = next.fireblocksError.trim();
  if (typeof next.actualPaymentAmountRaw === "string") next.actualPaymentAmountRaw = next.actualPaymentAmountRaw.trim();
  if (typeof next.settlementWrappedAmountRaw === "string") next.settlementWrappedAmountRaw = next.settlementWrappedAmountRaw.trim();
  if (typeof next.expiresAt === "string") next.expiresAt = next.expiresAt.trim();

  store.purchases[idx] = next;
  writeBridgeQueueStore(repoRoot, store);
  return next;
}

function parseIsoMs(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function normalizePurchaseStatus(raw: unknown): string {
  return String(raw || "").trim().toLowerCase();
}

const LEGACY_PURCHASE_UNPAID_TTL_MS = 30 * 60 * 1000;

function resolveAwaitingPaymentExpiresAtMs(
  row: Pick<BridgeQueuePurchase, "createdAt" | "expiresAt">
): number | null {
  const explicitExpiresAtMs = parseIsoMs(row && row.expiresAt);
  if (explicitExpiresAtMs !== null) return explicitExpiresAtMs;

  const createdAtMs = parseIsoMs(row && row.createdAt);
  if (createdAtMs === null) return null;

  return createdAtMs + LEGACY_PURCHASE_UNPAID_TTL_MS;
}

export function isBridgePurchaseCommittedStatus(raw: unknown): boolean {
  const s = normalizePurchaseStatus(raw);
  return s === "payment_detected" || s === "waiting_inventory" || s === "ready_for_fulfillment" || s === "fulfillment_prepared" || s === "fulfillment_executing" || s === "fulfillment_submitted";
}

export function isBridgePurchaseAwaitingPaymentStatus(raw: unknown): boolean {
  const s = normalizePurchaseStatus(raw);
  return s === "" || s === "new" || s === "awaiting_payment";
}

export function isBridgePurchaseAwaitingPaymentActive(
  row: Pick<BridgeQueuePurchase, "status" | "createdAt" | "expiresAt">,
  nowMs: number = Date.now()
): boolean {
  if (!isBridgePurchaseAwaitingPaymentStatus(row && row.status)) return false;
  const expiresAtMs = resolveAwaitingPaymentExpiresAtMs(row);
  if (expiresAtMs === null) return false;
  return nowMs < expiresAtMs;
}

export function isBridgePurchaseConflictActive(
  row: Pick<BridgeQueuePurchase, "status" | "createdAt" | "expiresAt">,
  nowMs: number = Date.now()
): boolean {
  if (isBridgePurchaseCommittedStatus(row && row.status)) return true;
  return isBridgePurchaseAwaitingPaymentActive(row, nowMs);
}

export function normalizeBridgePurchaseForTime(row: BridgeQueuePurchase, nowMs: number = Date.now()): BridgeQueuePurchase {
  if (!row || typeof row !== "object") return row;
  if (!isBridgePurchaseAwaitingPaymentStatus(row.status)) return row;

  const expiresAtMs = resolveAwaitingPaymentExpiresAtMs(row);
  if (expiresAtMs === null) {
    return { ...row, status: "expired_unpaid" };
  }

  if (nowMs < expiresAtMs) {
    const nextStatus = String(row.status || "").trim().toLowerCase() === "new" ? "awaiting_payment" : row.status;
    const nextExpiresAt = row.expiresAt && String(row.expiresAt).trim()
      ? row.expiresAt
      : new Date(expiresAtMs).toISOString();

    if (nextStatus !== row.status || nextExpiresAt !== row.expiresAt) {
      return { ...row, status: nextStatus, expiresAt: nextExpiresAt };
    }
    return row;
  }

  return { ...row, status: "expired_unpaid", expiresAt: new Date(expiresAtMs).toISOString() };
}

export function normalizeBridgeQueueStore(repoRoot: string, nowMs: number = Date.now()): BridgeQueueStoreV1 {
  const store = readBridgeQueueStore(repoRoot);
  let changed = false;

  store.purchases = store.purchases.map((row) => {
    const next = normalizeBridgePurchaseForTime(row, nowMs);
    if (next !== row) {
      changed = true;
      if (next.updatedAt === row.updatedAt) next.updatedAt = nowIso();
    }
    return next;
  });

  if (changed) writeBridgeQueueStore(repoRoot, store);
  return store;
}

export function getCommittedPurchaseAmountRawByCa(store: BridgeQueueStoreV1, networkId: string): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const row of store.purchases || []) {
    if (!row || row.networkId !== networkId) continue;
    if (!isBridgePurchaseCommittedStatus(row.status)) continue;
    const ca = String(row.ca || "").trim().toLowerCase();
    const amountRaw = String(row.amountRaw || "").trim();
    if (!ca || !/^\d+$/.test(amountRaw)) continue;
    totals.set(ca, (totals.get(ca) || 0n) + BigInt(amountRaw));
  }

  const out: Record<string, string> = {};
  for (const [ca, total] of totals.entries()) out[ca] = total.toString();
  return out;
}

export function updateBridgeRedeem(
  repoRoot: string,
  id: string,
  patch: Partial<
    Pick<
      BridgeQueueRedeem,
      | "status"
      | "burnTxid"
      | "payoutTxid"
      | "brokerNotes"
      | "fireblocksInventoryCompositeKeySnapshot"
      | "fireblocksVaultAccountIdSnapshot"
      | "fireblocksAssetIdSnapshot"
      | "fireblocksExternalTxId"
      | "fireblocksTxId"
      | "fireblocksStatus"
      | "fireblocksSubStatus"
      | "fireblocksUpdatedAt"
      | "fireblocksError"
    >
  >
): BridgeQueueRedeem {
  const store = readBridgeQueueStore(repoRoot);
  const idx = store.redeems.findIndex((x) => x && x.id === id);
  if (idx < 0) throw new Error("redeem_not_found");

  const cur = store.redeems[idx];
  const next: BridgeQueueRedeem = { ...cur, ...patch, updatedAt: nowIso() };

  if (typeof next.status === "string") next.status = next.status.trim();
  if (typeof next.burnTxid === "string") next.burnTxid = next.burnTxid.trim();
  if (typeof next.payoutTxid === "string") next.payoutTxid = next.payoutTxid.trim();
  if (typeof next.fireblocksInventoryCompositeKeySnapshot === "string") next.fireblocksInventoryCompositeKeySnapshot = next.fireblocksInventoryCompositeKeySnapshot.trim();
  if (typeof next.fireblocksVaultAccountIdSnapshot === "string") next.fireblocksVaultAccountIdSnapshot = next.fireblocksVaultAccountIdSnapshot.trim();
  if (typeof next.fireblocksAssetIdSnapshot === "string") next.fireblocksAssetIdSnapshot = next.fireblocksAssetIdSnapshot.trim();
  if (typeof next.fireblocksExternalTxId === "string") next.fireblocksExternalTxId = next.fireblocksExternalTxId.trim();
  if (typeof next.fireblocksTxId === "string") next.fireblocksTxId = next.fireblocksTxId.trim();
  if (typeof next.fireblocksStatus === "string") next.fireblocksStatus = next.fireblocksStatus.trim();
  if (typeof next.fireblocksSubStatus === "string") next.fireblocksSubStatus = next.fireblocksSubStatus.trim();
  if (typeof next.fireblocksUpdatedAt === "string") next.fireblocksUpdatedAt = next.fireblocksUpdatedAt.trim();
  if (typeof next.fireblocksError === "string") next.fireblocksError = next.fireblocksError.trim();

  store.redeems[idx] = next;
  writeBridgeQueueStore(repoRoot, store);
  return next;
}
