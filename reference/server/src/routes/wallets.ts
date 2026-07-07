import express from "express";
import { generateWalletId, makeWalletRecord, readWalletStore, writeWalletStore } from "../storage/walletStore";
import { readUserProfile, type UserNotificationSettings } from "../storage/userStore";
import { NetworkType as CWNetworkType, WalletType, WalletWhitelistState } from "../types";
import { ensureKaspaReady } from "../kaspaSdk";
import { sendNotificationEmail } from "../email/smtp";
import {
  PublicKey,
  NetworkType as SdkNetworkType
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

function parseNetworkType(value: unknown): CWNetworkType | null {
  if (value === "mainnet" || value === "testnet") return value;
  return null;
}

function toSdkNetwork(network: CWNetworkType): SdkNetworkType {
  return network === "mainnet" ? SdkNetworkType.Mainnet : SdkNetworkType.Testnet;
}

function parseWalletType(value: unknown): WalletType | null {
  if (value === "standard" || value === "compliance") return value;
  return null;
}

function getBody(req: express.Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object") {
    return {};
  }
  return req.body as Record<string, unknown>;
}

function getWalletWhitelistState(wallet: { whitelist?: WalletWhitelistState | null }): WalletWhitelistState {
  const src = wallet && wallet.whitelist ? wallet.whitelist : null;
  const maturityMs = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  function normalizeEntries(input: unknown): Array<{ address: string; added_at: string; removed_at: string | null }> {
    if (!Array.isArray(input)) return [];

    return input
      .filter((row) => row && typeof (row as any).address === "string" && String((row as any).address).trim())
      .map((row) => ({
        address: String((row as any).address).trim(),
        added_at: typeof (row as any).added_at === "string" ? String((row as any).added_at) : "",
        removed_at: typeof (row as any).removed_at === "string" ? String((row as any).removed_at) : null
      }))
      .filter((row) => {
        const removedAt = String(row.removed_at || "").trim();
        if (!removedAt) return true;

        const removedMs = Date.parse(removedAt);
        if (!Number.isFinite(removedMs)) return true;

        return nowMs - removedMs < maturityMs;
      });
  }

  const mainnetEntries =
    src &&
    src.by_network &&
    src.by_network.mainnet
      ? normalizeEntries(src.by_network.mainnet.entries)
      : [];

  const testnetEntries =
    src &&
    src.by_network &&
    src.by_network.testnet
      ? normalizeEntries(src.by_network.testnet.entries)
      : [];

  return {
    by_network: {
      mainnet: { entries: mainnetEntries },
      testnet: { entries: testnetEntries }
    }
  };
}

export function buildWalletRouters(
  repoRoot: string,
  cnHttp: { cnBaseUrl: string; cnTimeoutMs: number }
): {
  apiRouter: express.Router;
  setupRouter: express.Router;
} {
  const apiRouter = express.Router();
  const setupRouter = express.Router();

  function requireUserId(res: express.Response): string {
    const uid = (res.locals as any).td_user_id;
    const userId = typeof uid === "string" ? uid.trim() : "";
    if (!userId) {
      throw new Error("missing_user_id");
    }
    return userId;
  }

  function queueUserNotification(
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

  async function cnGetJson(pathname: string): Promise<{ ok: boolean; status: number; json: any }> {
    const url = `${cnHttp.cnBaseUrl}${pathname}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cnHttp.cnTimeoutMs);
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const json = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, json };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cnPostJson(pathname: string, payload: unknown): Promise<{ ok: boolean; status: number; json: any }> {
    const adminToken = String(process.env.TD_ADMIN_TOKEN || "").trim();
    if (!adminToken) {
      return { ok: false, status: 500, json: { ok: false, reason: "admin_token_not_configured" } };
    }

    const url = `${cnHttp.cnBaseUrl}${pathname}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cnHttp.cnTimeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-td-admin-token": adminToken
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const json = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, json };
    } finally {
      clearTimeout(timeout);
    }
  }

  apiRouter.get("/wallets", (_req, res) => {
    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    res.json({
      items: store.items.map((w) => ({ id: w.id, address0: w.address0, wallet_type: w.wallet_type, network: w.network })),
      active_id: store.active_id
    });
  });

  apiRouter.get("/wallet/whitelist", (_req, res) => {
    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    const activeId = store.active_id;
    if (!activeId) {
      return res.json({ ok: false, reason: "no_active_wallet" });
    }

    const active = store.items.find((w) => w.id === activeId) || null;
    if (!active) {
      return res.json({ ok: false, reason: "wallet_not_found" });
    }

    return res.json({
      ok: true,
      wallet_id: active.id,
      active_network: active.network,
      whitelist: getWalletWhitelistState(active)
    });
  });

  apiRouter.post("/wallet/whitelist/add", (req, res) => {
    const body = getBody(req);
    const network = parseNetworkType(body.network);
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!network) {
      return res.json({ ok: false, reason: "invalid_network" });
    }
    if (!address) {
      return res.json({ ok: false, reason: "missing_address" });
    }

    const expectedPrefix = network === "mainnet" ? "kaspa:" : "kaspatest:";
    if (!address.startsWith(expectedPrefix)) {
      return res.json({
        ok: false,
        reason: "invalid_whitelist_address_for_network",
        error: `Whitelist address must start with ${expectedPrefix}`
      });
    }

    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    const activeId = store.active_id;
    if (!activeId) {
      return res.json({ ok: false, reason: "no_active_wallet" });
    }

    const activeIndex = store.items.findIndex((w) => w.id === activeId);
    if (activeIndex < 0) {
      return res.json({ ok: false, reason: "wallet_not_found" });
    }

    const active = store.items[activeIndex];
    const whitelist = getWalletWhitelistState(active);
    const bucket = network === "mainnet"
      ? whitelist.by_network.mainnet
      : whitelist.by_network.testnet;

    const nowIso = new Date().toISOString();
    const existingIndex = bucket.entries.findIndex((row) => row.address === address);

    if (existingIndex >= 0) {
      bucket.entries[existingIndex] = {
        address,
        added_at: nowIso,
        removed_at: null
      };
    } else {
      bucket.entries.push({
        address,
        added_at: nowIso,
        removed_at: null
      });
    }

    store.items[activeIndex] = {
      ...active,
      whitelist
    };
    writeWalletStore(repoRoot, userId, store);

    queueUserNotification(
      userId,
      "whitelist_added",
      "Token Depot — Whitelist address added",
      [
        "A whitelist address was added.",
        "",
        `Wallet ID: ${active.id}`,
        `Network: ${active.network}`,
        `Address: ${address}`
      ].join("\n")
    );

    return res.json({
      ok: true,
      wallet_id: active.id,
      active_network: active.network,
      whitelist
    });
  });

  apiRouter.post("/wallet/whitelist/remove", (req, res) => {
    const body = getBody(req);
    const network = parseNetworkType(body.network);
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!network) {
      return res.json({ ok: false, reason: "invalid_network" });
    }
    if (!address) {
      return res.json({ ok: false, reason: "missing_address" });
    }

    const expectedPrefix = network === "mainnet" ? "kaspa:" : "kaspatest:";
    if (!address.startsWith(expectedPrefix)) {
      return res.json({
        ok: false,
        reason: "invalid_whitelist_address_for_network",
        error: `Whitelist address must start with ${expectedPrefix}`
      });
    }

    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    const activeId = store.active_id;
    if (!activeId) {
      return res.json({ ok: false, reason: "no_active_wallet" });
    }

    const activeIndex = store.items.findIndex((w) => w.id === activeId);
    if (activeIndex < 0) {
      return res.json({ ok: false, reason: "wallet_not_found" });
    }

    const active = store.items[activeIndex];
    const whitelist = getWalletWhitelistState(active);
    const bucket = network === "mainnet"
      ? whitelist.by_network.mainnet
      : whitelist.by_network.testnet;

    const existingIndex = bucket.entries.findIndex((row) => row.address === address);
    if (existingIndex < 0) {
      return res.json({ ok: false, reason: "whitelist_address_not_found" });
    }

    const existing = bucket.entries[existingIndex];
    if (!existing.removed_at) {
      bucket.entries[existingIndex] = {
        ...existing,
        removed_at: new Date().toISOString()
      };
    }

    store.items[activeIndex] = {
      ...active,
      whitelist
    };
    writeWalletStore(repoRoot, userId, store);

    queueUserNotification(
      userId,
      "whitelist_removed",
      "Token Depot — Whitelist address removed",
      [
        "A whitelist address was marked for removal.",
        "",
        `Wallet ID: ${active.id}`,
        `Network: ${active.network}`,
        `Address: ${address}`
      ].join("\n")
    );

    return res.json({
      ok: true,
      wallet_id: active.id,
      active_network: active.network,
      whitelist
    });
  });

  apiRouter.post("/wallet/select", (req, res) => {
    const body = getBody(req);
    const id = body.id;
    if (typeof id !== "string" || !id) {
      return res.json({ ok: false, reason: "missing_id" });
    }

    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    const exists = store.items.some((w) => w.id === id);
    if (!exists) {
      return res.json({ ok: false, reason: "wallet_not_found" });
    }

    store.active_id = id;
    writeWalletStore(repoRoot, userId, store);
    return res.json({ ok: true });
  });

  apiRouter.post("/wallet/delete", (req, res) => {
    const body = getBody(req);
    const id = body.id;
    if (typeof id !== "string" || !id) {
      return res.json({ ok: false, reason: "missing_id" });
    }

    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);
    if (store.active_id === id) {
      return res.json({ ok: false, reason: "active_wallet_cannot_be_deleted" });
    }

    const deletedWallet = store.items.find((w) => w.id === id) || null;
    const before = store.items.length;
    store.items = store.items.filter((w) => w.id !== id);
    const after = store.items.length;

    if (before === after) {
      return res.json({ ok: false, reason: "wallet_not_found" });
    }

    writeWalletStore(repoRoot, userId, store);

    queueUserNotification(
      userId,
      "wallet_deleted",
      "Token Depot — Wallet deleted",
      [
        "A wallet was deleted.",
        "",
        `Wallet ID: ${id}`,
        deletedWallet && typeof deletedWallet.wallet_type === "string" ? `Type: ${deletedWallet.wallet_type}` : "",
        deletedWallet && typeof deletedWallet.network === "string" ? `Network: ${deletedWallet.network}` : "",
        deletedWallet && typeof deletedWallet.address0 === "string" ? `Address: ${deletedWallet.address0}` : ""
      ]
        .filter((line) => line !== "")
        .join("\n")
    );

    return res.json({ ok: true });
  });

setupRouter.post("/wallet", async (req, res) => {
  try {
    const body = getBody(req);
    const auto = body.auto;

    // CB-001 compatibility: older UI used {auto:true}. Keys are now client-generated.
    if (auto === true) {
      return res.json({ ok: false, reason: "client_keygen_required" });
    }

    const wallet_type = parseWalletType(body.wallet_type);
    const network = parseNetworkType(body.network);
    const broker_id = body.broker_id;
    const user_pubkey = body.user_pubkey;
    const wallet_id = body.wallet_id;
    const auth_secret = body.auth_secret;
    const auth_pubkey = body.auth_pubkey;

    if (!wallet_type) {
      return res.json({ ok: false, reason: "wallet_type_invalid" });
    }
    if (!network) {
      return res.json({ ok: false, reason: "network_invalid" });
    }
    if (typeof user_pubkey !== "string" || !/^(02|03)[0-9a-fA-F]{64}$/.test(user_pubkey.trim())) {
      return res.json({ ok: false, reason: "user_pubkey_required" });
    }

    const recovery_mode = typeof body.recovery_mode === "string" ? body.recovery_mode.trim() : "";
    const isStandardRecovery = wallet_type === "standard" && recovery_mode === "standard_import";
    const isComplianceRecovery = wallet_type === "compliance" && recovery_mode === "compliance_recovery";
    const authSecret = typeof auth_secret === "string" ? auth_secret.trim() : "";
    const authPubKey = typeof auth_pubkey === "string" ? auth_pubkey.trim() : "";

    if (wallet_type === "standard" && (authSecret || authPubKey)) {
      return res.json({ ok: false, reason: "auth_secret_not_allowed_for_standard_wallet" });
    }

    if (wallet_type === "compliance") {
      if (!isComplianceRecovery && (typeof broker_id !== "string" || broker_id.length < 1)) {
        return res.json({ ok: false, reason: "broker_id_required_for_compliance" });
      }
      if (!isComplianceRecovery) {
        if (!authSecret) {
          return res.json({ ok: false, reason: "auth_secret_required_for_compliance" });
        }
        if (!/^(02|03)[0-9a-fA-F]{64}$/.test(authPubKey)) {
          return res.json({ ok: false, reason: "auth_pubkey_required_for_compliance" });
        }
        if (authPubKey.toLowerCase() !== user_pubkey.trim().toLowerCase()) {
          return res.json({ ok: false, reason: "auth_pubkey_mismatch" });
        }
      }
      if (isComplianceRecovery && (authSecret || authPubKey)) {
        return res.json({ ok: false, reason: "auth_secret_not_allowed_for_compliance_recovery" });
      }
      if (isComplianceRecovery && (typeof wallet_id !== "string" || wallet_id.trim().length < 1)) {
        return res.json({ ok: false, reason: "wallet_id_required_for_compliance_recovery" });
      }
      if (network !== "testnet") {
        return res.json({ ok: false, reason: "bcw_local_dev_testnet_only" });
      }
    }

    await ensureKaspaReady(repoRoot);

    const sdkNetwork = toSdkNetwork(network);
    const userPubKey = user_pubkey.trim();

    let brokerCustodyKeyRef: string | null = null;
    let brokerCustodyPublicKey: string | null = null;
    let bcwWalletId: string | null = null;
    let resolvedBrokerId: string | null = wallet_type === "compliance" && typeof broker_id === "string" ? broker_id.trim() : null;
    let address0: string;

    if (wallet_type === "standard") {
      address0 = new PublicKey(userPubKey).toAddress(sdkNetwork).toString();
    } else if (isComplianceRecovery) {
      const requestedWalletId = typeof wallet_id === "string" ? wallet_id.trim() : "";
      let cnLookup;
      try {
        cnLookup = await cnPostJson("/api/cn/bcw/custody-wallet/lookup", {
          wallet_id: requestedWalletId,
          network
        });
      } catch (err) {
        return res.json({ ok: false, reason: "cn_unreachable", error: String(err) });
      }

      if (!cnLookup.ok || !cnLookup.json || cnLookup.json.ok !== true) {
        return res.json({
          ok: false,
          reason: cnLookup.json && typeof cnLookup.json.reason === "string"
            ? cnLookup.json.reason
            : "bcw_custody_lookup_failed",
          status: cnLookup.status,
          error: cnLookup.json && typeof cnLookup.json.error === "string" ? cnLookup.json.error : undefined
        });
      }

      if (cnLookup.json.wallet_id !== requestedWalletId) {
        return res.json({ ok: false, reason: "bcw_custody_wallet_id_mismatch" });
      }
      if (cnLookup.json.network !== network) {
        return res.json({ ok: false, reason: "bcw_custody_network_mismatch" });
      }
      if (cnLookup.json.signer_state !== "ACTIVE" || cnLookup.json.state !== "ACTIVE") {
        return res.json({ ok: false, reason: "bcw_custody_wallet_not_active" });
      }

      const recoveredAddress = typeof cnLookup.json.address0 === "string" ? String(cnLookup.json.address0).trim() : "";
      const recoveredPublicKey = typeof cnLookup.json.public_key === "string" ? String(cnLookup.json.public_key).trim() : "";
      const recoveredKeyRef = typeof cnLookup.json.key_ref === "string" ? String(cnLookup.json.key_ref).trim() : "";
      const recoveredBrokerId = typeof cnLookup.json.broker_id === "string" ? String(cnLookup.json.broker_id).trim() : "";

      if (!recoveredAddress || !recoveredAddress.startsWith("kaspatest:")) {
        return res.json({ ok: false, reason: "bcw_custody_address_invalid" });
      }
      if (!/^(02|03)[0-9a-fA-F]{64}$/.test(recoveredPublicKey)) {
        return res.json({ ok: false, reason: "bcw_custody_public_key_invalid" });
      }
      if (!/^BCWKEY_[a-f0-9]{32}$/.test(recoveredKeyRef)) {
        return res.json({ ok: false, reason: "bcw_custody_key_ref_invalid" });
      }
      if (!recoveredBrokerId) {
        return res.json({ ok: false, reason: "bcw_custody_broker_id_invalid" });
      }

      address0 = recoveredAddress;
      brokerCustodyPublicKey = recoveredPublicKey;
      brokerCustodyKeyRef = recoveredKeyRef;
      bcwWalletId = requestedWalletId;
      resolvedBrokerId = recoveredBrokerId;
    } else {
      const requestedWalletId = generateWalletId();
      let cnProvision;
      try {
        cnProvision = await cnPostJson("/api/cn/bcw/custody-wallet/create", {
          wallet_id: requestedWalletId,
          network,
          broker_id: String(broker_id || "").trim(),
          auth_secret: authSecret,
          auth_pubkey: authPubKey
        });
      } catch (err) {
        return res.json({ ok: false, reason: "cn_unreachable", error: String(err) });
      }

      if (!cnProvision.ok || !cnProvision.json || cnProvision.json.ok !== true) {
        return res.json({
          ok: false,
          reason: cnProvision.json && typeof cnProvision.json.reason === "string"
            ? cnProvision.json.reason
            : "bcw_custody_provision_failed",
          status: cnProvision.status,
          error: cnProvision.json && typeof cnProvision.json.error === "string" ? cnProvision.json.error : undefined
        });
      }

      if (cnProvision.json.wallet_id !== requestedWalletId) {
        return res.json({ ok: false, reason: "bcw_custody_wallet_id_mismatch" });
      }
      if (cnProvision.json.network !== network) {
        return res.json({ ok: false, reason: "bcw_custody_network_mismatch" });
      }
      if (cnProvision.json.custody_model !== "broker_1of1") {
        return res.json({ ok: false, reason: "bcw_custody_model_invalid" });
      }
      if (cnProvision.json.signer_provider !== "LOCAL_DEV_ONLY" || cnProvision.json.signer_state !== "ACTIVE") {
        return res.json({ ok: false, reason: "bcw_custody_signer_not_active" });
      }

      const provisionedAddress = typeof cnProvision.json.address0 === "string" ? String(cnProvision.json.address0).trim() : "";
      const provisionedPublicKey = typeof cnProvision.json.public_key === "string" ? String(cnProvision.json.public_key).trim() : "";
      const provisionedKeyRef = typeof cnProvision.json.key_ref === "string" ? String(cnProvision.json.key_ref).trim() : "";

      if (!provisionedAddress || !provisionedAddress.startsWith("kaspatest:")) {
        return res.json({ ok: false, reason: "bcw_custody_address_invalid" });
      }
      if (!/^(02|03)[0-9a-fA-F]{64}$/.test(provisionedPublicKey)) {
        return res.json({ ok: false, reason: "bcw_custody_public_key_invalid" });
      }
      if (!/^BCWKEY_[a-f0-9]{32}$/.test(provisionedKeyRef)) {
        return res.json({ ok: false, reason: "bcw_custody_key_ref_invalid" });
      }

      address0 = provisionedAddress;
      brokerCustodyPublicKey = provisionedPublicKey;
      brokerCustodyKeyRef = provisionedKeyRef;
      bcwWalletId = requestedWalletId;
    }

    const userId = requireUserId(res);
    const store = readWalletStore(repoRoot, userId);

    if (isStandardRecovery || isComplianceRecovery) {
      const existing = store.items.find((w) =>
        w.wallet_type === wallet_type &&
        w.network === network &&
        ((isStandardRecovery && typeof w.address0 === "string" && w.address0 === address0) ||
          (isComplianceRecovery && typeof w.id === "string" && w.id === bcwWalletId))
      ) || null;

      if (existing) {
        if (isComplianceRecovery) {
          existing.broker_id = resolvedBrokerId;
          existing.user_auth_pubkey = userPubKey;
          existing.broker_custody_key_ref = brokerCustodyKeyRef;
          existing.custody_model = "broker_1of1";
        } else {
          existing.user_pubkey = userPubKey;
        }
        existing.address0 = address0;
        existing.state = "READY";
        store.active_id = existing.id;
        writeWalletStore(repoRoot, userId, store);

        return res.json({
          ok: true,
          address0: existing.address0,
          wallet_id: existing.id,
          recovered: true,
          created: false
        });
      }
    }

    const record = makeWalletRecord({
      wallet_type,
      network,
      broker_id: wallet_type === "compliance" ? resolvedBrokerId : null,
      wallet_id: bcwWalletId,
      custody_model: wallet_type === "compliance" ? "broker_1of1" : undefined,
      broker_custody_key_ref: wallet_type === "compliance" ? brokerCustodyKeyRef : undefined,
      user_auth_pubkey: wallet_type === "compliance" ? userPubKey : undefined
    });

    if (wallet_type === "compliance") {
      record.user_auth_pubkey = userPubKey;
      record.broker_custody_key_ref = brokerCustodyKeyRef;
      record.custody_model = "broker_1of1";
    } else {
      record.user_pubkey = userPubKey;
    }
    record.address0 = address0;
    record.state = "READY";

    store.items.push(record);
    if (isStandardRecovery || isComplianceRecovery) {
      store.active_id = record.id;
    } else if (!store.active_id) {
      store.active_id = record.id;
    }
    writeWalletStore(repoRoot, userId, store);

    if (isStandardRecovery || isComplianceRecovery) {
      return res.json({
        ok: true,
        address0: record.address0,
        wallet_id: record.id,
        recovered: true,
        created: true
      });
    }

    queueUserNotification(
      userId,
      wallet_type === "standard" ? "wallet_created_standard" : "wallet_created_compliance",
      wallet_type === "standard"
        ? "Token Depot — New standard wallet created"
        : "Token Depot — New compliance wallet created",
      [
        wallet_type === "standard"
          ? "A new standard wallet was created."
          : "A new compliance wallet was created.",
        "",
        `Wallet ID: ${record.id}`,
        `Network: ${record.network}`,
        `Address: ${record.address0}`
      ].join("\n")
    );

    return res.json({
      ok: true,
      address0: record.address0,
      wallet_id: record.id,
      custody_model: record.custody_model || null,
      broker_custody_key_ref: record.broker_custody_key_ref || null,
      broker_custody_public_key: brokerCustodyPublicKey
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      reason: "wallet_create_failed",
      error: String(err)
    });
  }
});

  return { apiRouter, setupRouter };
}
