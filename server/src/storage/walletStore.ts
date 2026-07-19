import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WalletCustodyModel, WalletRecord, WalletStore, WalletType, NetworkType } from "../types";

function walletStorePath(repoRoot: string, userId: string): string {
  return path.join(repoRoot, "data", "users", userId, "wallets.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStoreFile(storePath: string): void {
  const dir = path.dirname(storePath);
  ensureDir(dir);
  if (!fs.existsSync(storePath)) {
    const initial: WalletStore = { active_id: null, items: [] };
    fs.writeFileSync(storePath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function readWalletStore(repoRoot: string, userId: string): WalletStore {
  const storePath = walletStorePath(repoRoot, userId);
  ensureStoreFile(storePath);

  const raw = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(raw) as WalletStore;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("wallets.json: invalid JSON root");
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error("wallets.json: items must be an array");
  }
  if (parsed.active_id !== null && typeof parsed.active_id !== "string") {
    throw new Error("wallets.json: active_id must be string or null");
  }

  return parsed;
}

export function writeWalletStore(repoRoot: string, userId: string, store: WalletStore): void {
  const storePath = walletStorePath(repoRoot, userId);
  atomicWriteJson(storePath, store);
}

export function generateWalletId(): string {
  const ts = Date.now();
  const rnd = crypto.randomBytes(4).toString("hex");
  return `WALLET_${ts}_${rnd}`;
}

export function makeWalletRecord(params: {
  wallet_type: WalletType;
  network: NetworkType;
  broker_id: string | null;
  wallet_id?: string | null;
  custody_model?: WalletCustodyModel | null;
  broker_custody_key_ref?: string | null;
  user_auth_pubkey?: string | null;
}): WalletRecord {
  const walletId =
    typeof params.wallet_id === "string" && params.wallet_id.trim().length > 0
      ? params.wallet_id.trim()
      : generateWalletId();

  const record: WalletRecord = {
    id: walletId,
    created_at: new Date().toISOString(),
    wallet_type: params.wallet_type,
    network: params.network,
    broker_id: params.broker_id,
    whitelist: {
      by_network: {
        mainnet: { entries: [] },
        testnet: { entries: [] }
      }
    },
    address0: "PENDING",
    state: "PENDING_ENGINE"
  };

  if (params.custody_model !== undefined) {
    record.custody_model = params.custody_model;
  }
  if (params.broker_custody_key_ref !== undefined) {
    record.broker_custody_key_ref = params.broker_custody_key_ref;
  }
  if (params.user_auth_pubkey !== undefined) {
    record.user_auth_pubkey = params.user_auth_pubkey;
  }

  return record;
}
