export type WalletType = "standard" | "compliance";
export type WalletCustodyModel = "self_1of1" | "broker_1of1";

export type AppNetworkKey = "mainnet" | "tn10";
export type WalletNetworkType = "mainnet" | "testnet";
export type NetworkType = WalletNetworkType;

export type RpcNetworkId = "mainnet" | "testnet-10";
export type KasplexNetworkId = "mainnet" | "testnet";
export type AddressPrefix = "kaspa" | "kaspatest";
export type ExplorerNetworkId = AppNetworkKey;

export type NetworkRegistryEntry = {
  key: AppNetworkKey;
  display_name: string;
  wallet_network: WalletNetworkType;
  rpc_network_id: RpcNetworkId;
  kasplex_network_id: KasplexNetworkId;
  address_prefix: AddressPrefix;
  explorer_network_id: ExplorerNetworkId;
  default_rpc_connect_timeout_ms: number;
  default_balance_lookup_timeout_ms: number;
  enabled: boolean;
};

export type WalletWhitelistEntry = {
  address: string;
  added_at: string;
  removed_at: string | null;
};

export type WalletWhitelistBucket = {
  entries: WalletWhitelistEntry[];
};

export type WalletWhitelistState = {
  by_network: {
    mainnet: WalletWhitelistBucket;
    testnet: WalletWhitelistBucket;
  };
};

export type WalletRecord = {
  id: string;
  created_at: string;
  wallet_type: WalletType;
  network: NetworkType;
  broker_id: string | null;
  custody_model?: WalletCustodyModel | null;
  broker_custody_key_ref?: string | null;
  user_auth_pubkey?: string | null;

  // Standard Wallet signing public key.
  user_pubkey?: string;

  whitelist?: WalletWhitelistState;

  address0: string;
  state: "PENDING_ENGINE" | "READY";
};

export type WalletStore = {
  active_id: string | null;
  items: WalletRecord[];
};

export type EnergyNetworkId = "mainnet" | `tn${number}`;

export type EnergySiteRecord = {
  site_id: string;
  owner_user_id: string;
  sid: string;
  site_name: string;
  site_timezone: string;
  activation_start_date: string;
  is_active: boolean;
  first_successful_download_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EnergyTokenLockRecord = {
  network_id: EnergyNetworkId;
  ca: string;
  is_active: boolean;
  locked_by_user_id: string | null;
  locked_at: string;
};

export type EnergySiteLedgerRecord = {
  site_id: string;
  last_downloaded_at: string | null;
  last_downloaded_through_ymd: string | null;
  owed_wh: string;
  issued_mainnet_wh: string;
  issued_testnet_wh: string;
  last_issue_preview_at: string | null;
  last_issue_network_id: EnergyNetworkId | null;
  last_issue_ca: string | null;
  last_issue_amount_raw: string | null;
  last_issue_commit_txid: string | null;
  last_issue_reveal_txid: string | null;
  created_at: string;
  updated_at: string;
};

export type EnergyStore = {
  version: 1;
  updated_at: string;
  sites_by_id: Record<string, EnergySiteRecord>;
  site_id_by_sid: Record<string, string>;
  energy_locks_by_network: Record<string, Record<string, EnergyTokenLockRecord>>;
  ledgers_by_site_id: Record<string, EnergySiteLedgerRecord>;
};
