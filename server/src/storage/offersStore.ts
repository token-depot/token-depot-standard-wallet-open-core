import fs from "fs";
import path from "path";
import crypto from "crypto";

export type OfferAsset = {
  type: string;   // e.g. "KAS", "KRC20"
  symbol: string; // e.g. "KAS", "CA:abcd..."
};

export type OfferPartial = {
  enabled: boolean;
  min?: string;
  step?: string;
};

export type OfferRecord = {
  offerId: string;

  createdAt: string;        // ISO
  state: string;            // "open" | "filled" | "cancelled" | "expired" (string for forward-compat)
  ttl: number;              // seconds
  expiresAt: string | null; // ISO or null

  // Taker-centric listing (what taker sends / receives)
  sell: OfferAsset;         // e.g. { type:"KAS", symbol:"KAS" }
  buy: OfferAsset;          // e.g. { type:"KRC20", symbol:"CA:..." }

  sellAmount: string;       // KAS price (taker pays)
  buyAmount: string;        // token amount (taker receives)

  // Optional display helpers
  price?: string;
  partial?: OfferPartial;

  // --- Kasplex on-chain listing artifacts (required for 01D) ---
  networkId?: string;

  makerWalletId?: string;
  makerReceiveAddress?: string; // where maker receives KAS price

  ca?: string;               // lowercase CA hex (no "CA:" prefix)
  tokenAmount?: string;       // token amount maker sells (same as buyAmount)
  priceKas?: string;          // KAS price maker receives (same as sellAmount)

  listCommitTxid?: string;
  listRevealTxid?: string;

  p2shSendOutpoint?: { txid: string; index: number };
  p2shSendRedeemScriptHex?: string;

  kasplexListPayload?: string; // canonical JSON string (no spaces)
  kasplexSendPayload?: string; // canonical JSON string (no spaces)
};

export type OffersStore = {
  items: OfferRecord[];
};

function offersStorePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "offers.json");
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
    const initial: OffersStore = { items: [] };
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

export function readOffersStore(repoRoot: string): OffersStore {
  const storePath = offersStorePath(repoRoot);
  ensureStoreFile(storePath);

  const raw = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(raw) as OffersStore;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("offers.json: invalid JSON root");
  }
  if (!Array.isArray((parsed as any).items)) {
    throw new Error("offers.json: items must be an array");
  }

  return parsed;
}

export function writeOffersStore(repoRoot: string, store: OffersStore): void {
  const storePath = offersStorePath(repoRoot);
  atomicWriteJson(storePath, store);
}
