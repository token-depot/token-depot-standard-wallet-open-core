import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function storePathV7(repoRoot: string): string {
  return path.join(repoRoot, "data", "wrapped-config.v7.json");
}

function storePathV1(repoRoot: string): string {
  return path.join(repoRoot, "data", "wrapped-config.v1.json");
}

function safeParseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath: string, obj: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const body = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
}

export type IssuanceMetaEntry = {
  name: string | null;
  tick: string | null;
  decimals: number | null;
  max: string | null;
  lim: string | null;
  pre: string | null;

  source: "deploy" | "import";
  status: "active" | "archived";

  confirmationStatus: "pending_external_confirmation" | "resolved";

  ownerAddress: string | null;

  commitTxId: string | null;
  revealTxId: string | null;

  createdAtMs: number;
  updatedAtMs: number;
  confirmedAtMs: number | null;
};

export type WrappedConfigV7 = {
  version: number;

  defaults: {
    kaspaNetwork: string;
    evmNetwork: string;
    evmVaultId: string;
  };

  manualRedemptionSlaText: string;

  publicSite: {
    publicPageSkinId: PublicPageSkinId;
  };

  kaspaNetworks: Record<string, any>;
  evmNetworks: Record<string, any>;
  vaults: Record<string, {
    chain?: string;
    address?: string;
    nativeSymbol?: string;
    nativeDecimals?: number | null;
    [k: string]: any;
  }>;
  erc20Tokens: Record<string, any>;

  controlledAssetsByNetwork: Record<string, any>;

  issuance: {
    deployerByNetwork: Record<string, Record<string, string>>;
    metaByNetwork: Record<string, Record<string, IssuanceMetaEntry>>;
  };
};

export type WrappedConfigV1 = {
  version: number;
  defaultKaspaNetwork: string;
  manualRedemptionSlaText: string;
  kaspaNetworks: Record<string, any>;
  evmRpc: Record<string, any>;
  approvedEvmAssets: any[];
  approvedPairs: any[];
  allowListByNetwork: Record<string, any>;
  krc20DeployerByNetwork?: Record<string, any>;
  krc20MetaByNetwork?: Record<string, any>;
  evmRpcs?: Record<string, any>;
};

function migratedPathV1(repoRoot: string): string {
  return path.join(repoRoot, "data", "wrapped-config.v1.migrated.json");
}

function normalizeCaKey(ca0: unknown): string {
  return String(ca0 ?? "").trim().toLowerCase();
}

export const PUBLIC_PAGE_SKIN_IDS = [
  "classic_teal",
  "pink",
  "pink_black",
  "gold",
  "gold_black",
  "blue",
  "blue_black",
  "green",
  "green_black",
  "red",
  "red_black",
  "yellow",
  "yellow_black",
  "cyan",
  "cyan_black",
  "orange",
  "orange_black"
] as const;

export type PublicPageSkinId = typeof PUBLIC_PAGE_SKIN_IDS[number];

export function normalizePublicPageSkinId(value: unknown, fallback: PublicPageSkinId = "classic_teal"): PublicPageSkinId {
  const s = String(value ?? "").trim();
  return (PUBLIC_PAGE_SKIN_IDS as readonly string[]).includes(s) ? (s as PublicPageSkinId) : fallback;
}

function normalizeKaspaNetworkId(value: unknown, fallback = "tn10"): string {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "mainnet") return "mainnet";
  if (/^tn\d+$/.test(s)) return s;
  if (/^testnet-\d+$/.test(s)) return `tn${s.slice("testnet-".length)}`;
  return fallback;
}

function trimmedStringOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function finiteNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function timestampMsOrNull(v: unknown): number | null {
  const n = finiteNumberOrNull(v);
  if (n === null || n < 0) return null;
  return Math.trunc(n);
}

function canonicalizeIssuanceMetaEntry(raw: any): IssuanceMetaEntry {
  const obj = raw && typeof raw === "object" ? raw : {};

  const commitTxId = trimmedStringOrNull(obj.commitTxId);
  const revealTxId = trimmedStringOrNull(obj.revealTxId);

  const sourceRaw = String(obj.source ?? "").trim();
  const source: "deploy" | "import" =
    sourceRaw === "deploy" || sourceRaw === "import"
      ? sourceRaw
      : (commitTxId || revealTxId ? "deploy" : "import");

  const statusRaw = String(obj.status ?? "").trim();
  const status: "active" | "archived" =
    statusRaw === "active" || statusRaw === "archived"
      ? statusRaw
      : "active";

  const confirmationRaw = String(obj.confirmationStatus ?? "").trim();
  const confirmationStatus: "pending_external_confirmation" | "resolved" =
    confirmationRaw === "pending_external_confirmation" || confirmationRaw === "resolved"
      ? confirmationRaw
      : "resolved";

  const createdAtMs = timestampMsOrNull(obj.createdAtMs) ?? 0;
  const updatedAtMs = timestampMsOrNull(obj.updatedAtMs) ?? createdAtMs;

  return {
    name: trimmedStringOrNull(obj.name),
    tick: trimmedStringOrNull(obj.tick),
    decimals: finiteNumberOrNull(obj.decimals),
    max: trimmedStringOrNull(obj.max),
    lim: trimmedStringOrNull(obj.lim),
    pre: trimmedStringOrNull(obj.pre),

    source,
    status,

    confirmationStatus,

    ownerAddress: trimmedStringOrNull(obj.ownerAddress),

    commitTxId,
    revealTxId,

    createdAtMs,
    updatedAtMs,
    confirmedAtMs: timestampMsOrNull(obj.confirmedAtMs)
  };
}

export function canonicalizeWrappedConfigV7(raw: any): WrappedConfigV7 {
  const fallback: WrappedConfigV7 = {
    version: 7,
    defaults: {
      kaspaNetwork: "tn10",
      evmNetwork: "mainnet",
      evmVaultId: "evm_mainnet_default"
    },
    manualRedemptionSlaText: "",
    publicSite: {
      publicPageSkinId: "classic_teal"
    },
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

  const obj = raw && typeof raw === "object" ? raw : {};
  const out: any = { ...fallback, ...obj };

  out.version = typeof out.version === "number" && Number.isFinite(out.version) ? out.version : 7;

  out.defaults = out.defaults && typeof out.defaults === "object" ? out.defaults : {};
  out.defaults.kaspaNetwork = normalizeKaspaNetworkId(out.defaults.kaspaNetwork, fallback.defaults.kaspaNetwork);
  out.defaults.evmNetwork = String(out.defaults.evmNetwork || fallback.defaults.evmNetwork).trim() || fallback.defaults.evmNetwork;
  out.defaults.evmVaultId = String(out.defaults.evmVaultId || fallback.defaults.evmVaultId).trim() || fallback.defaults.evmVaultId;

  out.manualRedemptionSlaText = String(out.manualRedemptionSlaText || "").trim();

  out.publicSite = out.publicSite && typeof out.publicSite === "object" ? out.publicSite : {};
  out.publicSite.publicPageSkinId = normalizePublicPageSkinId(out.publicSite.publicPageSkinId);

  if (!out.kaspaNetworks || typeof out.kaspaNetworks !== "object") out.kaspaNetworks = {};
  if (!out.evmNetworks || typeof out.evmNetworks !== "object") out.evmNetworks = {};
  if (!out.vaults || typeof out.vaults !== "object") out.vaults = {};
  if (!out.erc20Tokens || typeof out.erc20Tokens !== "object") out.erc20Tokens = {};
  if (!out.controlledAssetsByNetwork || typeof out.controlledAssetsByNetwork !== "object") out.controlledAssetsByNetwork = {};

  const nextControlledAssetsByNetwork: Record<string, Record<string, any>> = {};
  for (const [netId0, bAny] of Object.entries(out.controlledAssetsByNetwork)) {
    if (!bAny || typeof bAny !== "object") continue;

    const netId = String(netId0 ?? "").trim();
    if (!netId) continue;

    const nextBucket: Record<string, any> = {};
    for (const [ca0, vAny] of Object.entries(bAny as Record<string, unknown>)) {
      if (!vAny || typeof vAny !== "object") continue;

      const v: any = { ...(vAny as any) };
      const caKey = normalizeCaKey(v.ca || ca0);
      if (!caKey) continue;

      v.ca = caKey;
      v.assetRef = String(v.assetRef || "").trim();

      if (!v.assetRef && v.fireblocks && typeof v.fireblocks === "object") {
        const mappedAssetRef = String((v.fireblocks as any).assetId || "").trim();
        if (mappedAssetRef) v.assetRef = mappedAssetRef;
      }

      nextBucket[caKey] = v;
    }

    if (Object.keys(nextBucket).length > 0) {
      nextControlledAssetsByNetwork[netId] = nextBucket;
    }
  }
  out.controlledAssetsByNetwork = nextControlledAssetsByNetwork;

  const nextVaults: Record<string, any> = {};
  for (const [vaultId0, vAny] of Object.entries(out.vaults)) {
    if (!vAny || typeof vAny !== "object") continue;

    const vaultId = String(vaultId0 || "").trim();
    if (!vaultId) continue;

    const v: any = { ...vAny };
    v.chain = String(v.chain || "").trim();
    v.address = String(v.address || "").trim();

    if (Object.prototype.hasOwnProperty.call(v, "nativeSymbol")) {
      v.nativeSymbol = String(v.nativeSymbol || "").trim();
    }

    if (Object.prototype.hasOwnProperty.call(v, "nativeDecimals")) {
      const n = (v.nativeDecimals === null || v.nativeDecimals === undefined) ? null : Number(v.nativeDecimals);
      v.nativeDecimals = (n === null) ? null : (Number.isFinite(n) ? n : null);
    }

    nextVaults[vaultId] = v;
  }
  out.vaults = nextVaults;

  out.issuance = out.issuance && typeof out.issuance === "object" ? out.issuance : {};

  const deployerByNetwork = out.issuance.deployerByNetwork && typeof out.issuance.deployerByNetwork === "object"
    ? out.issuance.deployerByNetwork
    : {};
  const nextDeployerByNetwork: Record<string, Record<string, string>> = {};

  for (const [netId0, bAny] of Object.entries(deployerByNetwork)) {
    if (!bAny || typeof bAny !== "object") continue;

    const netId = String(netId0 ?? "").trim();
    if (!netId) continue;

    const nextBucket: Record<string, string> = {};
    for (const [ca0, v] of Object.entries(bAny as Record<string, unknown>)) {
      const caKey = normalizeCaKey(ca0);
      if (!caKey) continue;

      const addr = String(v ?? "").trim();
      if (!addr) continue;

      nextBucket[caKey] = addr;
    }

    if (Object.keys(nextBucket).length > 0) {
      nextDeployerByNetwork[netId] = nextBucket;
    }
  }

  const metaByNetwork = out.issuance.metaByNetwork && typeof out.issuance.metaByNetwork === "object"
    ? out.issuance.metaByNetwork
    : {};
  const nextMetaByNetwork: Record<string, Record<string, IssuanceMetaEntry>> = {};

  for (const [netId0, bAny] of Object.entries(metaByNetwork)) {
    if (!bAny || typeof bAny !== "object") continue;

    const netId = String(netId0 ?? "").trim();
    if (!netId) continue;

    const nextBucket: Record<string, IssuanceMetaEntry> = {};
    for (const [ca0, vAny] of Object.entries(bAny as Record<string, unknown>)) {
      const caKey = normalizeCaKey(ca0);
      if (!caKey) continue;

      nextBucket[caKey] = canonicalizeIssuanceMetaEntry(vAny);
    }

    if (Object.keys(nextBucket).length > 0) {
      nextMetaByNetwork[netId] = nextBucket;
    }
  }

  out.issuance.deployerByNetwork = nextDeployerByNetwork;
  out.issuance.metaByNetwork = nextMetaByNetwork;

  return out as WrappedConfigV7;
}

export function canonicalizeWrappedConfigV1(raw: any): WrappedConfigV1 {
  const fallback: WrappedConfigV1 = {
    version: 6,
    defaultKaspaNetwork: "tn10",
    manualRedemptionSlaText: "",
    kaspaNetworks: {},
    evmRpc: {},
    approvedEvmAssets: [],
    approvedPairs: [],
    allowListByNetwork: {}
  };

  const obj = raw && typeof raw === "object" ? raw : {};
  const out: any = { ...fallback, ...obj };

  out.version = typeof out.version === "number" && Number.isFinite(out.version) ? out.version : 6;
  out.defaultKaspaNetwork = normalizeKaspaNetworkId(out.defaultKaspaNetwork, fallback.defaultKaspaNetwork);
  out.manualRedemptionSlaText = String(out.manualRedemptionSlaText || "").trim();

  if (!out.kaspaNetworks || typeof out.kaspaNetworks !== "object") out.kaspaNetworks = {};
  if (!out.evmRpc || typeof out.evmRpc !== "object") out.evmRpc = {};
  if (!Array.isArray(out.approvedEvmAssets)) out.approvedEvmAssets = [];
  if (!Array.isArray(out.approvedPairs)) out.approvedPairs = [];
  if (!out.allowListByNetwork || typeof out.allowListByNetwork !== "object") out.allowListByNetwork = {};

  return out as WrappedConfigV1;
}

function migrateV6ToV7(raw0: any): WrappedConfigV7 {
  const v6 = canonicalizeWrappedConfigV1(raw0);

  const out0: any = {
    version: 7,
    defaults: {
      kaspaNetwork: normalizeKaspaNetworkId(v6.defaultKaspaNetwork, "tn10"),
      evmNetwork: "mainnet",
      evmVaultId: "evm_mainnet_default"
    },
    manualRedemptionSlaText: v6.manualRedemptionSlaText || "",
    publicSite: {
      publicPageSkinId: "classic_teal"
    },
    kaspaNetworks: v6.kaspaNetworks || {},
    evmNetworks: {},
    vaults: {},
    erc20Tokens: {},
    controlledAssetsByNetwork: {},
    issuance: {
      deployerByNetwork: {},
      metaByNetwork: {}
    }
  };

  const evmRpcs = (v6 as any).evmRpcs && typeof (v6 as any).evmRpcs === "object" ? (v6 as any).evmRpcs : null;
  if (evmRpcs) {
    for (const [k, v] of Object.entries(evmRpcs)) {
      if (!v || typeof v !== "object") continue;
      out0.evmNetworks[String(k)] = {
        rpcUrl: String((v as any).rpcUrl || "").trim(),
        authorization: String((v as any).authorization || "").trim()
      };
    }
  } else {
    out0.evmNetworks.mainnet = {
      rpcUrl: String((v6 as any).evmRpc?.rpcUrl || "").trim(),
      authorization: String((v6 as any).evmRpc?.authorization || "").trim()
    };
    out0.evmNetworks.sepolia = { rpcUrl: "", authorization: "" };
  }

  for (const a of v6.approvedEvmAssets || []) {
    if (!a || typeof a !== "object") continue;
    const sym = String((a as any).symbol || "").trim();
    if (!sym) continue;
    out0.erc20Tokens[sym] = {
      name: String((a as any).name || sym).trim() || sym,
      contract: String((a as any).contract || "").trim(),
      decimals: Number((a as any).decimals || 0)
    };
  }

  out0.vaults.evm_mainnet_default = {
    chain: "ethereum",
    network: "mainnet",
    address: "0x161B5B6706EA0F8B6ea6aE0BdC9457AC2724e833"
  };

  const allow = v6.allowListByNetwork || {};
  for (const [netId, bucketAny] of Object.entries(allow)) {
    if (!bucketAny || typeof bucketAny !== "object") continue;
    const bucket: any = bucketAny as any;
    for (const [k, entryAny] of Object.entries(bucket)) {
      const entry = entryAny && typeof entryAny === "object" ? (entryAny as any) : null;
      if (!entry) continue;

      const ca = String(entry.ca || k || "").trim();
      if (!ca) continue;

      const vault = entry.vault && typeof entry.vault === "object" ? entry.vault : null;
      const chain0 = vault ? String(vault.chain || "").trim() : "";
      const addr0 = vault ? String(vault.address || "").trim() : "";

      const caKey = ca.toLowerCase();
      out0.controlledAssetsByNetwork[netId] = out0.controlledAssetsByNetwork[netId] || {};

      const assetRef = String(entry.assetRef || "").trim();
      const chain = chain0.toLowerCase();
      let mode = "unknown";
      if (chain === "ethereum" || chain === "etherium") mode = "evm_erc20";
      else if (chain) mode = "utxo";

      let vaultId = "";
      if (mode === "evm_erc20") {
        vaultId = "evm_mainnet_default";
      } else if (mode === "utxo" && chain && addr0) {
        vaultId = `${chain}_mainnet_vault`;
        if (!out0.vaults[vaultId]) {
          out0.vaults[vaultId] = { chain, network: "mainnet", address: addr0 };
        }
      }

      const controlled: any = {
        ca,
        name: String(entry.name || "").trim(),
        decimals: Number(entry.decimals || 0),
        assetRef,
        mode
      };

      if (vaultId) controlled.vaultId = vaultId;
      if (mode === "evm_erc20" && assetRef) controlled.erc20Symbol = assetRef;
      if (entry.delivery) controlled.delivery = entry.delivery;
      if (entry.fees && typeof entry.fees === "object") controlled.fees = entry.fees;
      if (entry.vaultTestnet && typeof entry.vaultTestnet === "object") controlled.vaultTestnet = entry.vaultTestnet;

      out0.controlledAssetsByNetwork[netId][caKey] = controlled;
    }
  }

  out0.issuance.deployerByNetwork = ((v6 as any).krc20DeployerByNetwork && typeof (v6 as any).krc20DeployerByNetwork === "object")
    ? (v6 as any).krc20DeployerByNetwork
    : {};

  out0.issuance.metaByNetwork = ((v6 as any).krc20MetaByNetwork && typeof (v6 as any).krc20MetaByNetwork === "object")
    ? (v6 as any).krc20MetaByNetwork
    : {};

  for (const [netId, bAny] of Object.entries(out0.issuance.deployerByNetwork || {})) {
    if (!bAny || typeof bAny !== "object") continue;
    const b: any = bAny as any;
    const next: any = {};
    for (const [ca0, v] of Object.entries(b)) {
      const caKey = String(ca0 || "").trim().toLowerCase();
      if (!caKey) continue;
      next[caKey] = String(v || "").trim();
    }
    out0.issuance.deployerByNetwork[netId] = next;
  }

  for (const [netId, bAny] of Object.entries(out0.issuance.metaByNetwork || {})) {
    if (!bAny || typeof bAny !== "object") continue;
    const b: any = bAny as any;
    const next: any = {};
    for (const [ca0, vAny] of Object.entries(b)) {
      const caKey = normalizeCaKey(ca0);
      if (!caKey) continue;
      next[caKey] = canonicalizeIssuanceMetaEntry(vAny);
    }
    out0.issuance.metaByNetwork[netId] = next;
  }

  return canonicalizeWrappedConfigV7(out0);
}

function isEvmVaultChain(chain0: string): boolean {
  const c = String(chain0 || "").trim().toLowerCase();
  return c.includes("ethereum") || c.includes("etherium") || c.includes("evm");
}

function assertNonEvmVaultNativeMeta(cfg: WrappedConfigV7): void {
  const vaults = cfg && cfg.vaults && typeof cfg.vaults === "object" ? cfg.vaults : {};

  for (const [vaultId0, vAny] of Object.entries(vaults)) {
    if (!vAny || typeof vAny !== "object") continue;

    const vaultId = String(vaultId0 || "").trim();
    if (!vaultId) continue;

    const chain = String((vAny as any).chain || "").trim();
    if (!chain) throw new Error(`config error: vaults.${vaultId}.chain is required`);

    if (isEvmVaultChain(chain)) continue;

    const sym = String((vAny as any).nativeSymbol || "").trim();
    if (!sym) throw new Error(`config error: vaults.${vaultId}.nativeSymbol is required for non-EVM vault (${chain})`);

    const decAny = (vAny as any).nativeDecimals;
    const dec = (decAny === null || decAny === undefined) ? null : Number(decAny);
    if (dec === null || !Number.isFinite(dec) || dec < 0) {
      throw new Error(`config error: vaults.${vaultId}.nativeDecimals is required for non-EVM vault (${chain})`);
    }
  }
}

export function readWrappedConfigV7(repoRoot: string): WrappedConfigV7 {
  const p7 = storePathV7(repoRoot);
  if (fs.existsSync(p7)) {
    const raw = fs.readFileSync(p7, "utf8");
    const parsed = safeParseJson(raw);
    const cfg = canonicalizeWrappedConfigV7(parsed);
    assertNonEvmVaultNativeMeta(cfg);

    if (JSON.stringify(cfg) !== JSON.stringify(parsed)) {
      atomicWriteJson(p7, cfg);
    }

    return cfg;
  }

  const p1 = storePathV1(repoRoot);
  if (fs.existsSync(p1)) {
    const raw = fs.readFileSync(p1, "utf8");
    const parsed = safeParseJson(raw);
    const cfg7 = migrateV6ToV7(parsed);

    atomicWriteJson(p7, cfg7);

    try {
      const p1m = migratedPathV1(repoRoot);
      if (fs.existsSync(p1m)) fs.unlinkSync(p1m);
      fs.renameSync(p1, p1m);
    } catch {
    }

    return cfg7;
  }

  const initial = canonicalizeWrappedConfigV7({});
  atomicWriteJson(p7, initial);
  return initial;
}

export function writeWrappedConfigV7(repoRoot: string, next: any): WrappedConfigV7 {
  const p7 = storePathV7(repoRoot);
  const v = next && typeof next === "object" ? next : {};
  const saved = (typeof (v as any).version === "number" && (v as any).version <= 6)
    ? migrateV6ToV7(v)
    : canonicalizeWrappedConfigV7(v);
  assertNonEvmVaultNativeMeta(saved);
  atomicWriteJson(p7, saved);
  return saved;
}
