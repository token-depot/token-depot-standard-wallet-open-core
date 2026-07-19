import type {
  AppNetworkKey,
  KasplexNetworkId,
  NetworkRegistryEntry,
  RpcNetworkId,
  WalletNetworkType
} from "./types";

const NETWORK_REGISTRY: Record<AppNetworkKey, NetworkRegistryEntry> = {
  mainnet: {
    key: "mainnet",
    display_name: "Mainnet",
    wallet_network: "mainnet",
    rpc_network_id: "mainnet",
    kasplex_network_id: "mainnet",
    address_prefix: "kaspa",
    explorer_network_id: "mainnet",
    default_rpc_connect_timeout_ms: 4000,
    default_balance_lookup_timeout_ms: 4000,
    enabled: true
  },
  tn10: {
    key: "tn10",
    display_name: "Testnet-10",
    wallet_network: "testnet",
    rpc_network_id: "testnet-10",
    kasplex_network_id: "testnet",
    address_prefix: "kaspatest",
    explorer_network_id: "tn10",
    default_rpc_connect_timeout_ms: 8000,
    default_balance_lookup_timeout_ms: 8000,
    enabled: true
  }
};

export function getNetworkRegistry(): Record<AppNetworkKey, NetworkRegistryEntry> {
  return NETWORK_REGISTRY;
}

export function getNetworkRegistryEntry(networkKey: AppNetworkKey): NetworkRegistryEntry {
  return NETWORK_REGISTRY[networkKey];
}

export function getEnabledNetworkKeys(): AppNetworkKey[] {
  return (Object.keys(NETWORK_REGISTRY) as AppNetworkKey[]).filter(
    (networkKey) => NETWORK_REGISTRY[networkKey].enabled
  );
}

export function appNetworkKeyFromWalletNetwork(walletNetwork: WalletNetworkType): AppNetworkKey {
  return walletNetwork === "mainnet" ? "mainnet" : "tn10";
}

export function walletNetworkTypeFromAppNetworkKey(networkKey: AppNetworkKey): WalletNetworkType {
  return NETWORK_REGISTRY[networkKey].wallet_network;
}

export function rpcNetworkIdFromAppNetworkKey(networkKey: AppNetworkKey): RpcNetworkId {
  return NETWORK_REGISTRY[networkKey].rpc_network_id;
}

export function kasplexNetworkIdFromAppNetworkKey(networkKey: AppNetworkKey): KasplexNetworkId {
  return NETWORK_REGISTRY[networkKey].kasplex_network_id;
}

export function kasplexBaseUrlFromAppNetworkKey(networkKey: AppNetworkKey): string {
  const kasplexNetworkId = kasplexNetworkIdFromAppNetworkKey(networkKey);
  return kasplexNetworkId === "mainnet"
    ? "https://api.kasplex.org/v1"
    : "https://tn10api.kasplex.org/v1";
}

export function explorerBaseUrlFromAppNetworkKey(networkKey: AppNetworkKey): string {
  return networkKey === "mainnet"
    ? "https://explorer.kaspa.org"
    : "https://explorer-tn10.kaspa.org";
}

export function addressPrefixFromAppNetworkKey(networkKey: AppNetworkKey): "kaspa" | "kaspatest" {
  return NETWORK_REGISTRY[networkKey].address_prefix;
}

export function defaultRpcConnectTimeoutMsFromAppNetworkKey(networkKey: AppNetworkKey): number {
  return NETWORK_REGISTRY[networkKey].default_rpc_connect_timeout_ms;
}

export function defaultBalanceLookupTimeoutMsFromAppNetworkKey(networkKey: AppNetworkKey): number {
  return NETWORK_REGISTRY[networkKey].default_balance_lookup_timeout_ms;
}

const KRC20_TOCCATA_FEE_RATE_FLOOR = 100;

export function krc20ToccataFeeRateFloorFromAppNetworkKey(networkKey: AppNetworkKey): number {
  switch (networkKey) {
    case "mainnet":
    case "tn10":
      return KRC20_TOCCATA_FEE_RATE_FLOOR;
    default:
      return 0;
  }
}

export function applyKrc20ToccataFeeRateFloor(networkKey: AppNetworkKey, feeRate: number): number {
  const numericFeeRate = Number(feeRate);
  const safeFeeRate = Number.isFinite(numericFeeRate) && numericFeeRate > 0 ? numericFeeRate : 0;
  const floor = krc20ToccataFeeRateFloorFromAppNetworkKey(networkKey);
  return safeFeeRate < floor ? floor : safeFeeRate;
}

export function normalizeAppNetworkKey(input: unknown): AppNetworkKey | null {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!raw) return null;

  if (raw === "mainnet") return "mainnet";
  if (raw === "tn10") return "tn10";
  if (raw === "testnet") return "tn10";
  if (raw === "testnet-10") return "tn10";

  return null;
}