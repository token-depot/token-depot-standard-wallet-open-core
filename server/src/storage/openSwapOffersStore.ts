import fs from "node:fs";
import path from "node:path";

export type OpenSwapOfferState = "open" | "filled" | "expired" | "cancelled";

type OpenSwapOfferNetworkId = "mainnet" | `testnet-${number}`;

export type OpenSwapOfferRecord = {
  offerId: string;
  state: OpenSwapOfferState;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  mode: "open_swap_v2";
  discovery: string;
  fillMode: string;
  kind: "tick_to_kas" | "ca_to_kas";
  networkId: OpenSwapOfferNetworkId;
  sellSymbol: string;
  sellAmount: string;
  buyAmountKas: string;
  makerUserId: string;
  makerWalletId: string;
  makerWalletType: string;
  makerKasReceiveAddress: string;
  termsCommitment: string;
  offerDescription?: string;
  offerInfoUrl?: string;
  offerBlob: string;
  offerDraft: any;
};

type OpenSwapOffersStoreFile = {
  version: 1;
  items: OpenSwapOfferRecord[];
};

const OPEN_SWAP_OFFERS_STORE_REL = path.join("data", "open_swap_offers.json");

function getOpenSwapOffersStorePath(repoRoot: string): string {
  return path.join(repoRoot, OPEN_SWAP_OFFERS_STORE_REL);
}

function emptyOpenSwapOffersStore(): OpenSwapOffersStoreFile {
  return { version: 1, items: [] };
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseIsoMs(raw: string): number {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function sanitizeState(raw: unknown): OpenSwapOfferState {
  const state = typeof raw === "string" ? raw.trim() : "";
  if (state === "filled" || state === "expired" || state === "cancelled") return state;
  return "open";
}

function sanitizeNetworkId(raw: unknown): OpenSwapOfferNetworkId {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "mainnet") return "mainnet";
  if (/^testnet-\d+$/.test(value)) return value as OpenSwapOfferNetworkId;
  if (/^tn\d+$/.test(value)) return `testnet-${value.slice(2)}` as OpenSwapOfferNetworkId;
  return "testnet-10";
}

function sanitizeKind(raw: unknown): "tick_to_kas" | "ca_to_kas" {
  return raw === "ca_to_kas" ? "ca_to_kas" : "tick_to_kas";
}

function sanitizeOfferDescription(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  return value.slice(0, 2000);
}

function sanitizeOfferInfoUrl(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString().slice(0, 500);
  } catch {
    return "";
  }
}

function sanitizeRecord(raw: any): OpenSwapOfferRecord | null {
  if (!raw || typeof raw !== "object") return null;

  const offerId = typeof raw.offerId === "string" ? raw.offerId.trim() : "";
  if (!offerId) return null;

  const createdAt = typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt.trim() : toIsoNow();
  const expiresAt = typeof raw.expiresAt === "string" ? raw.expiresAt.trim() : "";
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt.trim() : createdAt;
  const offerBlob = typeof raw.offerBlob === "string" ? raw.offerBlob : "";

  if (!offerBlob) return null;

  return {
    offerId,
    state: sanitizeState(raw.state),
    createdAt,
    expiresAt,
    updatedAt,
    mode: "open_swap_v2",
    discovery: typeof raw.discovery === "string" ? raw.discovery : "manual_import",
    fillMode: typeof raw.fillMode === "string" ? raw.fillMode : "full_fill_only",
    kind: sanitizeKind(raw.kind),
    networkId: sanitizeNetworkId(raw.networkId),
    sellSymbol: typeof raw.sellSymbol === "string" ? raw.sellSymbol : "",
    sellAmount: typeof raw.sellAmount === "string" ? raw.sellAmount : "",
    buyAmountKas: typeof raw.buyAmountKas === "string" ? raw.buyAmountKas : "",
    makerUserId: typeof raw.makerUserId === "string" ? raw.makerUserId : "",
    makerWalletId: typeof raw.makerWalletId === "string" ? raw.makerWalletId : "",
    makerWalletType: typeof raw.makerWalletType === "string" ? raw.makerWalletType : "",
    makerKasReceiveAddress: typeof raw.makerKasReceiveAddress === "string" ? raw.makerKasReceiveAddress : "",
    termsCommitment: typeof raw.termsCommitment === "string" ? raw.termsCommitment : "",
    offerDescription: sanitizeOfferDescription(raw.offerDescription ?? raw.offer_description ?? raw.description),
    offerInfoUrl: sanitizeOfferInfoUrl(raw.offerInfoUrl ?? raw.offer_info_url ?? raw.info_url),
    offerBlob,
    offerDraft: raw.offerDraft ?? null
  };
}

function readOpenSwapOffersStoreFile(repoRoot: string): OpenSwapOffersStoreFile {
  const filePath = getOpenSwapOffersStorePath(repoRoot);
  if (!fs.existsSync(filePath)) return emptyOpenSwapOffersStore();

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items)
      ? parsed.items.map((it: any) => sanitizeRecord(it)).filter((it: OpenSwapOfferRecord | null): it is OpenSwapOfferRecord => !!it)
      : [];
    return { version: 1, items };
  } catch {
    return emptyOpenSwapOffersStore();
  }
}

function writeOpenSwapOffersStoreFile(repoRoot: string, store: OpenSwapOffersStoreFile): void {
  const filePath = getOpenSwapOffersStorePath(repoRoot);
  const dirPath = path.dirname(filePath);
  const tempPath = `${filePath}.tmp`;

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeExpiredState(store: OpenSwapOffersStoreFile): { store: OpenSwapOffersStoreFile; changed: boolean } {
  const nowMs = Date.now();
  let changed = false;

  const items = store.items.map((item) => {
    if (item.state !== "open") return item;

    const expiresAtMs = parseIsoMs(item.expiresAt);
    if (!expiresAtMs || expiresAtMs > nowMs) return item;

    changed = true;
    return {
      ...item,
      state: "expired" as const,
      updatedAt: toIsoNow()
    };
  });

  return {
    store: { version: 1, items },
    changed
  };
}

function cloneRecord(item: OpenSwapOfferRecord): OpenSwapOfferRecord {
  return {
    ...item,
    offerDraft: item.offerDraft == null ? null : JSON.parse(JSON.stringify(item.offerDraft))
  };
}

export function upsertOpenSwapOffer(repoRoot: string, record: OpenSwapOfferRecord): OpenSwapOfferRecord {
  const clean = sanitizeRecord(record);
  if (!clean) {
    throw new Error("invalid_open_swap_offer_record");
  }

  const normalized = normalizeExpiredState(readOpenSwapOffersStoreFile(repoRoot));
  const store = normalized.store;
  const idx = store.items.findIndex((item) => item.offerId === clean.offerId);

  if (idx >= 0) {
    store.items[idx] = clean;
  } else {
    store.items.push(clean);
  }

  writeOpenSwapOffersStoreFile(repoRoot, store);
  return cloneRecord(clean);
}

export function getOpenSwapOffer(repoRoot: string, offerId: string): OpenSwapOfferRecord | null {
  const wanted = typeof offerId === "string" ? offerId.trim() : "";
  if (!wanted) return null;

  const normalized = normalizeExpiredState(readOpenSwapOffersStoreFile(repoRoot));
  if (normalized.changed) {
    writeOpenSwapOffersStoreFile(repoRoot, normalized.store);
  }

  const found = normalized.store.items.find((item) => item.offerId === wanted) ?? null;
  return found ? cloneRecord(found) : null;
}

export function listOpenSwapOffers(
  repoRoot: string,
  opts?: { state?: OpenSwapOfferState; networkId?: OpenSwapOfferNetworkId }
): OpenSwapOfferRecord[] {
  const normalized = normalizeExpiredState(readOpenSwapOffersStoreFile(repoRoot));
  if (normalized.changed) {
    writeOpenSwapOffersStoreFile(repoRoot, normalized.store);
  }

  let items = normalized.store.items.slice();

  if (opts?.state) {
    items = items.filter((item) => item.state === opts.state);
  }

  if (opts?.networkId) {
    items = items.filter((item) => item.networkId === opts.networkId);
  }

  items.sort((a, b) => parseIsoMs(b.createdAt) - parseIsoMs(a.createdAt));

  return items.map(cloneRecord);
}
