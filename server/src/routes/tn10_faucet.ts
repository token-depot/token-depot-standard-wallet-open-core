import fs from "node:fs";
import type { Express, Request, Response } from "express";
import {
  PrivateKey,
  Mnemonic,
  XPrv,
  PrivateKeyGenerator,
  createTransactions,
  decryptXChaCha20Poly1305,
  kaspaToSompi
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";
import { appNetworkKeyFromWalletNetwork, normalizeAppNetworkKey, rpcNetworkIdFromAppNetworkKey } from "../networks";
import {
  getTn10FaucetUsage,
  recordTn10FaucetClaim,
  tn10FaucetYmdUtc
} from "../storage/tn10FaucetStore";

export type Tn10FaucetCtx = {
  repoRoot: string;
  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<any>;
  readWalletStore: (repoRootPath: string, userId: string) => any;
};

type FaucetConfig = {
  faucetAddress: string;
  keyfilePath: string;
  keyfilePassphrase: string;
  claimSompi: bigint;
  dailyLimitSompi: bigint;
};

const TN10_RPC_NETWORK_ID = "testnet-10";
const TN10_ADDRESS_PREFIX = "kaspatest:";
const TN10_FAUCET_FEE_RATE_FLOOR = 100;
const TN10_COINBASE_MATURITY_DAA = 1000n;
const DEFAULT_CLAIM_TKAS = "2000";
const DEFAULT_DAILY_LIMIT_TKAS = "10000";


function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKaspatestAddress(value: unknown): string {
  const s = normalizeString(value);
  if (!s.startsWith(TN10_ADDRESS_PREFIX)) return "";
  return /^[a-z0-9:]+$/i.test(s) ? s : "";
}

function parsePositiveTkasToSompi(value: unknown, fallback: string, reason: string): bigint {
  const raw = normalizeString(value) || fallback;
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) throw new Error(reason);
  const sompi = kaspaToSompi(raw);
  if (sompi === undefined || sompi <= 0n) throw new Error(reason);
  return sompi;
}

function readFaucetConfigFromEnv(): FaucetConfig {
  const faucetAddress = normalizeKaspatestAddress(process.env.TD_TN10_FAUCET_ADDRESS);
  const keyfilePath = normalizeString(process.env.TD_TN10_FAUCET_KEYFILE_PATH);
  const keyfilePassphrase = typeof process.env.TD_TN10_FAUCET_KEYFILE_PASSPHRASE === "string"
    ? process.env.TD_TN10_FAUCET_KEYFILE_PASSPHRASE
    : "";

  if (!faucetAddress) throw new Error("tn10_faucet_address_missing_or_invalid");
  if (!keyfilePath) throw new Error("tn10_faucet_keyfile_path_missing");
  if (!keyfilePassphrase) throw new Error("tn10_faucet_keyfile_passphrase_missing");

  const claimSompi = parsePositiveTkasToSompi(
    process.env.TD_TN10_FAUCET_CLAIM_TKAS,
    DEFAULT_CLAIM_TKAS,
    "tn10_faucet_claim_amount_invalid"
  );
  const dailyLimitSompi = parsePositiveTkasToSompi(
    process.env.TD_TN10_FAUCET_DAILY_LIMIT_TKAS,
    DEFAULT_DAILY_LIMIT_TKAS,
    "tn10_faucet_daily_limit_invalid"
  );

  if (claimSompi > dailyLimitSompi) throw new Error("tn10_faucet_claim_exceeds_daily_limit");

  return {
    faucetAddress,
    keyfilePath,
    keyfilePassphrase,
    claimSompi,
    dailyLimitSompi
  };
}

function readJsonFile(filePath: string): any {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as any;
}

function normalizeDerivationNumber(value: unknown, fallback: number): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(raw) || raw < 0) return fallback;
  return raw;
}

function privateKeyFromStandardKeyfile(config: FaucetConfig): PrivateKey {
  const keyfileOuter = readJsonFile(config.keyfilePath);
  const ciphertext = normalizeString(keyfileOuter && keyfileOuter.ciphertext);
  if (!ciphertext) throw new Error("tn10_faucet_keyfile_ciphertext_missing");

  const plain = decryptXChaCha20Poly1305(ciphertext, config.keyfilePassphrase);
  const inner = JSON.parse(String(plain || "{}")) as any;

  const innerNetworkRaw = normalizeString(inner && inner.network);
  const innerNetwork = normalizeAppNetworkKey(innerNetworkRaw);
  if (innerNetwork !== "tn10") throw new Error("tn10_faucet_keyfile_not_tn10");

  const mnemonicPhrase = normalizeString(inner && inner.mnemonic);
  if (!mnemonicPhrase) throw new Error("tn10_faucet_keyfile_missing_mnemonic");

  const derivation = inner && typeof inner.derivation === "object" && inner.derivation ? inner.derivation : {};
  const derivationAccount = normalizeDerivationNumber(derivation.account, 0);
  const derivationIndex = normalizeDerivationNumber(derivation.index, 0);
  const seedPassphrase = typeof inner.seed_passphrase === "string" ? inner.seed_passphrase : config.keyfilePassphrase;

  const mnemonic = new Mnemonic(mnemonicPhrase);
  const xprv = new XPrv(mnemonic.toSeed(seedPassphrase));
  const keygen = new PrivateKeyGenerator(xprv, false, BigInt(derivationAccount));
  const priv0 = keygen.receiveKey(derivationIndex);

  const derivedAddress = String(priv0.toAddress(TN10_RPC_NETWORK_ID).toString()).trim();
  if (derivedAddress !== config.faucetAddress) throw new Error("tn10_faucet_config_mismatch");

  return priv0;
}

function formatSompi(value: bigint): string {
  return value.toString(10);
}

function readFeeRate(fee: any): number | null {
  const value = fee &&
    fee.estimate &&
    Array.isArray(fee.estimate.normalBuckets) &&
    fee.estimate.normalBuckets.length > 0 &&
    typeof fee.estimate.normalBuckets[0].feerate === "number"
      ? fee.estimate.normalBuckets[0].feerate
      : null;

  return value && Number.isFinite(value) && value > 0 ? value : null;
}

function utxoBlockDaaScore(entry: any): bigint {
  const raw = entry && (entry.blockDaaScore ?? entry.entry?.blockDaaScore);
  try {
    const score = BigInt(raw ?? 0);
    return score > 0n ? score : 0n;
  } catch {
    return 0n;
  }
}

function isMatureForTn10Faucet(entry: any, virtualDaaScore: bigint): boolean {
  if (!entry || !entry.isCoinbase) return true;
  const blockDaaScore = utxoBlockDaaScore(entry);
  if (blockDaaScore <= 0n) return false;
  return virtualDaaScore >= blockDaaScore + TN10_COINBASE_MATURITY_DAA;
}

function tn10FaucetUtxoCovenantId(entry: any): string {
  const raw = entry && (entry.covenantId ?? entry.entry?.covenantId);
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(text) ? text : "";
}

function tn10FaucetUtxoIsCovenantBearing(entry: any): boolean {
  return !!tn10FaucetUtxoCovenantId(entry);
}

async function handleTn10FaucetClaim(_req: Request, res: Response, ctx: Tn10FaucetCtx): Promise<any> {
  try {
    await ctx.ensureKaspaReady(ctx.repoRoot);

    const userId = normalizeString((res.locals as any).td_user_id);
    if (!userId) return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });

    const store = ctx.readWalletStore(ctx.repoRoot, userId);
    const active = store && store.active_id && Array.isArray(store.items)
      ? store.items.find((w: any) => w && w.id === store.active_id) || null
      : null;

    if (!active) {
      return res.status(409).json({ ok: false, reason: "no_active_wallet", error: "No active wallet selected" });
    }

    const activeNetworkKey = appNetworkKeyFromWalletNetwork(active.network);
    const activeRpcNetworkId = rpcNetworkIdFromAppNetworkKey(activeNetworkKey);
    if (activeNetworkKey !== "tn10" || activeRpcNetworkId !== TN10_RPC_NETWORK_ID) {
      return res.status(409).json({ ok: false, reason: "tn10_required", error: "Select a TN10 wallet to use the faucet" });
    }

    const toAddress = normalizeKaspatestAddress(active.address0);
    if (!toAddress) {
      return res.status(409).json({ ok: false, reason: "active_wallet_address_not_kaspatest", error: "Active wallet address must be kaspatest:" });
    }

    const config = readFaucetConfigFromEnv();
    if (toAddress === config.faucetAddress) {
      return res.status(409).json({ ok: false, reason: "faucet_self_send_rejected", error: "Faucet cannot claim to itself" });
    }

    const ymdUtc = tn10FaucetYmdUtc();
    const usage = getTn10FaucetUsage(ctx.repoRoot, userId, ymdUtc);
    const claimedSompi = BigInt(usage.claimed_sompi || "0");
    const remainingSompi = config.dailyLimitSompi > claimedSompi ? config.dailyLimitSompi - claimedSompi : 0n;
    if (remainingSompi < config.claimSompi) {
      return res.status(429).json({
        ok: false,
        reason: "tn10_faucet_quota_exceeded",
        error: "Daily TN10 faucet quota exceeded",
        ymd_utc: ymdUtc,
        claimedSompi: formatSompi(claimedSompi),
        remainingSompi: formatSompi(remainingSompi),
        claimSompi: formatSompi(config.claimSompi),
        dailyLimitSompi: formatSompi(config.dailyLimitSompi)
      });
    }

    const faucetPriv = privateKeyFromStandardKeyfile(config);
    const rpc = await ctx.getSharedRpc(TN10_RPC_NETWORK_ID);
    const fee = await rpc.getFeeEstimate();
    const rpcFeeRate = readFeeRate(fee);
    const feeRate = Math.max(rpcFeeRate || 0, TN10_FAUCET_FEE_RATE_FLOOR);

    const dagInfo = await rpc.getBlockDagInfo();
    const virtualDaaScore = BigInt(dagInfo && dagInfo.virtualDaaScore ? dagInfo.virtualDaaScore : 0n);
    const utxos = await rpc.getUtxosByAddresses({ addresses: [config.faucetAddress] });
    const allEntries = utxos && Array.isArray(utxos.entries) ? utxos.entries : [];
    const matureEntries = allEntries.filter((entry: any) => isMatureForTn10Faucet(entry, virtualDaaScore));
    const entries = matureEntries.filter((entry: any) => !tn10FaucetUtxoIsCovenantBearing(entry));
    const immatureCoinbaseCount = allEntries.length - matureEntries.length;
    const covenantExcludedCount = matureEntries.length - entries.length;

    if (allEntries.length === 0) {
      return res.status(409).json({ ok: false, reason: "tn10_faucet_no_utxos", error: "TN10 faucet wallet has no UTXOs" });
    }
    if (matureEntries.length === 0) {
      return res.status(409).json({
        ok: false,
        reason: "tn10_faucet_only_immature_coinbase_utxos",
        error: "TN10 faucet funds are still maturing. Try again after additional TN10 blocks are mined.",
        immatureCoinbaseCount,
        coinbaseMaturityDaa: TN10_COINBASE_MATURITY_DAA.toString()
      });
    }
    if (entries.length === 0) {
      return res.status(409).json({
        ok: false,
        reason: "tn10_faucet_only_covenant_utxos",
        error: "TN10 faucet wallet has no ordinary spendable UTXOs after covenant exclusion",
        covenant_exclusion: {
          kind: "tn10_faucet_covenant_exclusion_v1",
          excluded_count: covenantExcludedCount,
          mature_candidate_count: matureEntries.length
        }
      });
    }

    const built = await createTransactions({
      outputs: [{ address: toAddress, amount: config.claimSompi }],
      changeAddress: config.faucetAddress,
      feeRate,
      priorityFee: 0n,
      entries,
      networkId: TN10_RPC_NETWORK_ID
    });

    const pending = built && Array.isArray(built.transactions) ? built.transactions : [];
    if (pending.length === 0) {
      return res.status(500).json({ ok: false, reason: "tn10_faucet_tx_missing", error: "Faucet transaction was not created" });
    }

    const txids: string[] = [];
    for (const tx of pending) {
      tx.sign([faucetPriv], true);
      const txid = await tx.submit(rpc);
      txids.push(String(txid || "").trim().toLowerCase());
    }

    const cleanTxids = txids.filter((txid) => /^[0-9a-f]{64}$/.test(txid));
    if (cleanTxids.length === 0) {
      return res.status(502).json({ ok: false, reason: "tn10_faucet_submit_missing_txid", error: "Faucet submit did not return a txid" });
    }

    const updated = recordTn10FaucetClaim(ctx.repoRoot, {
      userId,
      ymdUtc,
      amountSompi: config.claimSompi,
      txids: cleanTxids,
      dailyLimitSompi: config.dailyLimitSompi
    });

    const updatedClaimedSompi = BigInt(updated.claimed_sompi || "0");
    const updatedRemainingSompi = config.dailyLimitSompi > updatedClaimedSompi ? config.dailyLimitSompi - updatedClaimedSompi : 0n;

    return res.json({
      ok: true,
      network: "tn10",
      networkId: TN10_RPC_NETWORK_ID,
      address: toAddress,
      txid: cleanTxids[cleanTxids.length - 1],
      txids: cleanTxids,
      ymd_utc: ymdUtc,
      amountSompi: formatSompi(config.claimSompi),
      claimedSompi: formatSompi(updatedClaimedSompi),
      remainingSompi: formatSompi(updatedRemainingSompi),
      dailyLimitSompi: formatSompi(config.dailyLimitSompi),
      utcDayLabel: "UTC",
      covenant_exclusion: {
        kind: "tn10_faucet_covenant_exclusion_v1",
        excluded_count: covenantExcludedCount,
        mature_candidate_count: matureEntries.length
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "tn10_faucet_quota_exceeded" ? 429 : 500;
    return res.status(status).json({ ok: false, reason: msg || "tn10_faucet_failed", error: "TN10 faucet claim failed" });
  }
}

export function registerTn10FaucetRoutes(app: Express, ctx: Tn10FaucetCtx): void {
  app.post("/api/tn10-faucet/claim", (req, res) => {
    void handleTn10FaucetClaim(req, res, ctx);
  });
}
