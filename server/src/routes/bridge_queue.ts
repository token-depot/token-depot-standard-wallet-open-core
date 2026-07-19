import type { Express, Request, Response } from "express";
import { addBridgePurchase, addBridgeRedeem, clearBridgeQueueStore, getCommittedPurchaseAmountRawByCa, newBridgePurchaseId, normalizeBridgeQueueStore, readBridgeQueueRaw, readBridgeQueueStore, updateBridgePurchase, updateBridgeRedeem } from "../storage/bridgeQueueStore";
import {
  getBridgeFulfillmentResultArtifact,
  listBridgeFulfillmentResultArtifacts,
  removeBridgeFulfillmentResultArtifact
} from "../storage/bridgeFulfillmentResultStore";
import { readUserState } from "../storage/userStateStore";
import { readWrappedConfigV7 } from "../storage/wrappedConfigStore";

export type BridgeQueueCtx = {
  repoRoot: string;
  cnBaseUrl: string;
  cnTimeoutMs: number;
  kasplexGetAddressTokenList: (network: string, address: string) => Promise<any>;
};

function requireAdminToken(req: Request, res: Response): boolean {
  const tok = String(req.headers["x-td-admin-token"] || "").trim();
  const expected = String(process.env.TD_ADMIN_TOKEN || "").trim();

  if (!expected) {
    res.status(500).json({ ok: false, reason: "server_missing_td_admin_token" });
    return false;
  }
  if (!tok || tok !== expected) {
    res.status(403).json({ ok: false, reason: "forbidden" });
    return false;
  }
  return true;
}

function getUserId(res: Response): string | null {
  const v = (res.locals as any).td_user_id;
  const uid = typeof v === "string" ? v.trim() : "";
  return uid ? uid : null;
}

function normalizeKaspaNetworkKey(raw: unknown): string {
  const s = String(raw || "").trim();
  if (s === "mainnet") return "mainnet";
  if (s === "tn10") return "tn10";
  if (s === "testnet-10") return "tn10";
  return s;
}

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
}

function normalizeAddressForMatch(raw: unknown): string {
  return String(raw || "").trim().toLowerCase();
}

function parseDecimalToRawUnits(input: string, decimals: number): bigint | null {
  const s = String(input || "").trim();
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (!/^\d+(?:\.\d*)?$/.test(s)) return null;

  const [wholePart, fracPart = ""] = s.split(".");
  if (fracPart.length > decimals) return null;

  const scale = 10n ** BigInt(decimals);
  const wholeUnits = BigInt(wholePart || "0") * scale;
  const fracUnits = BigInt((fracPart || "").padEnd(decimals, "0") || "0");
  return wholeUnits + fracUnits;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv_invalid_divisor");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

function parseInventoryAmountToRawUnits(value: unknown, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    if (!s) return null;
    return parseDecimalToRawUnits(s, decimals);
  }
  return null;
}

const PURCHASE_UNPAID_TTL_MS = 30 * 60 * 1000;

function addMsIso(baseMs: number, addMs: number): string {
  return new Date(baseMs + addMs).toISOString();
}

function isPurchaseUnpaidLockActive(row: Record<string, unknown>): boolean {
  const status = String(row.status || "").trim().toLowerCase();
  if (status === "new") return true;
  if (status !== "awaiting_payment") return false;

  const expiresAt = String(row.expiresAt || "").trim();
  if (!expiresAt) return false;

  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return false;

  return expiresMs > Date.now();
}

function purchaseMatchesUnpaidPayerLock(
  row: Record<string, unknown>,
  userId: string,
  networkId: string,
  fireblocksAssetIdSnapshot: string,
  declaredPaymentSenderAddress: string
): boolean {
  return String(row.userId || "").trim() === userId &&
    String(row.networkId || "").trim() === networkId &&
    String(row.fireblocksAssetIdSnapshot || "").trim() === fireblocksAssetIdSnapshot &&
    normalizeAddressForMatch(row.declaredPaymentSenderAddress) === normalizeAddressForMatch(declaredPaymentSenderAddress);
}

function findBlockingUnpaidPurchase(
  purchases: Record<string, unknown>[],
  userId: string,
  networkId: string,
  fireblocksAssetIdSnapshot: string,
  declaredPaymentSenderAddress: string
): Record<string, unknown> | undefined {
  return purchases.find((row) =>
    row &&
    isPurchaseUnpaidLockActive(row) &&
    purchaseMatchesUnpaidPayerLock(row, userId, networkId, fireblocksAssetIdSnapshot, declaredPaymentSenderAddress)
  );
}

function resolveBridgePaymentAddress(
  cfg: unknown,
  networkId: string,
  asset: Record<string, unknown>
): string | undefined {
  if (networkId === "tn10") {
    const vaultTestnet =
      asset.vaultTestnet && typeof asset.vaultTestnet === "object"
        ? (asset.vaultTestnet as Record<string, unknown>)
        : null;

    const address =
      vaultTestnet && typeof vaultTestnet.address === "string"
        ? vaultTestnet.address.trim()
        : "";

    return address || undefined;
  }

  if (networkId === "mainnet") {
    const vaultId = typeof asset.vaultId === "string" ? asset.vaultId.trim() : "";
    const vaults =
      cfg && typeof cfg === "object" && (cfg as any).vaults && typeof (cfg as any).vaults === "object"
        ? ((cfg as any).vaults as Record<string, unknown>)
        : null;

    const vault =
      vaults && typeof vaults[vaultId] === "object" && vaults[vaultId]
        ? (vaults[vaultId] as Record<string, unknown>)
        : null;

    const address =
      vault && typeof vault.address === "string"
        ? vault.address.trim()
        : "";

    return address || undefined;
  }

  return undefined;
}

type BridgeRedeemSubmitResult = {
  ok: boolean;
  status: number;
  json: any;
  error?: string;
};

async function submitRedeemToCn(ctx: BridgeQueueCtx, id: string): Promise<BridgeRedeemSubmitResult> {
  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    return {
      ok: false,
      status: 500,
      json: { ok: false, reason: "server_missing_td_admin_token" }
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.cnTimeoutMs);

  try {
    const r = await fetch(`${ctx.cnBaseUrl}/api/cn/fireblocks/redeem/submit`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-td-admin-token": adminToken
      },
      body: JSON.stringify({ id }),
      signal: controller.signal
    });

    const json = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: String(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestPurchaseDepositAddressFromCn(
  ctx: BridgeQueueCtx,
  purchaseId: string,
  vaultAccountId: string,
  assetId: string
): Promise<{ ok: boolean; status: number; json: any; error?: string }> {
  const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    return {
      ok: false,
      status: 500,
      json: { ok: false, reason: "server_missing_td_admin_token" }
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.cnTimeoutMs);

  try {
    const r = await fetch(`${ctx.cnBaseUrl}/api/cn/fireblocks/purchase/address/create`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-td-admin-token": adminToken
      },
      body: JSON.stringify({ purchaseId, vaultAccountId, assetId }),
      signal: controller.signal
    });

    const json = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: String(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerBridgeQueueRoutes(app: Express, ctx: BridgeQueueCtx): void {
  // User: read broker inventory balances (session-gated by /api middleware).
  app.get("/api/v1/bridge/inventory", async (req, res) => {
    try {
      const userId = getUserId(res);
      if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

      const netQ =
        typeof (req.query as any).net === "string"
          ? String((req.query as any).net)
          : (Array.isArray((req.query as any).net) ? String((req.query as any).net[0] || "") : "");

      const netKey = normalizeKaspaNetworkKey(netQ);
      if (netKey !== "mainnet" && netKey !== "tn10") {
        return res.status(400).json({ ok: false, reason: "invalid_net" });
      }

      const cfg = readWrappedConfigV7(ctx.repoRoot);

      const invRaw =
        cfg &&
        (cfg as any).bridge &&
        (cfg as any).bridge.inventoryKaspaAddressByNetwork &&
        typeof (cfg as any).bridge.inventoryKaspaAddressByNetwork[netKey] === "string"
          ? String((cfg as any).bridge.inventoryKaspaAddressByNetwork[netKey]).trim()
          : "";

      if (!invRaw) {
        return res.status(409).json({ ok: false, reason: "inventory_not_configured" });
      }

      const bucket =
        cfg && (cfg as any).controlledAssetsByNetwork
          ? (cfg as any).controlledAssetsByNetwork[netKey]
          : null;

      const cas: string[] = [];
      const decimalsByCa: Record<string, number> = {};
      if (bucket && typeof bucket === "object") {
        for (const v of Object.values(bucket)) {
          if (!v || typeof v !== "object") continue;
          const ca = String((v as any).ca || "").trim().toLowerCase();
          const decimals =
            typeof (v as any).decimals === "number" &&
            Number.isInteger((v as any).decimals) &&
            Number((v as any).decimals) >= 0
              ? Number((v as any).decimals)
              : null;
          if (!ca || !isHex64(ca) || !Number.isInteger(decimals)) continue;
          cas.push(ca);
          decimalsByCa[ca] = Number(decimals);
        }
      }

      const uniqCas = Array.from(new Set(cas));
      const currentStore = normalizeBridgeQueueStore(ctx.repoRoot);
      const committedPaidUnfulfilledRawByCa = getCommittedPurchaseAmountRawByCa(currentStore, netKey);

      if (!uniqCas.length) {
        const serverNow = new Date().toISOString();
        return res.json({
          ok: true,
          net: netKey,
          inventoryAddress: invRaw,
          balancesByCa: {},
          committedPaidUnfulfilledRawByCa: {},
          availableToBuyRawByCa: {},
          nonzeroCas: [],
          updatedAt: serverNow,
          serverNow
        });
      }

      const kasplexNet = netKey === "mainnet" ? "mainnet" : "testnet";
      const out = await ctx.kasplexGetAddressTokenList(kasplexNet, invRaw);
      const issues = Array.isArray(out && (out as any).issue) ? (out as any).issue : [];

      const balancesByCa: Record<string, string> = {};
      for (const ca of uniqCas) balancesByCa[ca] = "0";

      for (const it of issues) {
        if (!it || typeof it !== "object") continue;
        const ca = typeof (it as any).ca === "string" ? String((it as any).ca).trim().toLowerCase() : "";
        if (!ca || !Object.prototype.hasOwnProperty.call(balancesByCa, ca)) continue;

        const decimals = decimalsByCa[ca];
        if (!Number.isInteger(decimals)) continue;

        const amt = parseInventoryAmountToRawUnits((it as any).amount, decimals);
        if (amt === null) continue;

        balancesByCa[ca] = amt.toString();
      }

      const availableToBuyRawByCa: Record<string, string> = {};
      for (const ca of uniqCas) {
        const balanceUnits = BigInt(balancesByCa[ca] || "0");
        const committedUnits = BigInt(committedPaidUnfulfilledRawByCa[ca] || "0");
        availableToBuyRawByCa[ca] = (balanceUnits > committedUnits ? (balanceUnits - committedUnits) : 0n).toString();
      }

      const nonzeroCas = uniqCas.filter((ca) => BigInt(balancesByCa[ca] || "0") > 0n);
      const serverNow = new Date().toISOString();

      return res.json({
        ok: true,
        net: netKey,
        inventoryAddress: invRaw,
        balancesByCa,
        committedPaidUnfulfilledRawByCa,
        availableToBuyRawByCa,
        nonzeroCas,
        updatedAt: serverNow,
        serverNow
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "inventory_query_failed", error: String(err) });
    }
  });

  // User: create a purchase request (session-gated by /api middleware).
  app.get("/api/v1/bridge/purchase/status", (req, res) => {
    try {
      const userId = getUserId(res);
      if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

      const id =
        typeof (req.query as any).id === "string"
          ? String((req.query as any).id).trim()
          : (Array.isArray((req.query as any).id) ? String((req.query as any).id[0] || "").trim() : "");

      if (!id) return res.status(400).json({ ok: false, reason: "invalid_id" });

      const store = normalizeBridgeQueueStore(ctx.repoRoot);
      const purchase = store.purchases.find((row) => row && row.id === id && row.userId === userId) ?? null;
      if (!purchase) return res.status(404).json({ ok: false, reason: "purchase_not_found" });

      return res.json({ ok: true, purchase, serverNow: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_purchase_status_failed", error: String(err) });
    }
  });

  app.get("/api/v1/bridge/purchase/precheck", (req, res) => {
    try {
      const userId = getUserId(res);
      if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

      const networkId = normalizeKaspaNetworkKey((req.query as any).networkId);
      const ca =
        typeof (req.query as any).ca === "string"
          ? String((req.query as any).ca).trim().toLowerCase()
          : (Array.isArray((req.query as any).ca) ? String((req.query as any).ca[0] || "").trim().toLowerCase() : "");
      const declaredPaymentSenderAddress =
        typeof (req.query as any).declaredPaymentSenderAddress === "string"
          ? String((req.query as any).declaredPaymentSenderAddress).trim()
          : (Array.isArray((req.query as any).declaredPaymentSenderAddress) ? String((req.query as any).declaredPaymentSenderAddress[0] || "").trim() : "");

      if (!networkId) return res.status(400).json({ ok: false, reason: "invalid_network" });
      if (!ca || !isHex64(ca)) return res.status(400).json({ ok: false, reason: "invalid_ca" });
      if (!declaredPaymentSenderAddress) {
        return res.status(400).json({ ok: false, reason: "invalid_declared_payment_sender_address" });
      }

      const cfg = readWrappedConfigV7(ctx.repoRoot);
      const assetsByNetwork =
        cfg &&
        (cfg as any).controlledAssetsByNetwork &&
        (cfg as any).controlledAssetsByNetwork[networkId] &&
        typeof (cfg as any).controlledAssetsByNetwork[networkId] === "object"
          ? (cfg as any).controlledAssetsByNetwork[networkId]
          : null;

      const asset =
        assetsByNetwork &&
        typeof assetsByNetwork[ca] === "object" &&
        assetsByNetwork[ca]
          ? (assetsByNetwork[ca] as Record<string, unknown>)
          : null;

      if (!asset) return res.status(400).json({ ok: false, reason: "bridge_purchase_asset_not_configured" });

      const fireblocks =
        asset.fireblocks && typeof asset.fireblocks === "object"
          ? (asset.fireblocks as Record<string, unknown>)
          : null;

      if (!fireblocks || fireblocks.enabled !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_fireblocks_disabled" });
      }

      const fireblocksAssetIdSnapshot =
        typeof fireblocks.assetId === "string" && String(fireblocks.assetId).trim()
          ? String(fireblocks.assetId).trim()
          : undefined;

      if (!fireblocksAssetIdSnapshot) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_mapping_incomplete" });
      }

      const store = normalizeBridgeQueueStore(ctx.repoRoot);
      const blockingPurchase = findBlockingUnpaidPurchase(
        store.purchases,
        userId,
        networkId,
        fireblocksAssetIdSnapshot,
        declaredPaymentSenderAddress
      );

      return res.json({
        ok: true,
        blocked: !!blockingPurchase,
        existingPurchaseId: blockingPurchase ? blockingPurchase.id : undefined,
        existingStatus: blockingPurchase ? blockingPurchase.status : undefined,
        existingExpiresAt: blockingPurchase ? blockingPurchase.expiresAt : undefined,
        serverNow: new Date().toISOString()
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_purchase_precheck_failed", error: String(err) });
    }
  });

  app.post("/api/v1/bridge/purchase/request", async (req, res) => {
    try {
      const userId = getUserId(res);
      if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const ca = String(body.ca || "").trim().toLowerCase();
      const amountRaw = String(body.amountRaw || "").trim();
      const userKrcReceiveAddress = String(body.userKrcReceiveAddress || "").trim();
      const declaredPaymentSenderAddress = String(body.declaredPaymentSenderAddress || "").trim();
      const networkId = normalizeKaspaNetworkKey(body.networkId);

      const depositChain = String(body.depositChain || "").trim();
      const depositTxid = String(body.depositTxid || "").trim().toLowerCase();

      if (!ca || !isHex64(ca)) return res.status(400).json({ ok: false, reason: "invalid_ca" });
      if (!userKrcReceiveAddress) return res.status(400).json({ ok: false, reason: "invalid_user_receive_address" });
      if (!declaredPaymentSenderAddress) {
        return res.status(400).json({ ok: false, reason: "invalid_declared_payment_sender_address" });
      }
      if (!networkId) return res.status(400).json({ ok: false, reason: "invalid_network" });
      if (depositTxid && !isHex64(depositTxid)) return res.status(400).json({ ok: false, reason: "invalid_deposit_txid" });

      const cfg = readWrappedConfigV7(ctx.repoRoot);

      const assetsByNetwork =
        cfg &&
        (cfg as any).controlledAssetsByNetwork &&
        (cfg as any).controlledAssetsByNetwork[networkId] &&
        typeof (cfg as any).controlledAssetsByNetwork[networkId] === "object"
          ? (cfg as any).controlledAssetsByNetwork[networkId]
          : null;

      const asset =
        assetsByNetwork &&
        typeof assetsByNetwork[ca] === "object" &&
        assetsByNetwork[ca]
          ? (assetsByNetwork[ca] as Record<string, unknown>)
          : null;

      if (!asset) return res.status(400).json({ ok: false, reason: "bridge_purchase_asset_not_configured" });

      const fireblocks =
        asset.fireblocks && typeof asset.fireblocks === "object"
          ? (asset.fireblocks as Record<string, unknown>)
          : null;

      if (!fireblocks || fireblocks.enabled !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_fireblocks_disabled" });
      }

      const bridgePolicy =
        asset.bridgePolicy && typeof asset.bridgePolicy === "object"
          ? (asset.bridgePolicy as Record<string, unknown>)
          : null;

      const purchasePolicy =
        bridgePolicy &&
        bridgePolicy.purchase &&
        typeof bridgePolicy.purchase === "object"
          ? (bridgePolicy.purchase as Record<string, unknown>)
          : null;

      if (!purchasePolicy || purchasePolicy.enabled !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_policy_disabled" });
      }

      const assetDecimals =
        typeof asset.decimals === "number" && Number.isInteger(asset.decimals) && asset.decimals >= 0
          ? Number(asset.decimals)
          : undefined;

      if (typeof assetDecimals !== "number") {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_asset_decimals_missing" });
      }

      const amountUnits = parseDecimalToRawUnits(amountRaw, assetDecimals);
      if (amountUnits === null || amountUnits <= 0n) {
        return res.status(400).json({ ok: false, reason: "invalid_amount" });
      }

      const minAmountRaw =
        typeof purchasePolicy.minAmountRaw === "string" && String(purchasePolicy.minAmountRaw).trim()
          ? String(purchasePolicy.minAmountRaw).trim()
          : undefined;

      if (!minAmountRaw || !/^\d+$/.test(minAmountRaw)) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_min_amount_missing" });
      }

      const minAmountUnits = BigInt(minAmountRaw);
      if (amountUnits < minAmountUnits) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_amount_below_minimum" });
      }

      const paymentAssetRef =
        typeof asset.assetRef === "string" && String(asset.assetRef).trim()
          ? String(asset.assetRef).trim()
          : undefined;

      if (!paymentAssetRef) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_payment_asset_missing" });
      }

      const priceBpsSnapshot =
        typeof purchasePolicy.priceBps === "number" &&
        Number.isFinite(purchasePolicy.priceBps) &&
        Number.isInteger(purchasePolicy.priceBps) &&
        purchasePolicy.priceBps >= 0
          ? Number(purchasePolicy.priceBps)
          : undefined;

      if (typeof priceBpsSnapshot !== "number") {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_price_missing" });
      }

      const markupAmountUnits = ceilDiv(amountUnits * BigInt(priceBpsSnapshot), 10000n);
      const paymentAmountRaw = (amountUnits + markupAmountUnits).toString();

      const fireblocksInventoryCompositeKeySnapshot =
        typeof fireblocks.inventoryCompositeKey === "string" && String(fireblocks.inventoryCompositeKey).trim()
          ? String(fireblocks.inventoryCompositeKey).trim()
          : undefined;

      const fireblocksVaultAccountIdSnapshot =
        typeof fireblocks.vaultAccountId === "string" && String(fireblocks.vaultAccountId).trim()
          ? String(fireblocks.vaultAccountId).trim()
          : undefined;

      const fireblocksAssetIdSnapshot =
        typeof fireblocks.assetId === "string" && String(fireblocks.assetId).trim()
          ? String(fireblocks.assetId).trim()
          : undefined;

      if (!fireblocksInventoryCompositeKeySnapshot || !fireblocksVaultAccountIdSnapshot || !fireblocksAssetIdSnapshot) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_mapping_incomplete" });
      }

      let inventoryKaspaAddressSnapshot: string | undefined = undefined;
      try {
        const inv =
          cfg &&
          (cfg as any).bridge &&
          (cfg as any).bridge.inventoryKaspaAddressByNetwork &&
          typeof (cfg as any).bridge.inventoryKaspaAddressByNetwork[networkId] === "string"
            ? String((cfg as any).bridge.inventoryKaspaAddressByNetwork[networkId]).trim()
            : "";
        inventoryKaspaAddressSnapshot = inv ? inv : undefined;
      } catch {
        inventoryKaspaAddressSnapshot = undefined;
      }

      const fulfillSourceKaspaAddressSnapshot = inventoryKaspaAddressSnapshot;

      if (!inventoryKaspaAddressSnapshot) {
        return res.status(400).json({ ok: false, reason: "bridge_purchase_inventory_not_configured" });
      }

      const currentStore = normalizeBridgeQueueStore(ctx.repoRoot);
      const blockingPurchase = findBlockingUnpaidPurchase(
        currentStore.purchases,
        userId,
        networkId,
        fireblocksAssetIdSnapshot,
        declaredPaymentSenderAddress
      );

      if (blockingPurchase) {
        return res.status(409).json({
          ok: false,
          reason: "bridge_purchase_unpaid_payer_lock",
          existingPurchaseId: blockingPurchase.id,
          existingStatus: blockingPurchase.status,
          existingExpiresAt: blockingPurchase.expiresAt
        });
      }

      const purchaseId = newBridgePurchaseId();
      const depositAddressResult = await requestPurchaseDepositAddressFromCn(
        ctx,
        purchaseId,
        fireblocksVaultAccountIdSnapshot,
        fireblocksAssetIdSnapshot
      );

      if (!depositAddressResult.ok) {
        return res.status(502).json({
          ok: false,
          reason: "bridge_purchase_deposit_address_failed",
          cnStatus: depositAddressResult.status,
          cn: depositAddressResult.json,
          error: depositAddressResult.error
        });
      }

      const fireblocksReceiveAddressSnapshot =
        depositAddressResult.json && typeof depositAddressResult.json.address === "string"
          ? depositAddressResult.json.address.trim()
          : "";

      if (!fireblocksReceiveAddressSnapshot) {
        return res.status(502).json({ ok: false, reason: "bridge_purchase_deposit_address_missing" });
      }
      if (isEvmAddress(fireblocksReceiveAddressSnapshot) && !isEvmAddress(declaredPaymentSenderAddress)) {
        return res.status(400).json({ ok: false, reason: "invalid_declared_payment_sender_address_format" });
      }

      const nowMs = Date.now();
      const rec = addBridgePurchase(ctx.repoRoot, {
        id: purchaseId,
        userId,
        networkId,
        ca,
        amountRaw: amountUnits.toString(),
        userKrcReceiveAddress,
        declaredPaymentSenderAddress,
        depositChain: depositChain || undefined,
        depositTxid: depositTxid || undefined,
        inventoryKaspaAddressSnapshot,
        fulfillSourceKaspaAddressSnapshot,
        paymentAmountRaw,
        paymentAssetRef,
        fireblocksInventoryCompositeKeySnapshot,
        fireblocksVaultAccountIdSnapshot,
        fireblocksAssetIdSnapshot,
        fireblocksReceiveAddressSnapshot,
        priceBpsSnapshot,
        expiresAt: addMsIso(nowMs, PURCHASE_UNPAID_TTL_MS),
        status: "awaiting_payment"
      });

      return res.json({ ok: true, purchase: rec, serverNow: new Date(nowMs).toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_purchase_request_failed", error: String(err) });
    }
  });

  // User: create a redeem request from the active CW source wallet.
  app.post("/api/v1/bridge/redeem/request", async (req, res) => {
    try {
      const userId = getUserId(res);
      if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const ca = String(body.ca || "").trim().toLowerCase();
      const amountRaw = String(body.amountRaw || "").trim();
      const redeemTo = String(body.redeemTo || "").trim();
      const networkId = normalizeKaspaNetworkKey(body.networkId);
      const sourceWalletAddress = String(body.sourceWalletAddress || "").trim();
      const sourceTransferTxid = String(body.sourceTransferTxid || "").trim();

      if (!ca || !isHex64(ca)) return res.status(400).json({ ok: false, reason: "invalid_ca" });
      if (!amountRaw || !/^\d+$/.test(amountRaw)) return res.status(400).json({ ok: false, reason: "invalid_amount" });
      if (!redeemTo) return res.status(400).json({ ok: false, reason: "invalid_redeem_to" });
      if (!networkId) return res.status(400).json({ ok: false, reason: "invalid_network" });
      if (!sourceWalletAddress) return res.status(400).json({ ok: false, reason: "invalid_source_wallet_address" });
      if (!sourceTransferTxid) return res.status(400).json({ ok: false, reason: "invalid_source_transfer_txid" });

      const cfg = readWrappedConfigV7(ctx.repoRoot);

      const assetsByNetwork =
        cfg &&
        (cfg as any).controlledAssetsByNetwork &&
        (cfg as any).controlledAssetsByNetwork[networkId] &&
        typeof (cfg as any).controlledAssetsByNetwork[networkId] === "object"
          ? (cfg as any).controlledAssetsByNetwork[networkId]
          : null;

      const asset =
        assetsByNetwork &&
        typeof assetsByNetwork[ca] === "object" &&
        assetsByNetwork[ca]
          ? (assetsByNetwork[ca] as Record<string, unknown>)
          : null;

      if (!asset) return res.status(400).json({ ok: false, reason: "bridge_redeem_asset_not_configured" });

      const fireblocks =
        asset.fireblocks && typeof asset.fireblocks === "object"
          ? (asset.fireblocks as Record<string, unknown>)
          : null;

      if (!fireblocks || fireblocks.enabled !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_fireblocks_disabled" });
      }

      const bridgePolicy =
        asset.bridgePolicy && typeof asset.bridgePolicy === "object"
          ? (asset.bridgePolicy as Record<string, unknown>)
          : null;

      const redeemPolicy =
        bridgePolicy &&
        bridgePolicy.redeem &&
        typeof bridgePolicy.redeem === "object"
          ? (bridgePolicy.redeem as Record<string, unknown>)
          : null;

      if (!redeemPolicy || redeemPolicy.enabled !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_policy_disabled" });
      }

      if (redeemPolicy.allowActiveWallet !== true) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_active_wallet_disabled" });
      }

      const amountUnits = BigInt(amountRaw);
      if (amountUnits <= 0n) {
        return res.status(400).json({ ok: false, reason: "invalid_amount" });
      }

      const minAmountRaw =
        typeof redeemPolicy.minAmountRaw === "string" && String(redeemPolicy.minAmountRaw).trim()
          ? String(redeemPolicy.minAmountRaw).trim()
          : undefined;

      if (!minAmountRaw || !/^\d+$/.test(minAmountRaw)) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_min_amount_missing" });
      }

      const minAmountUnits = BigInt(minAmountRaw);
      if (amountUnits < minAmountUnits) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_amount_below_minimum" });
      }

      const redeemFeeBpsSnapshot =
        typeof redeemPolicy.feeBps === "number" &&
        Number.isFinite(redeemPolicy.feeBps) &&
        Number.isInteger(redeemPolicy.feeBps) &&
        redeemPolicy.feeBps >= 0 &&
        redeemPolicy.feeBps <= 10000
          ? Number(redeemPolicy.feeBps)
          : undefined;

      if (typeof redeemFeeBpsSnapshot !== "number") {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_fee_missing" });
      }

      const payoutAmountUnits = (amountUnits * BigInt(10000 - redeemFeeBpsSnapshot)) / 10000n;
      if (payoutAmountUnits <= 0n) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_payout_amount_invalid" });
      }

      const fireblocksInventoryCompositeKeySnapshot =
        typeof fireblocks.inventoryCompositeKey === "string" && String(fireblocks.inventoryCompositeKey).trim()
          ? String(fireblocks.inventoryCompositeKey).trim()
          : undefined;

      const fireblocksVaultAccountIdSnapshot =
        typeof fireblocks.vaultAccountId === "string" && String(fireblocks.vaultAccountId).trim()
          ? String(fireblocks.vaultAccountId).trim()
          : undefined;

      const fireblocksAssetIdSnapshot =
        typeof fireblocks.assetId === "string" && String(fireblocks.assetId).trim()
          ? String(fireblocks.assetId).trim()
          : undefined;

      if (!fireblocksInventoryCompositeKeySnapshot || !fireblocksVaultAccountIdSnapshot || !fireblocksAssetIdSnapshot) {
        return res.status(400).json({ ok: false, reason: "bridge_redeem_mapping_incomplete" });
      }

      const rec = addBridgeRedeem(ctx.repoRoot, {
        userId,
        networkId,
        ca,
        amountRaw,
        redeemTo,
        sourceWalletKind: "cw_active",
        sourceWalletAddress,
        sourceTransferTxid,
        redeemFeeBpsSnapshot,
        payoutAmountRawSnapshot: payoutAmountUnits.toString(),
        fireblocksInventoryCompositeKeySnapshot,
        fireblocksVaultAccountIdSnapshot,
        fireblocksAssetIdSnapshot,
        status: "source_submitted"
      });

      const submit = await submitRedeemToCn(ctx, rec.id);
      const current = readBridgeQueueStore(ctx.repoRoot).redeems.find((x) => x && x.id === rec.id) ?? rec;

      return res.json({ ok: true, redeem: current, submit });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_redeem_request_failed", error: String(err) });
    }
  });

  // Admin: list queue (token-gated).
  app.get("/api/v1/bridge/admin/queue", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const store = normalizeBridgeQueueStore(ctx.repoRoot);
      return res.json({ ok: true, store, serverNow: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_queue_read_failed", error: String(err) });
    }
  });

  // Admin: read raw queue file (token-gated).
  app.get("/api/v1/bridge/admin/queue/raw", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const raw = readBridgeQueueRaw(ctx.repoRoot);
      return res.json({ ok: true, filename: raw.filename, content: raw.content, serverNow: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_queue_raw_read_failed", error: String(err) });
    }
  });

  // Admin: clear queue history (token-gated).
  app.post("/api/v1/bridge/admin/queue/clear", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const cleared = clearBridgeQueueStore(ctx.repoRoot);
      return res.json({ ok: true, ...cleared, serverNow: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_queue_clear_failed", error: String(err) });
    }
  });

  // Admin: list pending fulfillment result artifacts (token-gated).
  app.get("/api/v1/bridge/admin/fulfillment-results", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;

      const fulfillmentBatchId =
        typeof (req.query as any).fulfillmentBatchId === "string"
          ? String((req.query as any).fulfillmentBatchId).trim()
          : (Array.isArray((req.query as any).fulfillmentBatchId) ? String((req.query as any).fulfillmentBatchId[0] || "").trim() : "");

      if (fulfillmentBatchId) {
        const artifact = getBridgeFulfillmentResultArtifact(ctx.repoRoot, fulfillmentBatchId);
        if (!artifact) {
          return res.status(404).json({ ok: false, reason: "bridge_fulfillment_result_not_found" });
        }
        return res.json({ ok: true, artifact, serverNow: new Date().toISOString() });
      }

      const artifacts = listBridgeFulfillmentResultArtifacts(ctx.repoRoot);
      return res.json({ ok: true, artifacts, serverNow: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_fulfillment_results_read_failed", error: String(err) });
    }
  });

  // Admin: consume one pending fulfillment result artifact (token-gated).
  app.post("/api/v1/bridge/admin/fulfillment-results/consume", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const fulfillmentBatchId = String(body.fulfillmentBatchId || "").trim();
      if (!fulfillmentBatchId) {
        return res.status(400).json({ ok: false, reason: "invalid_fulfillment_batch_id" });
      }

      const existing = getBridgeFulfillmentResultArtifact(ctx.repoRoot, fulfillmentBatchId);
      if (!existing) {
        return res.status(404).json({ ok: false, reason: "bridge_fulfillment_result_not_found" });
      }

      const removed = removeBridgeFulfillmentResultArtifact(ctx.repoRoot, fulfillmentBatchId);
      return res.json({
        ok: true,
        fulfillmentBatchId,
        removed,
        serverNow: new Date().toISOString()
      });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "bridge_fulfillment_result_consume_failed", error: String(err) });
    }
  });

  // Admin: update purchase status / fields.
  app.post("/api/v1/bridge/admin/purchase/update", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const id = String(body.id || "").trim();
      const patch = body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : null;
      if (!id) return res.status(400).json({ ok: false, reason: "invalid_id" });
      if (!patch) return res.status(400).json({ ok: false, reason: "invalid_patch" });

      const store = normalizeBridgeQueueStore(ctx.repoRoot);
      const current = store.purchases.find((x) => x && x.id === id) ?? null;
      if (!current) return res.status(404).json({ ok: false, reason: "purchase_not_found" });

      const state = readUserState(ctx.repoRoot, current.userId);
      if (state.account_frozen) {
        return res.status(409).json({ ok: false, reason: "target_user_frozen" });
      }

      const nextPatch: Parameters<typeof updateBridgePurchase>[2] = {};
      const nextPatchKeys = [
        "status",
        "depositChain",
        "depositTxid",
        "depositSender",
        "brokerNotes",
        "fulfillTxid",
        "fulfillmentBatchId",
        "fulfillmentExecutionNonce",
        "fireblocksExternalTxId",
        "fireblocksTxId",
        "fireblocksStatus",
        "fireblocksSubStatus",
        "fireblocksUpdatedAt",
        "fireblocksError",
        "actualPaymentAmountRaw",
        "settlementWrappedAmountRaw"
      ] as const;

      for (const key of nextPatchKeys) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const value = patch[key];
        if (typeof value === "string") nextPatch[key] = value;
      }

      const next = updateBridgePurchase(ctx.repoRoot, id, nextPatch);

      return res.json({ ok: true, purchase: next });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("purchase_not_found")) return res.status(404).json({ ok: false, reason: "purchase_not_found" });
      return res.status(500).json({ ok: false, reason: "bridge_purchase_update_failed", error: msg });
    }
  });

  // Admin: update redeem status / fields.
  app.post("/api/v1/bridge/admin/redeem/update", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const id = String(body.id || "").trim();
      const patch = body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : null;
      if (!id) return res.status(400).json({ ok: false, reason: "invalid_id" });
      if (!patch) return res.status(400).json({ ok: false, reason: "invalid_patch" });

      const store = readBridgeQueueStore(ctx.repoRoot);
      const current = store.redeems.find((x) => x && x.id === id) ?? null;
      if (!current) return res.status(404).json({ ok: false, reason: "redeem_not_found" });

      const state = readUserState(ctx.repoRoot, current.userId);
      if (state.account_frozen) {
        return res.status(409).json({ ok: false, reason: "target_user_frozen" });
      }

      const next = updateBridgeRedeem(ctx.repoRoot, id, {
        status: typeof patch.status === "string" ? patch.status : undefined,
        burnTxid: typeof patch.burnTxid === "string" ? patch.burnTxid : undefined,
        payoutTxid: typeof patch.payoutTxid === "string" ? patch.payoutTxid : undefined,
        brokerNotes: typeof patch.brokerNotes === "string" ? patch.brokerNotes : undefined,
        fireblocksInventoryCompositeKeySnapshot:
          typeof patch.fireblocksInventoryCompositeKeySnapshot === "string" ? patch.fireblocksInventoryCompositeKeySnapshot : undefined,
        fireblocksVaultAccountIdSnapshot:
          typeof patch.fireblocksVaultAccountIdSnapshot === "string" ? patch.fireblocksVaultAccountIdSnapshot : undefined,
        fireblocksAssetIdSnapshot:
          typeof patch.fireblocksAssetIdSnapshot === "string" ? patch.fireblocksAssetIdSnapshot : undefined,
        fireblocksExternalTxId:
          typeof patch.fireblocksExternalTxId === "string" ? patch.fireblocksExternalTxId : undefined,
        fireblocksTxId:
          typeof patch.fireblocksTxId === "string" ? patch.fireblocksTxId : undefined,
        fireblocksStatus:
          typeof patch.fireblocksStatus === "string" ? patch.fireblocksStatus : undefined,
        fireblocksSubStatus:
          typeof patch.fireblocksSubStatus === "string" ? patch.fireblocksSubStatus : undefined,
        fireblocksUpdatedAt:
          typeof patch.fireblocksUpdatedAt === "string" ? patch.fireblocksUpdatedAt : undefined,
        fireblocksError:
          typeof patch.fireblocksError === "string" ? patch.fireblocksError : undefined
      });

      return res.json({ ok: true, redeem: next });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("redeem_not_found")) return res.status(404).json({ ok: false, reason: "redeem_not_found" });
      return res.status(500).json({ ok: false, reason: "bridge_redeem_update_failed", error: msg });
    }
  });
}
