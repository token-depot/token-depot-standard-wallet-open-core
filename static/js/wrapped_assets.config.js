// Server-authoritative configuration.
// Single source of truth for tokens and vaults: /api/v1/wrapped-config

export const TD_WRAPPED_CONFIG_API_PATH = "/api/v1/wrapped-config";

let _tdConfigLoaded = false;

export let TD_WRAPPED_CONFIG = {
  version: 7,
  defaults: {
    kaspaNetwork: "tn10",
    evmNetwork: "mainnet",
    evmVaultId: "evm_mainnet_default"
  },
  manualRedemptionSlaText: "",
  kaspaNetworks: {},
  evmNetworks: {},
  vaults: {},
  erc20Tokens: {},
  controlledAssetsByNetwork: {},
  issuance: {
    deployerByNetwork: {},
    metaByNetwork: {}
  }
};

function _tdSafeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function _tdCanonicalizeConfig(raw) {
  const fallback = {
    version: 7,
    defaults: {
      kaspaNetwork: "tn10",
      evmNetwork: "mainnet",
      evmVaultId: "evm_mainnet_default"
    },
    manualRedemptionSlaText: "",
    kaspaNetworks: {},
    evmNetworks: {},
    vaults: {},
    erc20Tokens: {},
    controlledAssetsByNetwork: {},
    issuance: {
      deployerByNetwork: {},
      metaByNetwork: {}
    }
  };

  const obj = (raw && typeof raw === "object") ? raw : {};
  const out = { ...fallback, ...obj };

  const v = out.version;
  out.version = (typeof v === "number" && Number.isFinite(v)) ? v : 7;

  const d0 = (out.defaults && typeof out.defaults === "object") ? out.defaults : {};
  out.defaults = {
    kaspaNetwork: String(d0.kaspaNetwork || fallback.defaults.kaspaNetwork).trim() || fallback.defaults.kaspaNetwork,
    evmNetwork: String(d0.evmNetwork || fallback.defaults.evmNetwork).trim() || fallback.defaults.evmNetwork,
    evmVaultId: String(d0.evmVaultId || fallback.defaults.evmVaultId).trim() || fallback.defaults.evmVaultId
  };

  out.manualRedemptionSlaText = String(out.manualRedemptionSlaText || "").trim();

  if (!out.kaspaNetworks || typeof out.kaspaNetworks !== "object") out.kaspaNetworks = {};
  if (!out.evmNetworks || typeof out.evmNetworks !== "object") out.evmNetworks = {};
  if (!out.vaults || typeof out.vaults !== "object") out.vaults = {};
  if (!out.erc20Tokens || typeof out.erc20Tokens !== "object") out.erc20Tokens = {};
  if (!out.controlledAssetsByNetwork || typeof out.controlledAssetsByNetwork !== "object") out.controlledAssetsByNetwork = {};

  const iss0 = (out.issuance && typeof out.issuance === "object") ? out.issuance : {};
  const dep0 = (iss0.deployerByNetwork && typeof iss0.deployerByNetwork === "object") ? iss0.deployerByNetwork : {};
  const meta0 = (iss0.metaByNetwork && typeof iss0.metaByNetwork === "object") ? iss0.metaByNetwork : {};
  out.issuance = { ...iss0, deployerByNetwork: dep0, metaByNetwork: meta0 };

  const nextControlled = {};
  for (const [netId0, bucketAny] of Object.entries(out.controlledAssetsByNetwork)) {
    if (!bucketAny || typeof bucketAny !== "object") continue;
    const bucket = bucketAny;
    const b = {};
    for (const [k0, entryAny] of Object.entries(bucket)) {
      if (!entryAny || typeof entryAny !== "object") continue;
      const ca = String(entryAny.ca || k0 || "").trim();
      if (!ca) continue;
      b[ca.toLowerCase()] = entryAny;
    }
    const netId = String(netId0 || "").trim();
    if (netId) nextControlled[netId] = b;
  }
  out.controlledAssetsByNetwork = nextControlled;

  // Strip legacy keys to prevent drift on save.
  const legacyKeys = [
    "default" + "KaspaNetwork",
    "evm" + "Rpc",
    "evm" + "Rpcs",
    "approved" + "EvmAssets",
    "approved" + "Pairs",
    "allow" + "ListByNetwork",
    "krc20" + "DeployerByNetwork",
    "krc20" + "MetaByNetwork"
  ];
  for (const k of legacyKeys) {
    if (Object.prototype.hasOwnProperty.call(out, k)) delete out[k];
  }

  return out;
}

function _tdNetId(raw) {
  const s = String(raw || "").trim();
  const lc = s.toLowerCase();

  if (lc === "mainnet") return "mainnet";
  if (lc === "testnet-10" || lc === "testnet10" || lc === "tn10" || lc === "tn-10") return "tn10";
  if (lc === "testnet-11" || lc === "testnet11" || lc === "tn11" || lc === "tn-11") return "tn11";

  return s || "mainnet";
}

function _tdRequireLoaded() {
  if (!_tdConfigLoaded) throw new Error("wrapped_config_not_loaded");
}

// (v7) no approved-pairs layer; controlledAssetsByNetwork + vaults are canonical.

function _tdNormEntry(raw) {
  if (!raw || typeof raw !== "object") return null;

  const ca = String(raw.ca || "").trim();
  if (!ca) return null;

  const name = String(raw.name || "").trim();
  const assetRef = String(raw.assetRef || "").trim();
  const decimals = (raw.decimals === null || raw.decimals === undefined) ? null : Number(raw.decimals);

  const vault = raw.vault && typeof raw.vault === "object"
    ? {
      chain: String(raw.vault.chain || "").trim(),
      address: String(raw.vault.address || "").trim()
    }
    : null;

  return {
    ca,
    name,
    assetRef,
    decimals,
    vault,
    delivery: raw.delivery ? String(raw.delivery).trim() : ""
  };
}

export async function loadWrappedConfigFromServer() {
  const url =
    (typeof window !== "undefined")
      ? new URL(TD_WRAPPED_CONFIG_API_PATH, window.location.href).toString()
      : TD_WRAPPED_CONFIG_API_PATH;

  const timeoutMs = 8000;
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json" },
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (t) clearTimeout(t);
  }

  const text = await res.text();
  const parsed = _tdSafeParse(text);

  if (!res.ok || !parsed || typeof parsed !== "object") {
    throw new Error(`wrapped_config_http_${res.status}`);
  }

  TD_WRAPPED_CONFIG = _tdCanonicalizeConfig(parsed);
  _tdConfigLoaded = true;
  return TD_WRAPPED_CONFIG;
}

export async function saveWrappedConfigToServer(next, adminToken) {
  const token = String(adminToken || "").trim();
  if (!token) throw new Error("admin_token_required");

  const url =
    (typeof window !== "undefined")
      ? new URL(TD_WRAPPED_CONFIG_API_PATH, window.location.href).toString()
      : TD_WRAPPED_CONFIG_API_PATH;

  const payload = _tdCanonicalizeConfig(next);

  const timeoutMs = 8000;
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-td-admin-token": token
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (t) clearTimeout(t);
  }

  const text = await res.text();
  const parsed = _tdSafeParse(text);

  if (!res.ok || !parsed || typeof parsed !== "object") {
    throw new Error(`wrapped_config_save_http_${res.status}`);
  }

  TD_WRAPPED_CONFIG = _tdCanonicalizeConfig(parsed);
  _tdConfigLoaded = true;
  return TD_WRAPPED_CONFIG;
}

export function listWrappedAllowListEntries(networkId) {
  _tdRequireLoaded();

  const netId = _tdNetId(networkId);
  const bucket = TD_WRAPPED_CONFIG?.controlledAssetsByNetwork?.[netId] || null;

  const vaults = TD_WRAPPED_CONFIG && TD_WRAPPED_CONFIG.vaults && typeof TD_WRAPPED_CONFIG.vaults === "object"
    ? TD_WRAPPED_CONFIG.vaults
    : {};

  const out = [];
  if (bucket && typeof bucket === "object") {
    for (const v of Object.values(bucket)) {
      if (!v || typeof v !== "object") continue;

      const ca = String(v.ca || "").trim();
      if (!ca) continue;

      const name = String(v.name || "").trim();
      const assetRef = String(v.assetRef || v.erc20Symbol || "").trim();
      const decimals = (v.decimals === null || v.decimals === undefined) ? null : Number(v.decimals);

      const vaultId = String(v.vaultId || "").trim();
      const vv = vaultId ? vaults[vaultId] : null;

      const vault = (vv && typeof vv === "object")
        ? { chain: String(vv.chain || "").trim(), address: String(vv.address || "").trim() }
        : null;

      out.push({
        ca,
        name,
        assetRef,
        decimals,
        vault,
        delivery: v.delivery ? String(v.delivery).trim() : ""
      });
    }
  }

  return out;
}

export function getWrappedCaSet(networkId) {
  const set = new Set();
  for (const e of listWrappedAllowListEntries(networkId)) {
    if (e?.ca) set.add(String(e.ca).toLowerCase());
  }
  return set;
}

export function isWrappedCa(networkId, ca) {
  const c = String(ca || "").trim().toLowerCase();
  if (!c) return false;
  return getWrappedCaSet(networkId).has(c);
}
