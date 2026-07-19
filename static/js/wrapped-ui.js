// Compliance Wallet — Wrapped UI (CW Wrap v1)
//
// Purpose (CB-WRAP-01):
//  - Require an active CW wallet via GET /api/wallet/status
//  - Load server wrapped-config via GET /api/v1/wrapped-config
//  - Apply field gates (pair selection, KRC address, EVM sender address)
//  - Start/stop an EVM monitor (ERC-20 Transfer logs sender->vault) from "Start Monitor"
//  - When a deposit is detected, compute deltaRaw and enable "Issue via CW"
//  - For CB-WRAP-01, clicking "Issue via CW" renders a ready-to-issue receipt payload (NO mint call yet)
//    because the exact /api/v1/krc20/issue request schema must be pinned from local route code first.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const UI = {
    activityBox: $("activityBox"),
    assetRows: $("assetRows"),

    buyPair: $("buyPair"),
    buyAmount: $("buyAmount"),
    buyEvmSender: $("buyEvmSender"),
    buyKrcReceive: $("buyKrcReceive"),

    buySummary: $("buySummary"),
    buyCostBox: $("buyCostBox"),

    btnStartBuyMonitor: $("btnStartBuyMonitor"),
    btnStopBuyMonitor: $("btnStopBuyMonitor"),
    btnClearSession: $("btnClearSession"),
    btnClearActivity: $("btnClearActivity"),
    btnBuyIssueSend: $("btnBuyIssueSend"),
    buyIssueStatus: $("buyIssueStatus"),

    redeemReceipt: $("redeemReceipt"),
    redeemAsset: $("redeemAsset"),
    redeemAmount: $("redeemAmount"),
    redeemToEvm: $("redeemToEvm"),
    btnStartRedeemMonitor: $("btnStartRedeemMonitor"),
    btnStopRedeemMonitor: $("btnStopRedeemMonitor"),

    kaspaNet: $("kaspaNet"),
    adminToken: $("adminToken"),
    chownCa: $("chownCa"),
    chownTo: $("chownTo"),
    btnChown: $("btnChown"),
    chownResult: $("chownResult"),
  };

  const S = {
    walletStatus: null,
    cfg: null,
    kaspaNetKey: "",
    kaspaAddrPrefix: "",

    monitor: {
      running: false,
      timer: null,
      lastError: "",
      // Selected pair resolution:
      mode: "", // "evm" | ""
      wrappedCa: "",
      wrappedName: "",
      evmNetKey: "",
      evmNetRpcUrl: "",
      evmTokenContract: "",
      vaultEvmAddress: "",
      senderEvmAddress: "",
      startBlockHex: "",
      observedDeltaRaw: 0n,
      lastLogCount: 0,
    },

    redeem: {
      running: false,
      timer: null,
      lastOpScore: null,
      expected: null,
    },
  };

  function setText(el, t) {
    if (!el) return;
    el.textContent = t == null ? "" : String(t);
  }

  const ACTIVITY_KEY = "cw_wrap_activity_v1";

  function nowIso() { return new Date().toISOString(); }

  function restoreActivityBox() {
    const prev = sessionStorage.getItem(ACTIVITY_KEY) || "";
    const box = UI.activityBox;
    if (box) box.textContent = prev;
  }

  function appendActivityLine(line) {
    const prev = sessionStorage.getItem(ACTIVITY_KEY) || "";
    const next = (prev ? prev + "\n" : "") + line;
    sessionStorage.setItem(ACTIVITY_KEY, next);
    const box = UI.activityBox;
    if (box) box.textContent = next;
  }

  function htmlToText(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html || "");
    return String(tmp.textContent || "").replace(/\s+/g, " ").trim();
  }

  function log(html, cls) {
    try {
      const msg = htmlToText(html);
      if (!msg) return;
      const tag = String(cls || "").toLowerCase().includes("error") ? " ERROR" : "";
      appendActivityLine(`[${nowIso()}]${tag} ${msg}`);
    } catch (_) {}
  }

  async function httpJson(method, url, body) {
    const init = {
      method,
      headers: { accept: "application/json" },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) {
      const msg = (data && (data.error || data.message)) || `${r.status} ${r.statusText}`;
      const e = new Error(msg);
      e.payload = data;
      throw e;
    }
    return data;
  }

  function promptPasswordOrThrow(label) {
    const pw = window.prompt(String(label || "Wallet password:"));
    const s = pw != null ? String(pw) : "";
    if (!s) throw new Error("password_required");
    return s;
  }

  function isEvmAddress(a) {
    return /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());
  }

  const KEYRING_SESSION_KEY = "cw_keyring_session";

  function getKeyringSessionOrNull() {
    let ksTxt = "";
    try { ksTxt = sessionStorage.getItem(KEYRING_SESSION_KEY) || ""; } catch (_) { ksTxt = ""; }
    if (!ksTxt) return null;
    try { return JSON.parse(ksTxt); } catch (_) { return null; }
  }

  function getKeyringPriv0HexOrThrow() {
    const ks = getKeyringSessionOrNull();
    const priv0Hex = ks && typeof ks.priv0_hex === "string" ? String(ks.priv0_hex).trim() : "";
    if (!priv0Hex) throw new Error("keyring_locked");
    return priv0Hex;
  }

  function readKeyringSessionOrThrow() {
    const raw = sessionStorage.getItem(KEYRING_SESSION_KEY);
    if (!raw) throw new Error("Unlock your keyfile on the Wallet page first (same tab).");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") throw new Error("Bad keyring session");
    if (typeof obj.priv0_hex !== "string" || !obj.priv0_hex.trim()) throw new Error("Keyring missing priv0");
    if (typeof obj.wallet_id !== "string" || !obj.wallet_id.trim()) throw new Error("Keyring missing wallet_id");
    return obj;
  }

  function clearKeyringSession() {
    try { sessionStorage.removeItem(KEYRING_SESSION_KEY); } catch (_) {}
  }

  function getNetworkSharedOrThrow() {
    const shared = window.CwNetworkShared;
    if (
      !shared ||
      typeof shared.getNetworkMeta !== "function" ||
      typeof shared.normalizeAppNetworkKey !== "function"
    ) {
      throw new Error("network_shared_missing");
    }
    return shared;
  }

  function getNetworkMetaOrThrow(raw) {
    const meta = getNetworkSharedOrThrow().getNetworkMeta(raw);
    if (!meta || !meta.appKey) throw new Error("invalid_network");
    return meta;
  }

  function toAddrNetworkFromNetworkId(networkId) {
    const label = String(getNetworkMetaOrThrow(networkId).walletNetworkLabel || "").trim();
    if (!label) throw new Error("invalid_network");
    return label;
  }

  async function requireUnlockedKeyringOrThrow(k, activeNetworkId) {
    const sess = getKeyringSessionOrNull();
    if (!sess || Number(sess.v || 0) !== 1) throw new Error("keyfile_locked");

    let me = null;
    try {
      me = await httpJson("GET", "/api/v1/session/me");
    } catch (_) {
      clearKeyringSession();
      throw new Error("auth_required");
    }

    const userId = me && me.ok === true && me.user_id ? String(me.user_id).trim() : "";
    if (!userId) {
      clearKeyringSession();
      throw new Error("auth_required");
    }

    if (String(sess.user_id || "").trim() !== userId) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const st = await httpJson("GET", "/api/wallet/status");
    if (!st || !st.ok) {
      clearKeyringSession();
      throw new Error("no_active_wallet");
    }

    const walletType = String(st.wallet_type || "").trim();
    const walletId = String(st.wallet_id || "").trim();
    const addr0Expected = String(st.address0 || "").trim();

    if (!walletId || !addr0Expected) {
      clearKeyringSession();
      throw new Error("no_active_wallet");
    }

    if (String(sess.wallet_id || "").trim() !== walletId) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    if (String(sess.wallet_type || "").trim() !== walletType) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const priv0Hex = String(sess.priv0_hex || "").trim();
    if (!priv0Hex) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const priv0 = new k.PrivateKey(priv0Hex);

    if (walletType === "standard") {
      const addrNet = toAddrNetworkFromNetworkId(activeNetworkId);
      const addr0 = String(priv0.toAddress(addrNet).toString());
      if (addr0 !== addr0Expected) {
        clearKeyringSession();
        throw new Error("keyfile_locked");
      }
      return { walletType, priv0, addr0 };
    }

    return { walletType, priv0, addr0: addr0Expected };
  }

  async function kaspaReadyOrThrow() {
    if (!window.kaspaReady || typeof window.kaspaReady.then !== "function") {
      try { await import("/static/js/kaspa-bridge.mjs"); } catch (_) {}
    }
    if (!window.kaspaReady || typeof window.kaspaReady.then !== "function") {
      throw new Error("kaspa_not_ready");
    }
    await window.kaspaReady;
    if (!window.kaspa) throw new Error("kaspa_not_loaded");
    return window.kaspa;
  }

  function sleep(ms) {
    const n = Number(ms || 0);
    const d = Number.isFinite(n) && n > 0 ? n : 0;
    return new Promise((resolve) => setTimeout(resolve, d));
  }

  function normalizeKaspaPrefixFromStatus(st) {
    try {
      const prefix = String(getNetworkMetaOrThrow(st && st.network).addressPrefix || "").trim();
      if (prefix) return prefix;
    } catch (_) {}
    return "kaspa";
  }

  function isKaspaAddressForPrefix(addr, prefix) {
    const a = String(addr || "").trim();
    const p = String(prefix || "").trim();
    if (!a || !p) return false;
    if (!a.startsWith(p + ":")) return false;
    // Soft structural check: avoid guessing full bech32 rules client-side.
    if (a.length < (p.length + 1 + 20)) return false;
    return true;
  }

  function kaspaNet() {
    const cfg = S.cfg;
    const nets = cfg && cfg.kaspaNetworks && typeof cfg.kaspaNetworks === "object" ? cfg.kaspaNetworks : {};
    return nets && nets[S.kaspaNetKey] ? nets[S.kaspaNetKey] : null;
  }

  function kasplexBaseUrl() {
    const n = kaspaNet();
    return String(n && (n.kasplexBaseUrl || n.kasplex_base_url || "") ? (n.kasplexBaseUrl || n.kasplex_base_url) : "").trim();
  }

  function issuerKaspaAddress() {
    const n = kaspaNet();
    return String(n && (n.issuerKaspaAddress || n.issuer_kaspa_address || "") ? (n.issuerKaspaAddress || n.issuer_kaspa_address) : "").trim();
  }

  function inventoryKaspaAddress() {
    const cfg = S.cfg;
    const b = cfg && cfg.bridge && typeof cfg.bridge === "object" ? cfg.bridge : null;
    const m = b && b.inventoryKaspaAddressByNetwork && typeof b.inventoryKaspaAddressByNetwork === "object" ? b.inventoryKaspaAddressByNetwork : {};
    const v = m && S.kaspaNetKey ? m[S.kaspaNetKey] : "";
    return String(v || "").trim();
  }

  function normalizeDecimalString(s) {
    let t = String(s ?? "").trim();
    if (!t) return "";
    if (/^\.\d+$/.test(t)) t = "0" + t;
    if (!/^\d+(\.\d+)?$/.test(t)) return "";
    const parts = t.split(".");
    const i0 = parts[0] || "0";
    const f0 = parts.length > 1 ? (parts[1] || "") : null;
    const i = i0.replace(/^0+(?=\d)/, "");
    if (f0 === null) return i;
    const f = f0.replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }

  function parseUnitsDecimal(decStr, decimals) {
    const s = normalizeDecimalString(decStr);
    if (!s) return null;
    const d = Number(decimals);
    if (!Number.isFinite(d) || d < 0) return null;
    const parts = s.split(".");
    const i = parts[0] || "0";
    const f = parts.length > 1 ? (parts[1] || "") : "";
    if (f.length > d) return null;
    const frac = f.padEnd(d, "0");
    const raw = (i + frac).replace(/^0+(?=\d)/, "");
    return raw || "0";
  }

  function disableBuyAll(reason) {
    if (UI.btnStartBuyMonitor) UI.btnStartBuyMonitor.disabled = true;
    if (UI.btnStopBuyMonitor) UI.btnStopBuyMonitor.disabled = true;
    if (UI.btnBuyIssueSend) UI.btnBuyIssueSend.disabled = true;
    setText(UI.buyIssueStatus, reason || "");
  }

  function clearSession() {
    stopMonitor();
    S.monitor.observedDeltaRaw = 0n;
    S.monitor.lastLogCount = 0;
    setText(UI.buyIssueStatus, "");
    setText(UI.buySummary, "");
    setText(UI.buyCostBox, "");
    log(`<article class="card"><h3>Session Cleared</h3><p class="mono">State reset.</p></article>`);
    setBuySummary();
  }

  function getCfgKaspaNet(cfg, netKey) {
    const ks = cfg && cfg.kaspaNetworks && typeof cfg.kaspaNetworks === "object" ? cfg.kaspaNetworks : {};
    return ks && ks[netKey] ? ks[netKey] : null;
  }

  function getCfgControlledAssets(cfg, netKey) {
    const m = cfg && cfg.controlledAssetsByNetwork && typeof cfg.controlledAssetsByNetwork === "object"
      ? cfg.controlledAssetsByNetwork
      : {};

    const bucket = m && m[netKey] ? m[netKey] : [];
    if (Array.isArray(bucket)) return bucket.filter((x) => x && typeof x === "object");

    if (bucket && typeof bucket === "object") {
      return Object.values(bucket).filter((x) => x && typeof x === "object");
    }

    return [];
  }

  function getCfgAllowList(cfg, netKey) {
    return getCfgControlledAssets(cfg, netKey);
  }

  function getCfgVault(cfg, vaultId) {
    const m = cfg && cfg.vaults && typeof cfg.vaults === "object" ? cfg.vaults : {};
    const v = m && m[vaultId] ? m[vaultId] : null;
    return (v && typeof v === "object") ? v : null;
  }

  function kaspaNetLabel(cfg, netKey) {
    const n = getCfgKaspaNet(cfg, netKey);
    return n && n.label ? String(n.label) : String(netKey || "");
  }

  function normalizeKaspaNetKey(cfg, candidate) {
    const raw = String(candidate || "").trim();
    if (!raw) return "";

    try {
      const shared = getNetworkSharedOrThrow();
      const appKey = String(shared.normalizeAppNetworkKey(raw) || "").trim();
      if (!appKey) return "";

      if (getCfgKaspaNet(cfg, appKey)) return appKey;

      const ks = cfg && cfg.kaspaNetworks && typeof cfg.kaspaNetworks === "object" ? cfg.kaspaNetworks : {};
      for (const k of Object.keys(ks)) {
        if (String(shared.normalizeAppNetworkKey(k) || "").trim() === appKey) return k;
      }
    } catch (_) {}

    return "";
  }

  function chooseKaspaNetKey(cfg, st) {
    const fromStatus = normalizeKaspaNetKey(cfg, st && st.network);
    if (fromStatus) return fromStatus;

    const fromCfg = normalizeKaspaNetKey(cfg, cfg && cfg.defaults ? cfg.defaults.kaspaNetwork : "");
    if (fromCfg) return fromCfg;

    const ks = cfg && cfg.kaspaNetworks && typeof cfg.kaspaNetworks === "object" ? cfg.kaspaNetworks : {};
    const firstKey = Object.keys(ks)[0] || "";
    return firstKey || "";
  }

  // (v7) vault resolution uses vaultId -> cfg.vaults; no derived vault layer.

  function activeWalletIssuerAddressLower() {
    const addr = S.walletStatus && typeof S.walletStatus === "object"
      ? String(S.walletStatus.address0 || "").trim().toLowerCase()
      : "";
    return addr;
  }

  function controlledAssetOwnedByActiveWallet(cfg, netKey, ca) {
    const issuer = activeWalletIssuerAddressLower();
    if (!issuer) return false;

    const bucket =
      cfg && typeof cfg === "object" &&
      cfg.issuance && typeof cfg.issuance === "object" &&
      cfg.issuance.deployerByNetwork && typeof cfg.issuance.deployerByNetwork === "object"
        ? cfg.issuance.deployerByNetwork[netKey]
        : null;

    if (!bucket || typeof bucket !== "object") return false;

    const deployer = String(bucket[String(ca || "").trim()] || "").trim().toLowerCase();
    return !!deployer && deployer === issuer;
  }

  function renderControlledAssetsTable(cfg, netKey) {
    const tbody = UI.assetRows;
    if (!tbody) return;

    tbody.innerHTML = "";
    const entries = getCfgControlledAssets(cfg, netKey);

    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const e = {
        name: raw.name,
        ca: raw.ca,
        assetRef: raw.assetRef || raw.erc20Symbol,
        decimals: raw.decimals,
        vaultId: raw.vaultId,
        mode: raw.mode
      };

      if (!controlledAssetOwnedByActiveWallet(cfg, netKey, e.ca)) continue;

      const vaultId =
        String(e.vaultId || "").trim() ||
        (String(e.mode || "").trim() === "evm_erc20" ? String(cfg?.defaults?.evmVaultId || "").trim() : "");

      const v = vaultId ? getCfgVault(cfg, vaultId) : null;
      e.vault = v ? { chain: String(v.chain || "").trim(), address: String(v.address || "").trim() } : null;

      if (!e.vault) continue;

      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.textContent = String(e.name || "");

      const tdCa = document.createElement("td");
      tdCa.textContent = String(e.ca || "");
      tdCa.className = "mono";

      const tdRef = document.createElement("td");
      tdRef.textContent = String(e.assetRef || "");

      const tdNet = document.createElement("td");
      tdNet.textContent = kaspaNetLabel(cfg, netKey);

      const tdDec = document.createElement("td");
      tdDec.textContent = (e.decimals === null || e.decimals === undefined) ? "" : String(e.decimals);

      const tdChain = document.createElement("td");
      tdChain.textContent = String(e?.vault?.chain || "");

      tr.dataset.vaultAddress = String(e?.vault?.address || "");

      tr.appendChild(tdName);
      tr.appendChild(tdCa);
      tr.appendChild(tdRef);
      tr.appendChild(tdNet);
      tr.appendChild(tdDec);
      tr.appendChild(tdChain);

      tbody.appendChild(tr);
    }
  }

  function getCfgEvmNetRpcUrl(cfg, evmNetKey) {
    const m = cfg && cfg.evmNetworks && typeof cfg.evmNetworks === "object" ? cfg.evmNetworks : {};
    const o = m && m[evmNetKey] ? m[evmNetKey] : null;
    const url = o && (o.rpcUrl || o.url || o.rpc || "");
    return String(url || "").trim();
  }

  function resolveSelectedPair(ca) {
    const cfg = S.cfg;
    const netKey = S.kaspaNetKey;

    const ca0 = String(ca || "").trim();
    if (!ca0) return null;

    const m0 = cfg && cfg.controlledAssetsByNetwork && typeof cfg.controlledAssetsByNetwork === "object"
      ? cfg.controlledAssetsByNetwork
      : null;

    const bucket = m0 && m0[netKey] && typeof m0[netKey] === "object" ? m0[netKey] : null;
    if (!bucket) return null;

    const needle = ca0.toLowerCase();
    let hit = bucket[ca0] || bucket[needle] || null;

    if (!hit) {
      for (const v of Object.values(bucket)) {
        if (!v || typeof v !== "object") continue;
        const vca = String(v.ca || "").trim();
        if (vca && vca.toLowerCase() === needle) { hit = v; break; }
      }
    }

    if (!hit || typeof hit !== "object") return null;

    const mode = String(hit.mode || "").trim();
    const wrappedCa = String(hit.ca || ca0).trim();
    const wrappedName = String(hit.name || "WRAPPED").trim() || "WRAPPED";

    if (mode === "evm_erc20") {
      const evmNetKey = String(cfg?.defaults?.evmNetwork || "mainnet").trim() || "mainnet";
      const sym = String(hit.erc20Symbol || hit.assetRef || "").trim();
      const tok = cfg && cfg.erc20Tokens && typeof cfg.erc20Tokens === "object" ? cfg.erc20Tokens[sym] : null;

      const vaultId = String(hit.vaultId || cfg?.defaults?.evmVaultId || "").trim();
      const v = vaultId ? getCfgVault(cfg, vaultId) : null;
      const vault = v ? String(v.address || "").trim() : "";

      return {
        mode: "evm",
        wrappedCa,
        wrappedName,
        evmNetKey,
        evmNetRpcUrl: getCfgEvmNetRpcUrl(cfg, evmNetKey),
        evmTokenContract: String(tok?.contract || "").trim(),
        vaultEvmAddress: vault,
      };
    }

    return {
      mode: "",
      wrappedCa,
      wrappedName,
    };
  }

  function populatePairs() {
    if (!UI.buyPair) return;
    UI.buyPair.innerHTML = "";

    const cfg = S.cfg;
    const netKey = S.kaspaNetKey;

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Select an asset…";
    UI.buyPair.appendChild(opt0);

    const seen = new Set();

    // Allow list entries
    for (const e of getCfgControlledAssets(cfg, netKey)) {
      const ca = String(e?.ca || "").trim();
      const name = String(e?.name || "").trim();
      const ref = String(e?.assetRef || "").trim();
      if (!ca || seen.has(ca)) continue;
      seen.add(ca);

      const o = document.createElement("option");
      o.value = ca;
      o.textContent = name ? `${name}${ref ? " (" + ref + ")" : ""}` : (ref || ca);
      UI.buyPair.appendChild(o);
    }
  }

  function setBuySummary() {
    const ca = UI.buyPair ? String(UI.buyPair.value || "").trim() : "";
    const recv = UI.buyKrcReceive ? String(UI.buyKrcReceive.value || "").trim() : "";
    const sender = UI.buyEvmSender ? String(UI.buyEvmSender.value || "").trim() : "";

    setText(UI.buyIssueStatus, "");
    if (!ca) {
      setText(UI.buySummary, "");
      setText(UI.buyCostBox, "");
      disableBuyAll("");
      return;
    }

    const resolved = resolveSelectedPair(ca);
    const errs = [];

    if (!resolved) errs.push("Selected asset is not available in wrapped config for this network.");
    if (!isKaspaAddressForPrefix(recv, S.kaspaAddrPrefix)) errs.push(`KRC receive address must be a valid ${S.kaspaAddrPrefix}: address.`);

    // CB-WRAP-01 implements EVM monitoring only (ERC-20 Transfer logs sender->vault).
    if (resolved && resolved.mode !== "evm") {
      errs.push("This asset path is not monitored in CB-WRAP-01 (non-EVM monitoring will be added in a later CB).");
    }

    if (resolved && resolved.mode === "evm") {
      if (!resolved.evmNetKey) errs.push("EVM network key is missing in config for this pair.");
      if (!resolved.evmNetRpcUrl) errs.push("EVM RPC URL is not configured for this EVM network.");
      if (!isEvmAddress(sender)) errs.push("EVM sender address (tx.from) must be a valid 0x address.");
      if (!isEvmAddress(resolved.vaultEvmAddress)) errs.push("Vault EVM address is missing/invalid for this pair.");
      if (!isEvmAddress(resolved.evmTokenContract)) errs.push("ERC-20 contract is missing/invalid for this pair.");
    }

    // Render summary
    if (resolved) {
      setText(UI.buySummary, `Wrapping → ${resolved.wrappedName} (CA=${resolved.wrappedCa})`);
      const lines = [];
      if (resolved.mode === "evm") {
        lines.push(`Monitor: ERC-20 Transfer logs (from=${sender}, to vault=${resolved.vaultEvmAddress})`);
        lines.push(`EVM net: ${resolved.evmNetKey}`);
        lines.push(`ERC-20: ${resolved.evmTokenContract}`);
      }
      lines.push(`Deliver to: ${recv}`);
      if (S.monitor.observedDeltaRaw > 0n) {
        lines.push("");
        lines.push(`Observed deposit deltaRaw: ${S.monitor.observedDeltaRaw.toString()}`);
      }
      setText(UI.buyCostBox, lines.join("\n"));
    }

    if (errs.length) {
      setText(UI.buyCostBox, "Fix these issues:\n- " + errs.join("\n- "));
      disableBuyAll("");
      return;
    }

    // Valid → allow starting monitor; issue stays disabled until deposit detected.
    if (UI.btnStartBuyMonitor) UI.btnStartBuyMonitor.disabled = false;
    if (UI.btnStopBuyMonitor) UI.btnStopBuyMonitor.disabled = true;
    if (UI.btnBuyIssueSend) UI.btnBuyIssueSend.disabled = !(S.monitor.observedDeltaRaw > 0n);
  }

  async function evmNetRpcCall(url, method, params) {
    const payload = { jsonrpc: "2.0", id: Date.now(), method, params };
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j && j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)));
    return j ? j.result : null;
  }

  function padTopicAddress(addr) {
    const a = String(addr || "").trim().toLowerCase().replace(/^0x/, "");
    return "0x" + a.padStart(64, "0");
  }

  async function startMonitor() {
    stopMonitor();

    const ca = UI.buyPair ? String(UI.buyPair.value || "").trim() : "";
    const sender = UI.buyEvmSender ? String(UI.buyEvmSender.value || "").trim() : "";
    const resolved = resolveSelectedPair(ca);
    if (!resolved || resolved.mode !== "evm") {
      log(`<article class="card error"><h3>Monitor Not Started</h3><p class="mono">Selected pair is not EVM-monitorable in CB-WRAP-01.</p></article>`);
      setBuySummary();
      return;
    }

    S.monitor.running = true;
    S.monitor.mode = "evm";
    S.monitor.wrappedCa = resolved.wrappedCa;
    S.monitor.wrappedName = resolved.wrappedName;
    S.monitor.evmNetKey = resolved.evmNetKey;
    S.monitor.evmNetRpcUrl = resolved.evmNetRpcUrl;
    S.monitor.evmTokenContract = resolved.evmTokenContract;
    S.monitor.vaultEvmAddress = resolved.vaultEvmAddress;
    S.monitor.senderEvmAddress = sender;
    S.monitor.observedDeltaRaw = 0n;
    S.monitor.lastLogCount = 0;

    if (UI.btnStartBuyMonitor) UI.btnStartBuyMonitor.disabled = true;
    if (UI.btnStopBuyMonitor) UI.btnStopBuyMonitor.disabled = false;
    if (UI.btnBuyIssueSend) UI.btnBuyIssueSend.disabled = true;
    setText(UI.buyIssueStatus, "Monitoring…");

    try {
      const blockHex = await evmNetRpcCall(S.monitor.evmNetRpcUrl, "eth_blockNumber", []);
      S.monitor.startBlockHex = String(blockHex || "0x0");
      log(`<article class="card"><h3>Monitor Started</h3><p class="mono">startBlock=${S.monitor.startBlockHex}</p></article>`);
    } catch (e) {
      S.monitor.lastError = String(e && e.message ? e.message : e);
      log(`<article class="card error"><h3>Monitor Start Failed</h3><p class="mono">${S.monitor.lastError}</p></article>`);
      stopMonitor();
      setBuySummary();
      return;
    }

    // Poll loop
    S.monitor.timer = setInterval(() => {
      pollOnce().catch((e) => {
        S.monitor.lastError = String(e && e.message ? e.message : e);
      });
    }, 8000);

    // Immediate poll
    await pollOnce();
  }

  async function pollOnce() {
    if (!S.monitor.running) return;

    // ERC-20 Transfer event signature:
    // keccak256("Transfer(address,address,uint256)") = 0xddf252ad...
    const TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const fromTopic = padTopicAddress(S.monitor.senderEvmAddress);
    const toTopic = padTopicAddress(S.monitor.vaultEvmAddress);

    const filter = {
      address: S.monitor.evmTokenContract,
      fromBlock: S.monitor.startBlockHex || "0x0",
      toBlock: "latest",
      topics: [TOPIC0, fromTopic, toTopic],
    };

    const logs = await evmNetRpcCall(S.monitor.evmNetRpcUrl, "eth_getLogs", [filter]);
    const arr = Array.isArray(logs) ? logs : [];
    let sum = 0n;

    for (const ev of arr) {
      const dataHex = String(ev && ev.data ? ev.data : "0x0");
      const v = BigInt(dataHex);
      sum += v;
    }

    S.monitor.lastLogCount = arr.length;
    S.monitor.observedDeltaRaw = sum;

    if (sum > 0n) {
      stopMonitor();
      setText(UI.buyIssueStatus, "Deposit detected. Ready to issue.");
      if (UI.btnBuyIssueSend) UI.btnBuyIssueSend.disabled = false;

      log(
        `<article class="card"><h3>Deposit Detected</h3>
          <p class="mono">deltaRaw=${sum.toString()}</p>
          <p class="mono">logs=${arr.length}</p>
        </article>`
      );
    } else {
      setText(UI.buyIssueStatus, `Monitoring… (logs=${arr.length})`);
    }

    setBuySummary();
  }

  function stopMonitor() {
    if (S.monitor.timer) {
      clearInterval(S.monitor.timer);
      S.monitor.timer = null;
    }
    if (S.monitor.running) {
      S.monitor.running = false;
      setText(UI.buyIssueStatus, "");
      log(`<article class="card"><h3>Monitor Stopped</h3><p class="mono">Stopped.</p></article>`);
    }
    if (UI.btnStartBuyMonitor) UI.btnStartBuyMonitor.disabled = false;
    if (UI.btnStopBuyMonitor) UI.btnStopBuyMonitor.disabled = true;
  }

  async function issueViaCW() {
    const recv = UI.buyKrcReceive ? String(UI.buyKrcReceive.value || "").trim() : "";
    const ca = UI.buyPair ? String(UI.buyPair.value || "").trim() : "";
    const resolved = resolveSelectedPair(ca);

    if (!resolved || resolved.mode !== "evm") {
      log(`<article class="card error"><h3>Issue Not Ready</h3><p class="mono">No EVM-wrapped selection.</p></article>`);
      return;
    }

    if (!(S.monitor.observedDeltaRaw > 0n)) {
      log(`<article class="card error"><h3>Issue Not Ready</h3><p class="mono">No observed deposit delta.</p></article>`);
      return;
    }

    if (!recv || !isKaspaAddressForPrefix(recv, S.kaspaAddrPrefix)) {
      log(`<article class="card error"><h3>Issue Not Ready</h3><p class="mono">Receive address missing/invalid for this network.</p></article>`);
      return;
    }

    const proof = {
      mode: "evm_erc20_transfer_logs",
      evmNetKey: S.monitor.evmNetKey,
      sender: S.monitor.senderEvmAddress,
      vault: S.monitor.vaultEvmAddress,
      tokenContract: S.monitor.evmTokenContract,
      startBlock: S.monitor.startBlockHex,
      logCount: S.monitor.lastLogCount,
    };

    const amt = S.monitor.observedDeltaRaw.toString();
    const password = promptPasswordOrThrow("Issuer wallet password:");

    setText(UI.buyIssueStatus, "Submitting issue via CW…");

    const r = await httpJson("POST", "/api/v1/krc20/issue", {
      ca: resolved.wrappedCa,
      to: recv,
      amt,
      password,
      proof,
    });

    if (!r || !r.ok) {
      const reason = r && (r.reason || r.error) ? String(r.reason || r.error) : "issue_failed";
      throw new Error(reason);
    }

    log(
      `<article class="card"><h3>Issue Submitted (CB-WRAP-02)</h3>
        <p class="mono">ca=${escapeHtml(resolved.wrappedCa)}</p>
        <p class="mono">to=${escapeHtml(recv)}</p>
        <p class="mono">amt=${escapeHtml(amt)}</p>
        <p class="mono">txid=${escapeHtml(String(r.txid || ""))}</p>
      </article>`
    );

    S.monitor.observedDeltaRaw = 0n;
    setText(UI.buyIssueStatus, "Issue submitted.");
    setBuySummary();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function clearActivityBox() {
    sessionStorage.removeItem(ACTIVITY_KEY);
    if (!UI.activityBox) return;
    UI.activityBox.textContent = "";
  }

  function getAllowEntryByCa(ca) {
    const want = String(ca || "").trim().toLowerCase();
    if (!want) return null;
    const list = getCfgAllowList(S.cfg, S.kaspaNetKey);
    for (const e of list) {
      const c = String(e && e.ca ? e.ca : "").trim().toLowerCase();
      if (c && c === want) return e;
    }
    return null;
  }

  function getRedeemPolicy(entry) {
    const bridgePolicy = entry && typeof entry.bridgePolicy === "object" ? entry.bridgePolicy : null;
    const redeem = bridgePolicy && redeemInBridgePolicy(bridgePolicy)
      ? bridgePolicy.redeem
      : null;
    return redeem || null;
  }

  function redeemInBridgePolicy(bridgePolicy) {
    return !!(bridgePolicy && typeof bridgePolicy.redeem === "object" && bridgePolicy.redeem);
  }

  function formatBpsPercent(bps) {
    if (!Number.isInteger(bps) || bps < 0) return "";
    const whole = Math.floor(bps / 100);
    const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
    return String(whole) + (frac ? "." + frac : "");
  }

  function formatRawUnits(rawStr, decimals) {
    const raw = String(rawStr || "").trim();
    const d = Number(decimals);
    if (!/^\d+$/.test(raw) || !Number.isFinite(d) || d < 0) return "";
    if (d === 0) return raw.replace(/^0+(?=\d)/, "") || "0";
    const padded = raw.padStart(d + 1, "0");
    const i = (padded.slice(0, -d).replace(/^0+(?=\d)/, "")) || "0";
    const f = padded.slice(-d).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }

  function populateRedeemAssets() {
    if (!UI.redeemAsset) return;
    UI.redeemAsset.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Select a wrapped token…";
    UI.redeemAsset.appendChild(opt0);

    const list = getCfgAllowList(S.cfg, S.kaspaNetKey);
    for (const e of list) {
      const ca = String(e && e.ca ? e.ca : "").trim();
      if (!ca) continue;

      const redeem = getRedeemPolicy(e);
      if (!redeem || redeem.enabled !== true || redeem.allowActiveWallet !== true) continue;

      const name = String(e && e.name ? e.name : "").trim();
      const ref = String(e && e.assetRef ? e.assetRef : "").trim();
      const feeText = redeem && redeem.feeBps != null ? formatBpsPercent(Number(redeem.feeBps)) : "";
      const o = document.createElement("option");
      o.value = ca;
      o.textContent = `${name || "Wrapped"}${ref ? " (" + ref + ")" : ""}${feeText !== "" ? " — fee " + feeText + "%" : ""}`;
      UI.redeemAsset.appendChild(o);
    }
  }

  function stopRedeemMonitor() {
    if (S.redeem.timer) {
      clearInterval(S.redeem.timer);
      S.redeem.timer = null;
    }
    S.redeem.running = false;
    S.redeem.expected = null;
    S.redeem.lastOpScore = null;
  }

  function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      u.set(k, String(v));
    }
    return u.toString();
  }

  async function fetchKrcOplist(baseUrl, params) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    const url = `${base}/krc20/oplist?${qs(params)}`;
    const r = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`krc_oplist_http_${r.status}`);
    return r.json();
  }

  function opScoreBig(op) {
    try { return BigInt(String(op && op.opScore != null ? op.opScore : "0")); } catch { return 0n; }
  }

  function extractAmountRaw(op) {
    const keys = ["amt_raw", "amount_raw", "amtRaw", "amountRaw", "amt", "amount"];
    for (const k of keys) {
      const v = op && op[k] != null ? String(op[k]).trim() : "";
      if (v && /^\d+$/.test(v)) return v;
    }
    return "";
  }

  function extractOpAccept(op) {
    const keys = ["opAccept", "op_accept", "accept", "accepted"];
    for (const k of keys) {
      const v = op && op[k] != null ? String(op[k]).trim() : "";
      if (v) return v;
    }
    return "";
  }

  function extractTxHint(op) {
    const keys = ["txid", "txId", "hash", "hashRev", "transactionId"];
    for (const k of keys) {
      const v = op && op[k] != null ? String(op[k]).trim() : "";
      if (v) return v;
    }
    const cp = op && op.checkpoint != null ? String(op.checkpoint).trim() : "";
    return cp || "";
  }

  async function redeemPollOnce() {
    if (!S.redeem.running || !S.redeem.expected) return { matched: false, tx: "", accept: "", amountRaw: "" };

    const exp = S.redeem.expected;
    const baseUrl = exp.kasplexBaseUrl;
    const address = exp.toAddress;
    const tick = exp.ca;
    const wantRaw = exp.amountRaw;

    const resp = await fetchKrcOplist(baseUrl, { address, tick });
    const results = resp && Array.isArray(resp.result) ? resp.result : [];

    let maxSeen = S.redeem.lastOpScore != null ? BigInt(String(S.redeem.lastOpScore)) : 0n;
    const newOps = [];

    for (const op of results) {
      const s = opScoreBig(op);
      if (s > maxSeen) {
        newOps.push(op);
        if (s > maxSeen) maxSeen = s;
      }
    }

    if (S.redeem.lastOpScore == null) {
      S.redeem.lastOpScore = String(maxSeen);
      return { matched: false, tx: "", accept: "", amountRaw: "" };
    }

    if (!newOps.length) return { matched: false, tx: "", accept: "", amountRaw: "" };

    for (const op of newOps) {
      const amt = extractAmountRaw(op);
      if (amt && wantRaw && amt === wantRaw) {
        const accept = extractOpAccept(op);
        const tx = extractTxHint(op);
        S.redeem.lastOpScore = String(maxSeen);
        if (accept === "1") {
          return { matched: true, tx, accept, amountRaw: amt };
        }
      }
    }

    S.redeem.lastOpScore = String(maxSeen);
    return { matched: false, tx: "", accept: "", amountRaw: "" };
  }

  function updateRedeemPreview() {
    if (!UI.redeemReceipt || !UI.redeemAsset || !UI.redeemAmount || !UI.redeemToEvm || !UI.btnStartRedeemMonitor || !UI.btnStopRedeemMonitor) return;

    const ca = String(UI.redeemAsset.value || "").trim();
    const amtStr = normalizeDecimalString(UI.redeemAmount.value);
    const redeemTo = String(UI.redeemToEvm.value || "").trim();

    const entry = ca ? getAllowEntryByCa(ca) : null;
    const redeem = entry ? getRedeemPolicy(entry) : null;
    const name = String(entry && entry.name ? entry.name : "Wrapped").trim();
    const ref = String(entry && entry.assetRef ? entry.assetRef : "").trim();
    const decimals = entry && entry.decimals != null ? Number(entry.decimals) : NaN;

    const feeBps = redeem && redeem.feeBps != null ? Number(redeem.feeBps) : NaN;
    const minAmountRaw = redeem && typeof redeem.minAmountRaw === "string" ? String(redeem.minAmountRaw).trim() : "";
    const allowActiveWallet = !!(redeem && redeem.allowActiveWallet === true);

    const inv = inventoryKaspaAddress();
    const kb = kasplexBaseUrl();

    const amtRaw = (amtStr && Number.isFinite(decimals)) ? parseUnitsDecimal(amtStr, decimals) : null;

    let minAmountValid = false;
    let belowMin = false;
    try {
      minAmountValid = /^\d+$/.test(minAmountRaw) && BigInt(minAmountRaw) > 0n;
      belowMin = !!(minAmountValid && amtRaw && /^\d+$/.test(amtRaw) && BigInt(amtRaw) < BigInt(minAmountRaw));
    } catch (_) {
      minAmountValid = false;
      belowMin = false;
    }

    let estPayoutRaw = "";
    try {
      if (amtRaw && /^\d+$/.test(amtRaw) && Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 2500) {
        estPayoutRaw = ((BigInt(amtRaw) * (10000n - BigInt(feeBps))) / 10000n).toString();
      }
    } catch (_) {
      estPayoutRaw = "";
    }

    const minAmountDisplay = minAmountValid && Number.isFinite(decimals) ? formatRawUnits(minAmountRaw, decimals) : "";
    const feeText = Number.isInteger(feeBps) ? formatBpsPercent(feeBps) : "";
    const payoutText = Number.isInteger(feeBps) ? formatBpsPercent(10000 - feeBps) : "";
    const estPayoutDisplay = estPayoutRaw && Number.isFinite(decimals) ? formatRawUnits(estPayoutRaw, decimals) : "";

    const errs = [];
    if (!ca) errs.push("Select a wrapped token.");
    if (ca && !entry) errs.push("Selected asset is not available for active-wallet redeem.");
    if (entry && (!redeem || redeem.enabled !== true)) errs.push("Broker redeem policy is not enabled for this asset.");
    if (entry && redeem && !allowActiveWallet) errs.push("Redeem from Active Wallet is not enabled for this asset.");
    if (!amtStr) errs.push("Amount must be a plain decimal string.");
    if (!isEvmAddress(redeemTo)) errs.push("External payout address must be a valid 0x address.");
    if (!inv || !isKaspaAddressForPrefix(inv, S.kaspaAddrPrefix)) errs.push("Broker inventory address missing/invalid in wrapped-config bridge.inventoryKaspaAddressByNetwork for this network.");
    if (!kb) errs.push("kasplexBaseUrl missing in wrapped-config for this network.");
    if (!Number.isFinite(decimals)) errs.push("Token decimals missing in allow-list entry (required to compute raw units).");
    if (entry && redeem && (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 2500)) errs.push("Broker redeem fee is missing/invalid.");
    if (entry && redeem && !minAmountValid) errs.push("Broker redeem minimum is missing/invalid.");
    if (amtStr && Number.isFinite(decimals) && (!amtRaw || !/^\d+$/.test(amtRaw))) errs.push("Amount could not be converted to raw units.");
    if (!errs.length && belowMin) errs.push(`Amount must be at least ${minAmountDisplay || minAmountRaw} (raw=${minAmountRaw}).`);

    if (errs.length) {
      UI.redeemReceipt.textContent = "Fix these issues:\n- " + errs.join("\n- ");
      UI.btnStartRedeemMonitor.disabled = true;
      UI.btnStopRedeemMonitor.disabled = true;
      return;
    }

    UI.redeemReceipt.textContent = [
      `Redeem request (active CW source):`,
      `  Send: ${name}${ref ? " (" + ref + ")" : ""}`,
      `  CA:   ${ca}`,
      `  To broker intake: ${inv}`,
      `  Amt:  ${amtStr} (raw=${amtRaw})`,
      `  Min:  ${minAmountDisplay || "--"} (raw=${minAmountRaw || "--"})`,
      `  Broker fee: ${feeText !== "" ? feeText + "%" : "--"}`,
      `  Estimated payout: ${estPayoutDisplay || "--"}${estPayoutRaw ? " (raw=" + estPayoutRaw + ")" : ""}`,
      `  Estimated payout ratio: ${payoutText !== "" ? payoutText + "%" : "--"}`,
      ``,
      `Payout request:`,
      `  Redeem-to: ${redeemTo}`,
      ``,
      `On submit: this page sends the wrapped CA from the active CW wallet to the broker intake address, records the active CW source wallet address and source transfer txid, and enqueues a redeem record for broker payout submission.`
    ].join("\n");

    UI.btnStartRedeemMonitor.disabled = false;
    UI.btnStopRedeemMonitor.disabled = true;
  }

  async function startRedeemMonitor() {
    if (!UI.redeemAsset || !UI.redeemAmount || !UI.redeemToEvm || !UI.btnStartRedeemMonitor || !UI.btnStopRedeemMonitor) return;

    stopRedeemMonitor();
    updateRedeemPreview();

    const ca = String(UI.redeemAsset.value || "").trim();
    const entry = ca ? getAllowEntryByCa(ca) : null;
    const redeem = entry ? getRedeemPolicy(entry) : null;
    const decimals = entry && entry.decimals != null ? Number(entry.decimals) : NaN;
    const amtStr = normalizeDecimalString(UI.redeemAmount.value);
    const amtRaw = (amtStr && Number.isFinite(decimals)) ? parseUnitsDecimal(amtStr, decimals) : null;

    const feeBps = redeem && redeem.feeBps != null ? Number(redeem.feeBps) : NaN;
    const minAmountRaw = redeem && typeof redeem.minAmountRaw === "string" ? String(redeem.minAmountRaw).trim() : "";
    const allowActiveWallet = !!(redeem && redeem.allowActiveWallet === true);

    const inv = inventoryKaspaAddress();
    const kb = kasplexBaseUrl();

    let minAmountValid = false;
    let belowMin = false;
    try {
      minAmountValid = /^\d+$/.test(minAmountRaw) && BigInt(minAmountRaw) > 0n;
      belowMin = !!(minAmountValid && amtRaw && /^\d+$/.test(amtRaw) && BigInt(amtRaw) < BigInt(minAmountRaw));
    } catch (_) {
      minAmountValid = false;
      belowMin = false;
    }

    if (
      !ca ||
      !entry ||
      !redeem ||
      redeem.enabled !== true ||
      !allowActiveWallet ||
      !amtRaw ||
      !/^\d+$/.test(amtRaw) ||
      !Number.isInteger(feeBps) ||
      feeBps < 0 ||
      feeBps > 2500 ||
      !minAmountValid ||
      belowMin ||
      !inv ||
      !kb
    ) {
      log(`<div><h3>Redeem Not Started</h3><p class="mono">Fix receipt errors first.</p></div>`);
      return;
    }

    let estPayoutRaw = "";
    try {
      estPayoutRaw = ((BigInt(amtRaw) * (10000n - BigInt(feeBps))) / 10000n).toString();
    } catch (_) {
      estPayoutRaw = "";
    }
    const feeText = formatBpsPercent(feeBps);
    const minAmountDisplay = formatRawUnits(minAmountRaw, decimals);
    const estPayoutDisplay = estPayoutRaw ? formatRawUnits(estPayoutRaw, decimals) : "";

    S.redeem.running = true;
    S.redeem.expected = {
      ca,
      amountRaw: amtRaw,
      toAddress: inv,
      kasplexBaseUrl: kb,
    };
    S.redeem.lastOpScore = null;

    UI.btnStartRedeemMonitor.disabled = true;
    UI.btnStopRedeemMonitor.disabled = false;

    // Baseline: capture current max opScore so we only accept NEW ops.
    await redeemPollOnce();

    const k = await kaspaReadyOrThrow();
    const priv0Hex = getKeyringPriv0HexOrThrow();
    const priv0 = new k.PrivateKey(priv0Hex);

    const token = `CA:${ca}`;
    const to = inv;
    const amountRaw = amtRaw;

    const build = await httpJson("POST", "/api/wallet/send", {
      token,
      to,
      amount: amountRaw,
      stage: "krc_commit_build"
    });

    if (!build || build.ok !== true || build.stage !== "krc_commit_build") {
      const msg = build && (build.error || build.reason) ? String(build.error || build.reason) : "krc_commit_build_failed";
      throw new Error(msg);
    }

    const networkId = String(build.networkId || "");
    const fromAddress = String(build.fromAddress || "");
    const feeRate = Number(build.feeRate || 0);
    const commitAmountSompi = BigInt(String(build.commitAmountSompi || "0"));
    const payloadJson = String(build.payloadJson || "");

    if (!networkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n) {
      throw new Error("krc_commit_build_invalid");
    }

    const entriesSafe = Array.isArray(build.entries) ? build.entries : [];
    const entries = entriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || "0")),
      blockDaaScore: BigInt(String(e.blockDaaScore || "0")),
    }));

    const enc = new TextEncoder();

    const pub = priv0.toPublicKey();
    const script = new k.ScriptBuilder()
      .addData(pub.toXOnlyPublicKey().toString())
      .addOp(k.Opcodes.OpCheckSig)
      .addOp(k.Opcodes.OpFalse)
      .addOp(k.Opcodes.OpIf)
      .addData(enc.encode("kasplex"))
      .addI64(0n)
      .addData(enc.encode(payloadJson))
      .addOp(k.Opcodes.OpEndIf);

    const p2shAddrObj = k.addressFromScriptPublicKey(script.createPayToScriptHashScript(), networkId);
    const p2shAddress = p2shAddrObj ? p2shAddrObj.toString() : "";
    if (!p2shAddress) throw new Error("p2sh_address_failed");

    const txOpts = {
      outputs: [{ address: p2shAddress, amount: commitAmountSompi }],
      changeAddress: fromAddress,
      feeRate,
      priorityFee: { amount: 0n, source: k.FeeSource.SenderPays },
      entries,
      networkId
    };

    const commitCreated = await k.createTransactions(txOpts);

    const signedCommit = [];
    for (const ptx of commitCreated.transactions) {
      ptx.sign([priv0], true);
      signedCommit.push(ptx.serializeToSafeJSON());
    }

    const commitSubmitPayload = { token, to, amount: amountRaw, stage: "krc_commit_submit", signed_txs: signedCommit };

    const commitRes = await httpJson("POST", "/api/wallet/send", commitSubmitPayload);
    if (!commitRes || commitRes.ok !== true) {
      const msg = (commitRes && (commitRes.error || commitRes.reason)) ? String(commitRes.error || commitRes.reason) : "krc_commit_submit_failed";
      throw new Error(msg);
    }

    const commitTxids = Array.isArray(commitRes.commitTxids)
      ? commitRes.commitTxids
      : (Array.isArray(commitRes.txids) ? commitRes.txids : []);

    if (!commitTxids || commitTxids.length === 0) {
      throw new Error("commit_txids_missing");
    }

    const waitRes = await httpJson("POST", "/api/wallet/send", {
      token,
      to,
      amount: amountRaw,
      stage: "krc_reveal_wait",
      p2shAddress,
      commitTxids
    });

    if (!waitRes || waitRes.ok !== true || waitRes.stage !== "krc_reveal_wait") {
      const msg = (waitRes && (waitRes.error || waitRes.reason)) ? String(waitRes.error || waitRes.reason) : "krc_reveal_wait_failed";
      throw new Error(msg);
    }

    const ce = waitRes.commitEntry || null;
    if (!ce || !ce.outpoint) throw new Error("commit_entry_missing");

    const commitEntry = {
      outpoint: ce.outpoint,
      scriptPublicKey: ce.scriptPublicKey,
      isCoinbase: !!ce.isCoinbase,
      amount: BigInt(String(ce.amount || "0")),
      blockDaaScore: BigInt(String(ce.blockDaaScore || "0")),
    };

    const wantedTxid = String(ce?.outpoint?.transactionId || "");
    const wantedIdx = Number(ce?.outpoint?.index ?? -1);

    const buildReveal = async (effectiveFeeRate) => {
      const args = {
        priorityEntries: [commitEntry],
        entries: [],
        changeAddress: fromAddress,
        outputs: [],
        feeRate: effectiveFeeRate,
        priorityFee: 0n,
        networkId
      };

      const created = await k.createTransactions(args);
      if (!created.transactions || created.transactions.length !== 1) {
        throw new Error("unexpected_reveal_batch");
      }
      return created.transactions[0];
    };

    const fillRevealInput0OrThrow = async (tx) => {
      const inputIndex = tx.transaction.inputs.findIndex((input) => {
        const op = input && input.previousOutpoint ? input.previousOutpoint : null;
        const tid = op && typeof op.transactionId === "string" ? op.transactionId : "";
        const idx = op && typeof op.index === "number" ? op.index : -1;
        return tid === wantedTxid && idx === wantedIdx;
      });

      if (inputIndex === -1) throw new Error("p2sh_input_not_found");
      if (inputIndex !== 0) throw new Error("p2sh_input_not_input0");

      const signature = await tx.createInputSignature(0, priv0);
      tx.fillInput(0, script.encodePayToScriptHashSignatureScript(signature));
    };

    const tx0 = await buildReveal(feeRate);
    await fillRevealInput0OrThrow(tx0);

    const requiredFee0 = k.calculateTransactionFee(networkId, tx0.transaction);
    if (requiredFee0 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");

    let revealTx = tx0;

    if (revealTx.feeAmount < requiredFee0) {
      const currentFee = revealTx.feeAmount > 0n ? revealTx.feeAmount : 1n;
      const scale = 1000000n;
      const scaled = (requiredFee0 * scale + currentFee - 1n) / currentFee;
      const neededFeeRate = Math.max(1.0, feeRate * (Number(scaled) / 1000000));
      const effectiveFeeRate = Math.max(feeRate, neededFeeRate);

      const tx1 = await buildReveal(effectiveFeeRate);
      await fillRevealInput0OrThrow(tx1);

      const requiredFee1 = k.calculateTransactionFee(networkId, tx1.transaction);
      if (requiredFee1 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");
      if (tx1.feeAmount < requiredFee1) throw new Error("reveal_fee_under_minimum");

      revealTx = tx1;
    }

    const signedReveal = [revealTx.serializeToSafeJSON()];

    const revealRes = await httpJson("POST", "/api/wallet/send", {
      token,
      to,
      amount: amountRaw,
      stage: "krc_reveal_submit",
      signed_txs: signedReveal
    });

    const rSend = revealRes;

    if (!rSend || !rSend.ok) {
      const reason = rSend && (rSend.reason || rSend.error) ? String(rSend.reason || rSend.error) : "redeem_send_failed";
      throw new Error(reason);
    }

    log(`<div><h3>Redeem Sent</h3><p class="mono">txid=${escapeHtml(String(rSend.txid || ""))}</p></div>`);

    const redeemTo = String(UI.redeemToEvm.value || "").trim();

    let queueId = "";
    let enqueueErr = "";
    try {
      const rEnq = await httpJson("POST", "/api/v1/bridge/redeem/request", {
        networkId,
        ca,
        amountRaw: amtRaw,
        redeemTo,
        sourceWalletAddress: fromAddress,
        sourceTransferTxid: String(rSend.txid || "")
      });

      if (rEnq && rEnq.ok && rEnq.redeem && rEnq.redeem.id) {
        queueId = String(rEnq.redeem.id);
      } else {
        enqueueErr = rEnq && (rEnq.reason || rEnq.error) ? String(rEnq.reason || rEnq.error) : "bridge_redeem_enqueue_failed";
      }
    } catch (e) {
      enqueueErr = String(e && e.message ? e.message : e);
    }

    if (queueId) {
      log(`<div><h3>Redeem Enqueued</h3><p class="mono">id=${escapeHtml(queueId)}</p></div>`);
    } else {
      log(`<div><h3>Redeem Enqueue Failed</h3><p class="mono">${escapeHtml(enqueueErr || "unknown")}</p></div>`, "error");
    }

    if (UI.redeemReceipt) {
      UI.redeemReceipt.textContent = [
        `Redeem submitted:`,
        `  CA:   ${ca}`,
        `  To:   ${inv}`,
        `  Amt:  ${amtStr} (raw=${amtRaw})`,
        `  Min:  ${minAmountDisplay || "--"} (raw=${minAmountRaw || "--"})`,
        `  Broker fee: ${feeText !== "" ? feeText + "%" : "--"}`,
        `  Estimated payout: ${estPayoutDisplay || "--"}${estPayoutRaw ? " (raw=" + estPayoutRaw + ")" : ""}`,
        `  From: ${fromAddress}`,
        `  Source tx: ${String(rSend.txid || "")}`,
        queueId ? `  Queue:${queueId}` : `  Queue: (enqueue failed)`,
        ``,
        `Payout request:`,
        `  Redeem-to: ${redeemTo}`,
        ``,
        `Broker submit is gated by the recorded active CW source wallet and source transfer txid.`
      ].join("\n");
    }

    log(`<div><h3>Redeem Monitor Started</h3><p class="mono">watch=${escapeHtml(inv)} ca=${escapeHtml(ca)} amount_raw=${escapeHtml(amtRaw)}</p></div>`);

    S.redeem.timer = setInterval(() => {
      redeemPollOnce().catch((e) => {
        log(`<div><h3>Redeem Monitor Error</h3><p class="mono">${escapeHtml(String(e && e.message ? e.message : e))}</p></div>`, "error");
      });
    }, 10000);
  }

  function clearRedeemSession() {
    stopRedeemMonitor();
    if (UI.redeemReceipt) UI.redeemReceipt.textContent = "";
    if (UI.btnStartRedeemMonitor) UI.btnStartRedeemMonitor.disabled = true;
    if (UI.btnStopRedeemMonitor) UI.btnStopRedeemMonitor.disabled = true;
    updateRedeemPreview();
    log(`<div><h3>Redeem Cleared</h3><p class="mono">State reset.</p></div>`);
  }

  function safeParseJson(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(body || {})
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (j && (j.reason || j.error)) ? JSON.stringify(j) : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return j;
  }

  function setChownResult(text) {
    if (!UI.chownResult) return;
    UI.chownResult.textContent = String(text || "");
  }

  function walletNetToNetId(net0) {
    try {
      return String(getNetworkSharedOrThrow().normalizeAppNetworkKey(net0) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function abbrCa(ca0) {
    const ca = String(ca0 || "").trim();
    if (!ca) return "";
    if (ca.length <= 16) return ca;
    return `${ca.slice(0, 8)}...${ca.slice(-6)}`;
  }

  function isWrappedCaLocal(netId0, ca0) {
    const netId = String(netId0 || "").trim();
    const ca = String(ca0 || "").trim().toLowerCase();
    if (!netId || !ca) return false;

    const m = S.cfg && typeof S.cfg === "object" && S.cfg.controlledAssetsByNetwork
      ? S.cfg.controlledAssetsByNetwork[netId]
      : null;

    if (!m || typeof m !== "object") return false;

    if (m[ca]) return true;

    for (const v of Object.values(m)) {
      if (!v || typeof v !== "object") continue;
      const vca = String(v.ca || "").trim().toLowerCase();
      if (vca && vca === ca) return true;
    }

    return false;
  }

  function metaNameForCaLocal(netId0, ca0) {
    const netId = String(netId0 || "").trim();
    const ca = String(ca0 || "").trim().toLowerCase();
    if (!netId || !ca) return "";

    const bucket =
      S.cfg && typeof S.cfg === "object" &&
      S.cfg.issuance && typeof S.cfg.issuance === "object" &&
      S.cfg.issuance.metaByNetwork && typeof S.cfg.issuance.metaByNetwork === "object"
        ? S.cfg.issuance.metaByNetwork[netId]
        : null;

    if (!bucket || typeof bucket !== "object") return "";

    const rec = bucket[ca] || bucket[String(ca0 || "").trim()] || null;
    if (!rec || typeof rec !== "object") return "";

    return String(rec.name || "").trim();
  }

  function listIssuableEntriesForIssuerWallet(netId0) {
    const netId = String(netId0 || "").trim();
    if (!netId) return [];

    const st = S.walletStatus && typeof S.walletStatus === "object" ? S.walletStatus : null;
    if (!st || !st.ok) return [];

    const walletNetId = walletNetToNetId(st.network);
    if (walletNetId && walletNetId !== netId) return [];

    const issuer = String(st.address0 || "").trim().toLowerCase();
    if (!issuer) return [];

    const bucket =
      S.cfg && typeof S.cfg === "object" &&
      S.cfg.issuance && typeof S.cfg.issuance === "object" &&
      S.cfg.issuance.deployerByNetwork && typeof S.cfg.issuance.deployerByNetwork === "object"
        ? S.cfg.issuance.deployerByNetwork[netId]
        : null;

    if (!bucket || typeof bucket !== "object") return [];

    const out = [];
    for (const [ca0, dep0] of Object.entries(bucket)) {
      const ca = String(ca0 || "").trim();
      if (!ca) continue;

      const dep = String(dep0 || "").trim().toLowerCase();
      if (!dep || dep !== issuer) continue;

      out.push({
        ca,
        name: metaNameForCaLocal(netId, ca) || "Issue-Mode"
      });
    }

    out.sort((a, b) => String(a.ca).localeCompare(String(b.ca)));
    return out;
  }

  function renderChownSelect() {
    if (!UI.chownCa) return;
    const netId = String(UI.kaspaNet && UI.kaspaNet.value ? UI.kaspaNet.value : "").trim();

    UI.chownCa.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Select a token…";
    UI.chownCa.appendChild(opt0);

    const entries = listIssuableEntriesForIssuerWallet(netId);
    for (const e of entries) {
      const opt = document.createElement("option");
      opt.value = String(e.ca || "").trim();
      opt.textContent = `${String(e.name || "TOKEN").trim()} (${abbrCa(String(e.ca || "").trim())})`;
      UI.chownCa.appendChild(opt);
    }
  }

  async function doChown() {
    const netId = String(UI.kaspaNet && UI.kaspaNet.value ? UI.kaspaNet.value : "").trim();
    const ca = String(UI.chownCa && UI.chownCa.value ? UI.chownCa.value : "").trim();
    const to = String(UI.chownTo && UI.chownTo.value ? UI.chownTo.value : "").trim();

    if (!netId) { setChownResult("Select a Kaspa network."); return; }
    if (!ca) { setChownResult("Select a CA."); return; }
    if (!to) { setChownResult("Enter destination (to) address."); return; }

    setChownResult("Building…");

    const k = await kaspaReadyOrThrow();
    const keyring = await requireUnlockedKeyringOrThrow(k, netId);
    const priv0 = keyring.priv0;

    const build = await postJson("/api/v1/krc20/chown", { stage: "chown_commit_build", netId, ca, to });

    if (build && build.ok === true && build.stage === "bcw_krc20_chown_intent") {
      if (!keyring || !keyring.priv0) throw new Error("wallet_locked");
      if (typeof k.signMessage !== "function") throw new Error("signMessage_unavailable");

      const intent = build.intent && typeof build.intent === "object" ? build.intent : null;
      const intentMessage = String(build.intent_message || "").trim();
      if (!intent || !intentMessage) throw new Error("bcw_krc20_chown_intent_invalid");

      const authSignature = k.signMessage({
        message: intentMessage,
        privateKey: keyring.priv0
      });

      setChownResult("Submitting broker-custody chown intent…");

      const submitRes = await postJson("/api/v1/krc20/chown", {
        stage: "chown_commit_submit",
        netId,
        ca,
        to,
        bcw_krc20_chown_intent: intent,
        bcw_auth_signature: String(authSignature || "")
      });

      if (!submitRes || submitRes.ok !== true) {
        const msg = (submitRes && (submitRes.error || submitRes.message || submitRes.reason)) || "BCW chown submit failed";
        throw new Error(msg);
      }

      setChownResult(JSON.stringify(submitRes, null, 2));
      log(`<article class="card"><h3>Broker-custody chown submitted</h3><p class="mono">net=${escapeHtml(netId)} ca=${escapeHtml(ca)} to=${escapeHtml(to)}</p></article>`);
      return;
    }

    if (!build || build.ok !== true || build.stage !== "chown_commit_build") throw new Error("chown_commit_build_failed");

    const networkId = String(build.networkId || "");
    const fromAddress = String(build.fromAddress || "");
    const feeRate = Number(build.feeRate || 0);
    const commitAmountSompi = BigInt(String(build.commitAmountSompi || "0"));
    const payloadJson = String(build.payloadJson || "");

    if (!networkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n) throw new Error("chown_commit_build_invalid");

    const entriesSafe = Array.isArray(build.entries) ? build.entries : [];
    const entries = entriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || "0")),
      blockDaaScore: BigInt(String(e.blockDaaScore || "0")),
    }));

    const enc = new TextEncoder();
    const pub = priv0.toPublicKey();
    const script = new k.ScriptBuilder()
      .addData(pub.toXOnlyPublicKey().toString())
      .addOp(k.Opcodes.OpCheckSig)
      .addOp(k.Opcodes.OpFalse)
      .addOp(k.Opcodes.OpIf)
      .addData(enc.encode("kasplex"))
      .addI64(0n)
      .addData(enc.encode(payloadJson))
      .addOp(k.Opcodes.OpEndIf);

    const p2shAddrObj = k.addressFromScriptPublicKey(script.createPayToScriptHashScript(), networkId);
    const p2shAddress = p2shAddrObj ? p2shAddrObj.toString() : "";
    if (!p2shAddress) throw new Error("p2sh_address_failed");

    const txOpts = {
      outputs: [{ address: p2shAddress, amount: commitAmountSompi }],
      changeAddress: fromAddress,
      feeRate,
      priorityFee: { amount: 0n, source: k.FeeSource.SenderPays },
      entries,
      networkId
    };

    const commitCreated = await k.createTransactions(txOpts);

    setChownResult("Signing commit…");

    const signed_commit = [];
    for (const ptx of commitCreated.transactions) {
      ptx.sign([priv0], true);
      signed_commit.push(ptx.serializeToSafeJSON());
    }

    setChownResult("Submitting commit…");

    const commitSubmitPayload = { stage: "chown_commit_submit", netId, ca, to, signed_txs: signed_commit };

    const commitRes = await postJson("/api/v1/krc20/chown", commitSubmitPayload);
    const commitTxids = commitRes && Array.isArray(commitRes.commitTxids) ? commitRes.commitTxids : [];
    if (!commitRes || commitRes.ok !== true || commitTxids.length === 0) throw new Error("commit_submit_failed");

    setChownResult("Waiting for commit UTXO…");

    const waitRes = await postJson("/api/v1/krc20/chown", { stage: "chown_reveal_wait", netId, ca, to, p2shAddress, commitTxids });
    if (!waitRes || waitRes.ok !== true || waitRes.stage !== "chown_reveal_wait") throw new Error("reveal_wait_failed");

    const ce = waitRes.commitEntry || null;
    if (!ce || !ce.outpoint) throw new Error("commit_entry_missing");

    const commitEntry = {
      outpoint: ce.outpoint,
      scriptPublicKey: ce.scriptPublicKey,
      isCoinbase: !!ce.isCoinbase,
      amount: BigInt(String(ce.amount || "0")),
      blockDaaScore: BigInt(String(ce.blockDaaScore || "0")),
    };

    const wantedTxid = String(ce?.outpoint?.transactionId || "");
    const wantedIdx = Number(ce?.outpoint?.index ?? -1);

    const revealPriorityFeeSompi = BigInt(String(waitRes.revealPriorityFeeSompi || "0"));

    const revealEntriesSafe = Array.isArray(waitRes.entries) ? waitRes.entries : [];
    const revealEntries = revealEntriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || "0")),
      blockDaaScore: BigInt(String(e.blockDaaScore || "0")),
    }));

    const buildReveal = async (effectiveFeeRate) => {
      const args = {
        priorityEntries: [commitEntry],
        entries: revealEntries,
        changeAddress: fromAddress,
        outputs: [],
        feeRate: effectiveFeeRate,
        priorityFee: revealPriorityFeeSompi,
        networkId
      };

      const created = await k.createTransactions(args);
      if (!created.transactions || created.transactions.length !== 1) throw new Error("unexpected_reveal_batch");
      return created.transactions[0];
    };

    const fillRevealOrThrow = async (tx) => {
      const inputIndex = tx.transaction.inputs.findIndex((input) => {
        const op = input && input.previousOutpoint ? input.previousOutpoint : null;
        const tid = op && typeof op.transactionId === "string" ? op.transactionId : "";
        const idx = op && typeof op.index === "number" ? op.index : -1;
        return tid === wantedTxid && idx === wantedIdx;
      });

      if (inputIndex === -1) throw new Error("p2sh_input_not_found");
      if (inputIndex !== 0) throw new Error("p2sh_input_not_input0");

      const signature = await tx.createInputSignature(0, priv0);
      tx.fillInput(0, script.encodePayToScriptHashSignatureScript(signature));
      for (let i = 1; i < tx.transaction.inputs.length; i++) {
        tx.signInput(i, priv0);
      }
    };

    setChownResult("Signing reveal…");

    const tx0 = await buildReveal(feeRate);
    await fillRevealOrThrow(tx0);

    const requiredFee0 = k.calculateTransactionFee(networkId, tx0.transaction);
    if (requiredFee0 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");

    let revealTx = tx0;

    if (revealTx.feeAmount < requiredFee0) {
      const currentFee = revealTx.feeAmount > 0n ? revealTx.feeAmount : 1n;
      const scale = 1000000n;
      const scaled = (requiredFee0 * scale + currentFee - 1n) / currentFee;
      const neededFeeRate = Math.max(1.0, feeRate * (Number(scaled) / 1000000));
      const effectiveFeeRate = Math.max(feeRate, neededFeeRate);

      const tx1 = await buildReveal(effectiveFeeRate);
      await fillRevealOrThrow(tx1);

      const requiredFee1 = k.calculateTransactionFee(networkId, tx1.transaction, minSig);
      if (requiredFee1 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");
      if (tx1.feeAmount < requiredFee1) throw new Error("reveal_fee_under_minimum");

      revealTx = tx1;
    }

    setChownResult("Submitting reveal…");

    const revealRes = await postJson("/api/v1/krc20/chown", { stage: "chown_reveal_submit", netId, ca, to, signed_txs: [revealTx.serializeToSafeJSON()] });
    setChownResult(JSON.stringify(revealRes, null, 2));
    log(`<article class="card"><h3>Chown submitted</h3><p class="mono">net=${escapeHtml(netId)} ca=${escapeHtml(ca)} to=${escapeHtml(to)}</p></article>`);
  }

  async function boot() {
    restoreActivityBox();
    const hasBuyUI = !!(UI.buyPair && UI.buyKrcReceive && UI.buyEvmSender && UI.btnStartBuyMonitor && UI.btnBuyIssueSend);
    const hasRedeemUI = !!(UI.redeemAsset && UI.redeemAmount && UI.redeemToEvm && UI.redeemReceipt && UI.btnStartRedeemMonitor && UI.btnStopRedeemMonitor);
    const hasBrokerUI = !!(UI.assetRows || UI.chownCa || UI.btnChown);

    if (!hasBuyUI && !hasRedeemUI && !hasBrokerUI) {
      log(`<article class="card error"><h3>Wrapped UI Missing Elements</h3><p class="mono">No supported UI found for wrapped-ui.js.</p></article>`);
      return;
    }

    // Require active wallet
    let st = null;
    try { st = await httpJson("GET", "/api/wallet/status"); } catch (_) { st = null; }
    if (!st || !st.ok) {
      disableBuyAll("No active wallet. Open the main CW page and create/select a wallet first.");
      log(`<article class="card error"><h3>No Active Wallet</h3><p class="mono">Open CW, create/select a wallet, then reload.</p></article>`);
      return;
    }
    S.walletStatus = st;
    S.kaspaAddrPrefix = normalizeKaspaPrefixFromStatus(st);

    // Load wrapped config
    const cfg = await httpJson("GET", "/api/v1/wrapped-config");
    S.cfg = cfg;

    S.kaspaNetKey = chooseKaspaNetKey(cfg, S.walletStatus);
    const kn = getCfgKaspaNet(cfg, S.kaspaNetKey);
    const prefixFromCfg = String(kn && kn.addressPrefix ? kn.addressPrefix : "").trim();
    if (prefixFromCfg) S.kaspaAddrPrefix = prefixFromCfg;

    if (UI.kaspaNet) UI.kaspaNet.value = S.kaspaNetKey;
    if (UI.chownCa) renderChownSelect();

    renderControlledAssetsTable(cfg, S.kaspaNetKey);

    if (hasBuyUI) {
      populatePairs();

      // Wire events
      UI.buyPair.addEventListener("change", setBuySummary);
      UI.buyKrcReceive.addEventListener("input", setBuySummary);
      UI.buyEvmSender.addEventListener("input", setBuySummary);
      if (UI.buyAmount) UI.buyAmount.addEventListener("input", setBuySummary);

      UI.btnStartBuyMonitor.addEventListener("click", () => startMonitor().catch((e) => {
        log(`<article class="card error"><h3>Monitor Error</h3><p class="mono">${escapeHtml(String(e && e.message ? e.message : e))}</p></article>`);
        stopMonitor();
        setBuySummary();
      }));

      UI.btnStopBuyMonitor.addEventListener("click", () => {
        stopMonitor();
        setBuySummary();
      });

      UI.btnBuyIssueSend.addEventListener("click", () => {
        issueViaCW().catch((e) => {
          log(`<div><h3>Issue Failed</h3><p class="mono">${escapeHtml(String(e && e.message ? e.message : e))}</p></div>`, "error");
          setText(UI.buyIssueStatus, "Issue failed.");
        });
        setBuySummary();
      });
    }

    if (hasRedeemUI) {
      populateRedeemAssets();

      UI.redeemAsset.addEventListener("change", updateRedeemPreview);
      UI.redeemAmount.addEventListener("input", updateRedeemPreview);
      UI.redeemToEvm.addEventListener("input", updateRedeemPreview);

      UI.btnStartRedeemMonitor.addEventListener("click", () => {
        startRedeemMonitor().catch((e) => {
          log(`<div><h3>Redeem Start Failed</h3><p class="mono">${escapeHtml(String(e && e.message ? e.message : e))}</p></div>`, "error");
          stopRedeemMonitor();
          updateRedeemPreview();
        });
      });

      UI.btnStopRedeemMonitor.addEventListener("click", () => clearRedeemSession());
    }

    if (UI.btnChown) UI.btnChown.addEventListener("click", () => doChown().catch((e) => {
      setChownResult(`Error: ${String(e && e.message ? e.message : e)}`);
    }));

    if (UI.btnClearSession) UI.btnClearSession.addEventListener("click", clearSession);
    if (UI.btnClearActivity) UI.btnClearActivity.addEventListener("click", clearActivityBox);

    log(`<article class="card"><h3>UI Ready</h3><p class="mono">Active wallet: ${escapeHtml(st.wallet_id)} (${escapeHtml(st.wallet_type)}, ${escapeHtml(String(st.network || ""))})</p></article>`);
    if (hasBuyUI) setBuySummary();
    if (hasRedeemUI) updateRedeemPreview();
  }

  boot().catch((e) => {
    log(`<article class="card error"><h3>Boot Failed</h3><p class="mono">${escapeHtml(String(e && e.message ? e.message : e))}</p></article>`);
  });
})();
