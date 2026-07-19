import fs from "fs";
import path from "path";
import crypto from "crypto";

export type BridgeFulfillmentResultRow = {
  purchaseId: string;
  to: string;
  amountRaw: string;
  fulfillmentExecutionNonce?: string;
  result: string;
  txid?: string;
  error?: string;
};

export type BridgeFulfillmentResultArtifact = {
  version: 1;
  kind: "bridge_fulfillment_result";
  networkId: string;
  sourceWalletAddress: string;
  assetName?: string;
  ca: string;
  fulfillmentBatchId: string;
  executedAt?: string;
  executionRule?: string;
  rows: BridgeFulfillmentResultRow[];
};

export type BridgeFulfillmentResultStoreItem = {
  fulfillmentBatchId: string;
  createdAt: string;
  updatedAt: string;
  artifact: BridgeFulfillmentResultArtifact;
};

export type BridgeFulfillmentResultStoreV1 = {
  version: 1;
  items: BridgeFulfillmentResultStoreItem[];
};

function storePath(repoRoot: string): string {
  return path.join(repoRoot, "data", "bridge-fulfillment-results.v1.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStoreFile(filePath: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  if (!fs.existsSync(filePath)) {
    const initial: BridgeFulfillmentResultStoreV1 = { version: 1, items: [] };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRow(row: BridgeFulfillmentResultRow): BridgeFulfillmentResultRow {
  return {
    purchaseId: String(row.purchaseId || "").trim(),
    to: String(row.to || "").trim(),
    amountRaw: String(row.amountRaw || "").trim(),
    fulfillmentExecutionNonce:
      typeof row.fulfillmentExecutionNonce === "string" ? row.fulfillmentExecutionNonce.trim() : undefined,
    result: String(row.result || "").trim(),
    txid: typeof row.txid === "string" ? row.txid.trim() : undefined,
    error: typeof row.error === "string" ? row.error : undefined
  };
}

function normalizeArtifact(artifact: BridgeFulfillmentResultArtifact): BridgeFulfillmentResultArtifact {
  const rows = Array.isArray(artifact.rows) ? artifact.rows.map(normalizeRow) : [];

  return {
    version: 1,
    kind: "bridge_fulfillment_result",
    networkId: String(artifact.networkId || "").trim(),
    sourceWalletAddress: String(artifact.sourceWalletAddress || "").trim(),
    assetName: typeof artifact.assetName === "string" ? artifact.assetName.trim() : undefined,
    ca: String(artifact.ca || "").trim().toLowerCase(),
    fulfillmentBatchId: String(artifact.fulfillmentBatchId || "").trim(),
    executedAt: typeof artifact.executedAt === "string" ? artifact.executedAt.trim() : undefined,
    executionRule: typeof artifact.executionRule === "string" ? artifact.executionRule.trim() : undefined,
    rows
  };
}

function normalizeStoreItem(item: BridgeFulfillmentResultStoreItem): BridgeFulfillmentResultStoreItem {
  const artifact = normalizeArtifact(item.artifact);
  const fulfillmentBatchId = String(item.fulfillmentBatchId || artifact.fulfillmentBatchId || "").trim();

  return {
    fulfillmentBatchId,
    createdAt: String(item.createdAt || "").trim() || nowIso(),
    updatedAt: String(item.updatedAt || "").trim() || nowIso(),
    artifact: {
      ...artifact,
      fulfillmentBatchId
    }
  };
}

export function readBridgeFulfillmentResultStore(repoRoot: string): BridgeFulfillmentResultStoreV1 {
  const filePath = storePath(repoRoot);
  ensureStoreFile(filePath);

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as BridgeFulfillmentResultStoreV1;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("bridge-fulfillment-results.v1.json: invalid JSON root");
  }
  if ((parsed as any).version !== 1) {
    throw new Error("bridge-fulfillment-results.v1.json: unsupported version");
  }
  if (!Array.isArray((parsed as any).items)) {
    throw new Error("bridge-fulfillment-results.v1.json: items must be an array");
  }

  const normalized: BridgeFulfillmentResultStoreV1 = {
    version: 1,
    items: parsed.items.map(normalizeStoreItem)
  };

  return normalized;
}

export function writeBridgeFulfillmentResultStore(repoRoot: string, store: BridgeFulfillmentResultStoreV1): void {
  const filePath = storePath(repoRoot);
  atomicWriteJson(filePath, {
    version: 1,
    items: Array.isArray(store.items) ? store.items.map(normalizeStoreItem) : []
  });
}

export function listBridgeFulfillmentResultArtifacts(repoRoot: string): BridgeFulfillmentResultArtifact[] {
  const store = readBridgeFulfillmentResultStore(repoRoot);
  return store.items.map((item) => item.artifact);
}

export function getBridgeFulfillmentResultArtifact(
  repoRoot: string,
  fulfillmentBatchId: string
): BridgeFulfillmentResultArtifact | null {
  const wanted = String(fulfillmentBatchId || "").trim();
  if (!wanted) return null;

  const store = readBridgeFulfillmentResultStore(repoRoot);
  const found = store.items.find((item) => item.fulfillmentBatchId === wanted);
  return found ? found.artifact : null;
}

export function upsertBridgeFulfillmentResultArtifact(
  repoRoot: string,
  artifactInput: BridgeFulfillmentResultArtifact
): BridgeFulfillmentResultStoreItem {
  const artifact = normalizeArtifact(artifactInput);
  const fulfillmentBatchId = artifact.fulfillmentBatchId;
  if (!fulfillmentBatchId) {
    throw new Error("bridge_fulfillment_result_missing_batch_id");
  }

  const store = readBridgeFulfillmentResultStore(repoRoot);
  const idx = store.items.findIndex((item) => item.fulfillmentBatchId === fulfillmentBatchId);

  if (idx >= 0) {
    const cur = normalizeStoreItem(store.items[idx]);
    const next: BridgeFulfillmentResultStoreItem = {
      fulfillmentBatchId,
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
      artifact
    };
    store.items[idx] = next;
    writeBridgeFulfillmentResultStore(repoRoot, store);
    return next;
  }

  const next: BridgeFulfillmentResultStoreItem = {
    fulfillmentBatchId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    artifact
  };
  store.items.unshift(next);
  writeBridgeFulfillmentResultStore(repoRoot, store);
  return next;
}

export function removeBridgeFulfillmentResultArtifact(
  repoRoot: string,
  fulfillmentBatchId: string
): boolean {
  const wanted = String(fulfillmentBatchId || "").trim();
  if (!wanted) return false;

  const store = readBridgeFulfillmentResultStore(repoRoot);
  const before = store.items.length;
  store.items = store.items.filter((item) => item.fulfillmentBatchId !== wanted);

  if (store.items.length === before) return false;
  writeBridgeFulfillmentResultStore(repoRoot, store);
  return true;
}
