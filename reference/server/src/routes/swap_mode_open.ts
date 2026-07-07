import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import type { AppNetworkKey } from "../types";
import {
  addressPrefixFromAppNetworkKey,
  getEnabledNetworkKeys,
  getNetworkRegistryEntry,
  kasplexNetworkIdFromAppNetworkKey,
  normalizeAppNetworkKey,
  rpcNetworkIdFromAppNetworkKey
} from "../networks";

// NOTE: wasm import path is one level deeper than server.ts (routes/ => ../../../)
import {
  RpcClient,
  createTransactions,
  kaspaToSompi,
  Mnemonic,
  PrivateKeyGenerator,
  XPrv,
  ScriptBuilder,
  Opcodes,
  addressFromScriptPublicKey,
  FeeSource,
  calculateTransactionFee
} from "../../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

export type SwapModeOpenCtx = {
  repoRoot: string;

  ensureKaspaReady: (repoRootPath: string) => Promise<void>;
  getSharedRpc: (networkId: string) => Promise<RpcClient>;

  readWalletStore: (repoRootPath: string, userId: string) => any;
  readOffersStore: (repoRootPath: string) => any;
  writeOffersStore: (repoRootPath: string, store: any) => void;

  kasplexGetAddressTokenList: (network: string, address: string) => Promise<any>;
  resolveKrc20TokenMetadata?: (input: {
    networkId: AppNetworkKey;
    lookup: {
      kind: "ca" | "tick";
      value: string;
    };
    options?: {
      timeoutMs?: number;
    };
  }) => Promise<{
    ok: boolean;
    data?: {
      identity?: {
        ca?: string | null;
        name?: string | null;
        decimals?: number | null;
      };
      issuance?: {
        maxRaw?: string | null;
      };
      stats?: {
        mintedRaw?: string | null;
        holderTotal?: string | null;
        transferTotal?: string | null;
        mintTotal?: string | null;
      };
    };
  }>;
  cnRecipientGatesFromPolicy?: (cfg: any) => {
    regulated_cas: string[];
    recipient_allowlist: string[];
  };

  getAppConfig: (repoRootPath: string) => any;
  sleepMs: (ms: number) => Promise<void>;

  decodePskbPayloadArray: (pskb: string) => any[];

  validateSwapPskb: (
    repoRootPath: string,
    args: { phase: "offer" | "accept" | "finalize"; kind: "tick_to_kas" | "ca_to_kas"; pskb: string }
  ) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
};


const KCC20_ATOMIC_SWAP_LOCKS_FILE_NAME = "programmable-kas-atomic-swap-locks.v1.json";

function kcc20AtomicSompiToKasText(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return "";
  const sompi = BigInt(raw);
  const whole = sompi / 100000000n;
  const frac = sompi % 100000000n;
  const fracText = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return fracText ? `${whole.toString()}.${fracText}` : whole.toString();
}

function kcc20AtomicTokenDecimals(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 18) return 0;
  return n;
}

function kcc20AtomicRawToTokenAmountText(value: unknown, decimalsValue: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return "";

  const decimals = kcc20AtomicTokenDecimals(decimalsValue);
  if (decimals === 0) return BigInt(raw).toString();

  let text = BigInt(raw).toString();
  while (text.length <= decimals) text = `0${text}`;

  const whole = text.slice(0, text.length - decimals) || "0";
  const frac = text.slice(text.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function kcc20AtomicSwapRecordIsOpenLike(record: any): boolean {
  return !!record && String(record.record_status || "").trim() === "locked_live_verified";
}

function kcc20AtomicSwapOfferIsOpenLike(offer: any): boolean {
  const atomicKind = String(offer?.atomic_swap_kind || "").trim();
  const state = String(offer?.state || "").trim().toLowerCase() || "open";
  if (atomicKind === "kcc20_atomic_direct_maker_lock_v1") return state === "atomic_locked";
  return state === "open";
}

function kcc20AtomicSwapOfferId(sourceOutpointKey: string): string {
  const safe = String(sourceOutpointKey || "").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return safe ? `KCC20_ATOMIC_${safe}` : `KCC20_ATOMIC_UNKNOWN`;
}

function readKcc20AtomicSwapOfferItems(repoRoot: string, userId: string): any[] {
  const locksPath = path.join(repoRoot, "data", "users", userId, KCC20_ATOMIC_SWAP_LOCKS_FILE_NAME);
  if (!fs.existsSync(locksPath)) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(locksPath, "utf8"));
  } catch {
    return [];
  }

  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  return records
    .filter((record: any) => record && typeof record === "object")
    .filter((record: any) => String(record.record_kind || "") === "kcc20_atomic_swap_maker_lock_v1")
    .filter(kcc20AtomicSwapRecordIsOpenLike)
    .map((record: any) => {
      const sourceOutpointKey = String(record.source_outpoint_key || "").trim();
      const tokenSymbol = String(record.token_symbol || "OMA_L1").trim() || "OMA_L1";
      const tokenName = String(record.token_name || tokenSymbol).trim() || tokenSymbol;
      const assetCovenantId = String(record.asset_covenant_id || record.covenant_id || "").trim().toLowerCase();
      const kasPriceSompi = String(record.kas_price_sompi || "").trim();
      const kasPriceKas = String(record.kas_price_kas || "").trim() || kcc20AtomicSompiToKasText(kasPriceSompi);
      const decimals = kcc20AtomicTokenDecimals(record.decimals);
      const lockAmountRaw = String(record.lock_amount_raw || record.swap_locked_holder_amount_raw || "").trim();
      const lockAmountHuman = String(record.lock_amount_human || "").trim() || kcc20AtomicRawToTokenAmountText(lockAmountRaw, decimals);
      const createdAt = String(record.created_at || "").trim() || new Date(0).toISOString();
      const updatedAt = String(record.updated_at || createdAt).trim() || createdAt;
      const offerTtlSecondsRaw = Number(record.offer_ttl_seconds ?? 0);
      const offerTtlSeconds = Number.isFinite(offerTtlSecondsRaw) && offerTtlSecondsRaw > 0
        ? Math.floor(offerTtlSecondsRaw)
        : 0;
      const offerExpiresAtRaw = String(record.offer_expires_at || "").trim();
      const offerExpiresAt = offerExpiresAtRaw || null;

      return {
        offerId: kcc20AtomicSwapOfferId(sourceOutpointKey),
        state: "atomic_locked",
        atomic_swap_kind: "kcc20_atomic_direct_maker_lock_v1",
        atomic_swap_mode: "direct_fixed_recipient_atomic_swap_v1",
        atomic_swap_source_outpoint_key: sourceOutpointKey,
        atomic_swap_policy_body_redeem_script_sha256: String(record.policy_body_redeem_script_sha256 || "").trim().toLowerCase(),
        createdAt,
        updatedAt,
        ttl: offerTtlSeconds,
        expiresAt: offerExpiresAt,
        offer_ttl_seconds: offerTtlSeconds,
        offer_expires_at: offerExpiresAt,
        sell: { type: "KAS", symbol: "KAS" },
        buy: {
          type: "OMA_L1_COVENANT_TOKEN",
          symbol: tokenSymbol,
          name: tokenName,
          asset_covenant_id: assetCovenantId,
          decimals,
          standard: "oma_l1_covenant_token_profile_v0_1",
          route: "kcc20_atomic_swap_claim"
        },
        sellAmount: kasPriceKas,
        buyAmount: lockAmountHuman,
        buyAmountRaw: lockAmountRaw,
        tokenAmount: lockAmountHuman,
        tokenAmountRaw: lockAmountRaw,
        price: kasPriceKas,
        partial: { enabled: false },
        networkId: String(record.networkId || record.network || "").trim(),
        makerWalletId: String(record.maker_wallet_id || record.wallet_id || "").trim(),
        makerReceiveAddress: String(record.maker_kas_receive_address || "").trim(),
        makerTokenRefundAddress: String(record.maker_token_refund_address || "").trim(),
        takerTokenReceiveAddress: String(record.taker_token_receive_address || "").trim(),
        asset_covenant_id: assetCovenantId,
        tokenSymbol,
        tokenName,
        decimals,
        lock_amount_raw: lockAmountRaw,
        lock_amount_human: lockAmountHuman,
        swap_locked_holder_amount_raw: lockAmountRaw,
        kas_price_sompi: kasPriceSompi,
        kas_price_kas: kasPriceKas,
        refund_lock_daa: String(record.refund_lock_daa || "").trim(),
        source_outpoint_key: sourceOutpointKey,
        covenant_id: String(record.covenant_id || "").trim().toLowerCase(),
        submitted_txid: String(record.submitted_txid || "").trim(),
        source: "kcc20_atomic_swap"
      };
    });
}

function appNetworkKeyFromKaspaAddress(address: string): AppNetworkKey | null {
  const raw = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!raw) return null;

  for (const networkKey of getEnabledNetworkKeys()) {
    const entry = getNetworkRegistryEntry(networkKey);
    const expectedPrefix = `${entry.address_prefix}:`;
    if (raw.startsWith(expectedPrefix)) {
      return networkKey;
    }
  }

  return null;
}

export function registerSwapModeOpenRoutes(app: Express, ctx: SwapModeOpenCtx): void {
  // Bind server.ts-scope dependencies into local names so the pasted bodies remain unchanged.
  const {
    repoRoot,
    ensureKaspaReady,
    getSharedRpc,
    readWalletStore,
    readOffersStore,
    writeOffersStore,
    kasplexGetAddressTokenList,
    resolveKrc20TokenMetadata,
    cnRecipientGatesFromPolicy,
    getAppConfig,
    sleepMs,
    decodePskbPayloadArray,
    validateSwapPskb
  } = ctx;

  app.post("/api/offers/analyze", async (req, res) => {
    try {
      const body: any = (req as any).body ?? null;
  
      if (!body || typeof body !== "object") {
        return res.json({ ok: false, reason: "invalid_json", blockers: ["invalid_json"], notes: [] });
      }
  
      const blockers: string[] = [];
      const notes: string[] = [];
  
      const sell: any = body.sell && typeof body.sell === "object" ? body.sell : {};
      const buy: any = body.buy && typeof body.buy === "object" ? body.buy : {};
  
      const sellType = typeof sell.type === "string" ? sell.type.trim().toUpperCase() : "";
      const sellSymRaw = typeof sell.symbol === "string" ? sell.symbol.trim() : "";
  
      const buyType = typeof buy.type === "string" ? buy.type.trim().toUpperCase() : "";
      const buySymRaw = typeof buy.symbol === "string" ? buy.symbol.trim().toUpperCase() : "";
  
      // M4-KRC-4a: Maker sells KRC20 (TICK or CA) for KAS (no partial fills yet).
      if (sellType !== "KRC20") blockers.push("sell_type_invalid");
  
      const parsedSell = (() => {
        const sym = sellSymRaw ? sellSymRaw.trim() : "";
        if (!sym) return { kind: "", ticker: "", caHex: "", symbol: "" };
  
        if (/^CA:/i.test(sym)) {
          const h = sym.slice(3).trim().toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(h)) return { kind: "", ticker: "", caHex: "", symbol: "" };
          return { kind: "CA", ticker: "", caHex: h, symbol: `CA:${h}` };
        }
  
        const t = sym.toUpperCase();
        if (!/^[A-Za-z0-9]{1,16}$/.test(t)) return { kind: "", ticker: "", caHex: "", symbol: "" };
        return { kind: "TICK", ticker: t, caHex: "", symbol: t };
      })();
  
      const sellKind = parsedSell.kind;
      const sellTicker = parsedSell.ticker;
      const sellCaHex = parsedSell.caHex;
      const sellSymbol = parsedSell.symbol;
  
      if (!sellKind) blockers.push("sell_asset_invalid");
  
      if (buyType !== "KAS") blockers.push("buy_asset_invalid");
      if (buyType === "KAS" && buySymRaw && buySymRaw !== "KAS") blockers.push("buy_asset_invalid");
  
      const sellAmountStr =
        typeof body.sell_amount === "string" || typeof body.sell_amount === "number"
          ? String(body.sell_amount).trim()
          : typeof body.amount === "string" || typeof body.amount === "number"
            ? String(body.amount).trim()
            : "";
  
      if (!sellAmountStr) {
        blockers.push("invalid_amount");
      } else if (!/^[0-9]+(\.[0-9]+)?$/.test(sellAmountStr)) {
        blockers.push("invalid_amount");
      } else {
        const n = Number(sellAmountStr);
        if (!Number.isFinite(n)) blockers.push("invalid_amount");
        else if (n <= 0) blockers.push("amount_must_be_positive");
      }
  
      const buyAmountStr =
        typeof body.buy_amount === "string" || typeof body.buy_amount === "number"
          ? String(body.buy_amount).trim()
          : "";
  
      if (!buyAmountStr) {
        blockers.push("invalid_amount");
      } else if (!/^[0-9]+(\.[0-9]+)?$/.test(buyAmountStr)) {
        blockers.push("invalid_amount");
      } else {
        const n = Number(buyAmountStr);
        if (!Number.isFinite(n)) blockers.push("invalid_amount");
        else if (n <= 0) blockers.push("amount_must_be_positive");
      }
  
      const ttlRaw = typeof body.ttl === "number" || typeof body.ttl === "string" ? Number(body.ttl) : NaN;
      const ttl = Number.isFinite(ttlRaw) ? Math.round(ttlRaw) : 0;
  
      if (!Number.isFinite(ttlRaw)) {
        blockers.push("ttl_invalid");
      } else if (ttl !== 0 && (ttl < 60 || ttl > 168 * 60 * 60)) {
        blockers.push("ttl_out_of_range");
      }
  
      const partial: any = body.partial && typeof body.partial === "object" ? body.partial : {};
      if (partial && partial.enabled) blockers.push("partial_fields_invalid");
  
      const receiveEndpoint: any =
        body.receiveEndpoint && typeof body.receiveEndpoint === "object" ? body.receiveEndpoint : null;
      const recvAddr =
        receiveEndpoint && typeof receiveEndpoint.address === "string" ? receiveEndpoint.address.trim() : "";
  
      if (buyType === "KAS") {
        if (!recvAddr || !appNetworkKeyFromKaspaAddress(recvAddr)) {
          blockers.push("buy_asset_invalid");
        }
      }
  
      let heldAmount: number | null = null;
      let sellDecimals: number | null = null;
      let sellName: string | null = null;
      let sellOk: boolean | null = null;
      let sellNetwork: AppNetworkKey | null = null;
      let sellResolvedCa: string | null = sellKind === "CA" ? sellCaHex : null;
      let sellMaxSupply: string | null = null;
      let sellTotalMinted: string | null = null;
      let sellHolderTotal: string | null = null;
      let sellTransferTotal: string | null = null;
      let sellMintTotal: string | null = null;
  
      const normalizeCA = (s: string): string => {
        const raw = String(s || "").trim();
        const h = /^CA:/i.test(raw) ? raw.slice(3).trim() : raw;
        return h.toLowerCase();
      };
  
      const sellAmountNum = Number(sellAmountStr);
  
      if (sellKind && Number.isFinite(sellAmountNum) && sellAmountNum > 0) {
        try {
          const maker: any = body.maker && typeof body.maker === "object" ? body.maker : {};
          const wid = typeof maker.wid === "string" ? maker.wid.trim() : "";
          const fromAddr = typeof maker.fromAddr === "string" ? maker.fromAddr.trim() : "";
  
          const userId = String((res.locals as any).td_user_id || "").trim();
          if (!userId) {
            return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
          }

          let network: AppNetworkKey | null = null;
          try {
            const ws = readWalletStore(repoRoot, userId);
            const w = wid ? ws.items.find((it: any) => it && it.id === wid) : null;
            network =
              w && typeof (w as any).network === "string"
                ? normalizeAppNetworkKey((w as any).network)
                : null;
          } catch {
            network = null;
          }
  
          if (!network && fromAddr) {
            network = appNetworkKeyFromKaspaAddress(fromAddr);
          }

          sellNetwork = network;

          if (network && fromAddr) {
            const expectedPrefix = `${addressPrefixFromAppNetworkKey(network)}:`;
            if (!fromAddr.startsWith(expectedPrefix)) {
              notes.push("Analyzer: holdings lookup skipped (maker address/network mismatch).");
            } else {
              const holdings = await kasplexGetAddressTokenList(
                kasplexNetworkIdFromAppNetworkKey(network),
                fromAddr
              );
  
              if (sellKind === "TICK") {
                heldAmount = Object.prototype.hasOwnProperty.call(holdings.tokens, sellTicker)
                  ? holdings.tokens[sellTicker]
                  : null;
                sellDecimals = Object.prototype.hasOwnProperty.call(holdings.token_dec, sellTicker)
                  ? holdings.token_dec[sellTicker]
                  : null;

                const issueRows = Array.isArray(holdings.issue) ? holdings.issue : [];
                const tickHit = issueRows.find((x: any) => {
                  const tickValue =
                    typeof x?.tick === "string" ? x.tick.trim().toUpperCase() :
                    typeof x?.ticker === "string" ? x.ticker.trim().toUpperCase() :
                    typeof x?.symbol === "string" ? x.symbol.trim().toUpperCase() :
                    "";
                  return !!sellTicker && tickValue === sellTicker;
                });

                if (tickHit) {
                  if (typeof tickHit.dec === "number" && sellDecimals == null) {
                    sellDecimals = tickHit.dec;
                  }
                  if (tickHit.name && !sellName) {
                    sellName = String(tickHit.name);
                  }
                  if (tickHit.ca && !sellResolvedCa) {
                    sellResolvedCa = normalizeCA(String(tickHit.ca));
                  }
                }
              } else if (sellKind === "CA") {
                const hit = holdings.issue.find((x: any) => normalizeCA(x.ca) === sellCaHex);
                if (hit) {
                  heldAmount = typeof hit.amount === "number" ? hit.amount : null;
                  sellDecimals = typeof hit.dec === "number" ? hit.dec : null;
                  sellName = hit.name ? String(hit.name) : null;
                }
              }
  
              if (heldAmount != null) {
                sellOk = heldAmount >= sellAmountNum;
              }
            }
          } else {
            notes.push("Analyzer: holdings lookup skipped (missing network or maker address).");
          }
        } catch (e) {
          notes.push(`Analyzer: holdings lookup failed (${String((e as any)?.message || e)}).`);
        }
      }
  
      if (sellKind && resolveKrc20TokenMetadata && sellNetwork) {
        try {
          const metadataNetworkId: AppNetworkKey = sellNetwork;

          const mergeResolvedMetadata = (metadata: any) => {
            if (!metadata || metadata.ok !== true || !metadata.data) return;

            if (metadata.data.identity?.ca) {
              sellResolvedCa = String(metadata.data.identity.ca).trim().toLowerCase();
            }
            if (metadata.data.identity?.name && !sellName) {
              sellName = String(metadata.data.identity.name);
            }
            if (typeof metadata.data.identity?.decimals === "number" && sellDecimals == null) {
              sellDecimals = metadata.data.identity.decimals;
            }
            if (metadata.data.issuance?.maxRaw && sellMaxSupply == null) {
              sellMaxSupply = String(metadata.data.issuance.maxRaw);
            }
            if (metadata.data.stats?.mintedRaw && sellTotalMinted == null) {
              sellTotalMinted = String(metadata.data.stats.mintedRaw);
            }
            if (metadata.data.stats?.holderTotal != null && sellHolderTotal == null) {
              sellHolderTotal = metadata.data.stats.holderTotal;
            }
            if (metadata.data.stats?.transferTotal != null && sellTransferTotal == null) {
              sellTransferTotal = metadata.data.stats.transferTotal;
            }
            if (metadata.data.stats?.mintTotal != null && sellMintTotal == null) {
              sellMintTotal = metadata.data.stats.mintTotal;
            }
          };

          const metadataLookups: Array<{ kind: "ca" | "tick"; value: string }> = [];

          if (sellKind === "CA") {
            if (sellCaHex) {
              metadataLookups.push({ kind: "ca", value: sellCaHex });
            }
          } else {
            const tickCandidates = [
              sellTicker,
              sellSymRaw ? sellSymRaw.trim() : "",
              sellTicker ? sellTicker.toLowerCase() : ""
            ];

            const seenTickValues = new Set<string>();
            for (const rawValue of tickCandidates) {
              const value = String(rawValue || "").trim();
              if (!value) continue;
              const dedupeKey = `tick:${value}`;
              if (seenTickValues.has(dedupeKey)) continue;
              seenTickValues.add(dedupeKey);
              metadataLookups.push({ kind: "tick", value });
            }
          }

          if (metadataNetworkId && metadataLookups.length > 0) {
            for (const lookup of metadataLookups) {
              const metadata = await resolveKrc20TokenMetadata({
                networkId: metadataNetworkId,
                lookup
              });
              mergeResolvedMetadata(metadata);
            }

            const shouldFollowResolvedCa =
              !!sellResolvedCa &&
              (
                !sellName ||
                sellMaxSupply == null ||
                sellTotalMinted == null ||
                sellHolderTotal == null ||
                sellTransferTotal == null ||
                sellMintTotal == null
              );

            const resolvedCaForLookup = typeof sellResolvedCa === "string"
              ? sellResolvedCa.trim().toLowerCase()
              : "";

            if (shouldFollowResolvedCa && resolvedCaForLookup) {
              const caMetadata = await resolveKrc20TokenMetadata({
                networkId: metadataNetworkId,
                lookup: { kind: "ca" as const, value: resolvedCaForLookup }
              });
              mergeResolvedMetadata(caMetadata);
            }
          }
        } catch (e) {
          notes.push(`Analyzer: token metadata lookup failed (${String((e as any)?.message || e)}).`);
        }
      }

      if (!sellName) {
        if (sellKind === "TICK" && sellTicker) {
          sellName = sellTicker;
        } else if (sellKind === "CA" && sellResolvedCa) {
          sellName = `CA:${sellResolvedCa}`;
        }
      }

      const complianceOnlyDerived = (() => {
        if (sellKind !== "CA") return false;
        if (!sellResolvedCa || !cnRecipientGatesFromPolicy) return false;
        try {
          const gates = cnRecipientGatesFromPolicy(getAppConfig(repoRoot));
          return Array.isArray(gates.regulated_cas) && gates.regulated_cas.includes(sellResolvedCa);
        } catch {
          return false;
        }
      })();

      const uniqueBlockers = Array.from(new Set(blockers));

      notes.push("Analyzer: M4-KRC-4a (KRC20 TICK/CA for KAS).");
  
      const buyAmountNum = Number(buyAmountStr);
      const impliedPrice =
        Number.isFinite(sellAmountNum) && sellAmountNum > 0 && Number.isFinite(buyAmountNum) && buyAmountNum > 0
          ? buyAmountNum / sellAmountNum
          : null;
  
      const assetMeta = {
        sell: {
          symbol: sellSymbol,
          ticker: sellKind === "TICK" ? sellTicker : "",
          name: sellName || "",
          decimals: sellDecimals,
          kind: sellKind || "KRC20",
          ca: sellResolvedCa,
          totalMinted: sellTotalMinted,
          maxSupply: sellMaxSupply,
          holderTotal: sellHolderTotal,
          transferTotal: sellTransferTotal,
          mintTotal: sellMintTotal,
          primaryMarket: null
        },
        buy: { symbol: "KAS", ticker: "KAS", name: "Kaspa", decimals: 8, kind: "KAS" }
      };
  
      const priceRefs = {
        kas: { symbol: "KAS", kind: "KAS", price_kas: 1 },
        sell: {
          symbol: sellSymbol,
          kind: sellKind || "KRC20",
          price_kas: impliedPrice,
          value_kas: Number.isFinite(buyAmountNum) ? buyAmountNum : null
        },
        buy: { symbol: "KAS", kind: "KAS", price_kas: 1, value_kas: Number.isFinite(buyAmountNum) ? buyAmountNum : null }
      };
  
      const solvency = { sell_ok: sellOk, held_amount: heldAmount, held_decimals: sellDecimals };
  
      return res.json({
        ok: true,
        blockers: uniqueBlockers,
        notes,
        assetMeta,
        price: impliedPrice,
        priceRefs,
        solvency,
        complianceOnlyDerived,
        trade: {
          sell: { type: "KRC20", symbol: sellSymbol, name: sellName || "" },
          buy: { type: "KAS", symbol: "KAS" },
          sell_amount: sellAmountStr,
          buy_amount: buyAmountStr,
          ttl,
          partial: { enabled: false },
          price: impliedPrice
        },
        sell_amount: sellAmountStr,
        buy_amount: buyAmountStr,
        ttl,
        partial: { enabled: false },
        receiveEndpoint: receiveEndpoint || null
      });
    } catch (err) {
      return res.json({ ok: false, reason: "invalid_json", blockers: ["invalid_json"], notes: [String(err)] });
    }
  });
  
  app.get("/api/offers/list", async (req, res) => {
    try {
      const qStateRaw: any = (req as any).query ? (req as any).query.state : undefined;
      const qState = typeof qStateRaw === "string" ? qStateRaw.trim().toLowerCase() : "open";

      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const normalizeWalletAddress = (value: unknown): string => {
        return typeof value === "string" ? value.trim().toLowerCase() : "";
      };

      const walletStore = readWalletStore(repoRoot, userId);
      const activeWalletId = typeof walletStore?.active_id === "string" ? walletStore.active_id.trim() : "";
      const activeWallet = activeWalletId
        ? (Array.isArray(walletStore?.items) ? walletStore.items.find((it: any) => it && it.id === activeWalletId) ?? null : null)
        : null;
      const activeWalletAddressNorm = normalizeWalletAddress(activeWallet && typeof activeWallet.address0 === "string" ? activeWallet.address0 : "");

      const store = readOffersStore(repoRoot);
      const nowMs = Date.now();

      const isExpired = (o: any): boolean => {
        if (!o || typeof o !== "object") return false;

        if (typeof o.expiresAt === "string" && o.expiresAt.trim()) {
          const t = Date.parse(o.expiresAt);
          if (Number.isFinite(t) && t > 0) return t <= nowMs;
        }

        const ttl = typeof o.ttl === "number" ? o.ttl : 0;
        if (ttl > 0 && typeof o.createdAt === "string" && o.createdAt.trim()) {
          const c = Date.parse(o.createdAt);
          if (Number.isFinite(c) && c > 0) return (c + ttl * 1000) <= nowMs;
        }

        return false;
      };

      const resolveBuyCaNameForOffer = async (o: any): Promise<string> => {
        if (!resolveKrc20TokenMetadata || !o || typeof o !== "object") return "";

        const buy = o.buy && typeof o.buy === "object" ? o.buy : null;
        const buySymbol = buy && typeof buy.symbol === "string" ? buy.symbol.trim() : "";
        if (!/^CA:/i.test(buySymbol)) return "";

        const caHex = buySymbol.slice(3).trim().toLowerCase();
        if (!caHex || !/^[0-9a-f]+$/.test(caHex)) return "";

        const networkKey = normalizeAppNetworkKey(o.networkId);
        if (!networkKey) return "";

        try {
          const metadata = await resolveKrc20TokenMetadata({
            networkId: networkKey,
            lookup: { kind: "ca", value: caHex }
          });

          const name = metadata && metadata.ok === true && metadata.data?.identity?.name
            ? String(metadata.data.identity.name).trim()
            : "";

          return name && name !== `CA:${caHex}` ? name : "";
        } catch {
          return "";
        }
      };

      const atomicItemsRaw = readKcc20AtomicSwapOfferItems(repoRoot, userId);
      const itemsRaw = [
        ...(Array.isArray(store.items) ? store.items : []),
        ...atomicItemsRaw
      ];
      const visibleItems = itemsRaw.filter((o: any) => {
        if (!o || typeof o !== "object") return false;

        const directedToNorm = normalizeWalletAddress(o.takerTokenReceiveAddress);
        if (directedToNorm) {
          if (!activeWalletAddressNorm) return false;
          if (directedToNorm !== activeWalletAddressNorm) return false;
        }

        const state = (typeof o.state === "string" && o.state.trim()) ? o.state.trim().toLowerCase() : "open";
        const expired = isExpired(o);

        if (qState === "open") {
          return kcc20AtomicSwapOfferIsOpenLike(o) && !expired;
        }

        if (qState === "filled") return state === "filled";
        if (qState === "cancelled") return state === "cancelled";
        if (qState === "expired") return expired || state === "expired";

        return !expired;
      });

      const items = await Promise.all(visibleItems.map(async (o: any) => {
        const buyName = await resolveBuyCaNameForOffer(o);
        if (!buyName) return o;

        const buy = o.buy && typeof o.buy === "object" ? o.buy : {};
        return {
          ...o,
          buy: {
            ...buy,
            name: buyName
          }
        };
      }));

      return res.json({ ok: true, items });
    } catch (err) {
      return res.json({
        ok: false,
        reason: "offers_list_failed",
        error: String(err)
      });
    }
  });

  app.get("/api/offers/mine", async (req, res) => {
    try {
      const historyRaw: any = (req as any).query ? (req as any).query.history : undefined;
      const includeHistory = historyRaw === "1" || historyRaw === "true" || historyRaw === "yes";

      const userId = String((res.locals as any).td_user_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      }

      const walletStore = readWalletStore(repoRoot, userId);
      const activeWalletId = typeof walletStore?.active_id === "string" ? walletStore.active_id.trim() : "";
      if (!activeWalletId) {
        return res.json({ ok: true, items: [], active_wallet_id: "", history: includeHistory });
      }

      const store = readOffersStore(repoRoot);
      const nowMs = Date.now();

      const isExpired = (o: any): boolean => {
        if (!o || typeof o !== "object") return false;

        if (typeof o.expiresAt === "string" && o.expiresAt.trim()) {
          const t = Date.parse(o.expiresAt);
          if (Number.isFinite(t) && t > 0) return t <= nowMs;
        }

        const ttl = typeof o.ttl === "number" ? o.ttl : 0;
        if (ttl > 0 && typeof o.createdAt === "string" && o.createdAt.trim()) {
          const c = Date.parse(o.createdAt);
          if (Number.isFinite(c) && c > 0) return (c + ttl * 1000) <= nowMs;
        }

        return false;
      };

      const resolveBuyCaNameForOffer = async (o: any): Promise<string> => {
        if (!resolveKrc20TokenMetadata || !o || typeof o !== "object") return "";

        const buy = o.buy && typeof o.buy === "object" ? o.buy : null;
        const buySymbol = buy && typeof buy.symbol === "string" ? buy.symbol.trim() : "";
        if (!/^CA:/i.test(buySymbol)) return "";

        const caHex = buySymbol.slice(3).trim().toLowerCase();
        if (!caHex || !/^[0-9a-f]+$/.test(caHex)) return "";

        const networkKey = normalizeAppNetworkKey(o.networkId);
        if (!networkKey) return "";

        try {
          const metadata = await resolveKrc20TokenMetadata({
            networkId: networkKey,
            lookup: { kind: "ca", value: caHex }
          });

          const name = metadata && metadata.ok === true && metadata.data?.identity?.name
            ? String(metadata.data.identity.name).trim()
            : "";

          return name && name !== `CA:${caHex}` ? name : "";
        } catch {
          return "";
        }
      };

      const atomicItemsRaw = readKcc20AtomicSwapOfferItems(repoRoot, userId);
      const itemsRaw = [
        ...(Array.isArray(store.items) ? store.items : []),
        ...atomicItemsRaw
      ];
      const mineRaw = itemsRaw.filter((o: any) => {
        if (!o || typeof o !== "object") return false;
        if (String(o.makerWalletId || "").trim() !== activeWalletId) return false;

        const state = (typeof o.state === "string" && o.state.trim()) ? o.state.trim().toLowerCase() : "open";
        const expired = isExpired(o);

        if (includeHistory) return true;
        return kcc20AtomicSwapOfferIsOpenLike(o) && !expired;
      });

      const items = await Promise.all(mineRaw.map(async (o: any) => {
        const buyName = await resolveBuyCaNameForOffer(o);
        if (!buyName) return o;

        const buy = o.buy && typeof o.buy === "object" ? o.buy : {};
        return {
          ...o,
          buy: {
            ...buy,
            name: buyName
          }
        };
      }));

      return res.json({ ok: true, items, active_wallet_id: activeWalletId, history: includeHistory });
    } catch (err) {
      return res.json({
        ok: false,
        reason: "offers_mine_failed",
        error: String(err)
      });
    }
  });
  
  app.post("/api/offers/accept", async (req, res) => {
    let stage = "start";
  
    try {
      stage = "parse_body";
      const body: any = (req as any).body ?? null;
      if (!body || typeof body !== "object") {
        return res.json({ ok: false, reason: "invalid_json", blockers: ["invalid_json"] });
      }
  
      const offerId = typeof body.offerId === "string" ? body.offerId.trim() : "";
      const fillSizeStr = typeof body.fillSize === "string" ? body.fillSize.trim() : "";
      const takerWallet = body.takerWallet && typeof body.takerWallet === "object" ? body.takerWallet : {};
      const takerWid = typeof takerWallet.wid === "string" ? takerWallet.wid.trim() : "";
      const takerAddress = typeof takerWallet.address === "string" ? takerWallet.address.trim() : "";
  
      if (!offerId) {
        return res.json({ ok: false, reason: "missing_offerId", blockers: ["missing_offerId"] });
      }
      if (!fillSizeStr) {
        return res.json({ ok: false, reason: "missing_fillSize", blockers: ["missing_fillSize"] });
      }
      if (!takerAddress) {
        return res.json({ ok: false, reason: "missing_taker_address", blockers: ["missing_taker_address"] });
      }
  
      stage = "load_offer";
      const store = readOffersStore(repoRoot);
      const itemsRaw = Array.isArray((store as any)?.items) ? (store as any).items : [];
      const offer: any = itemsRaw.find((o: any) => o && typeof o === "object" && (o.offerId === offerId || o.offer_id === offerId)) ?? null;
  
      if (!offer) {
        return res.json({ ok: false, reason: "offer_not_found", blockers: ["offer_not_found"] });
      }
  
      stage = "validate_offer_state";
      if (String(offer.state || "").toLowerCase() !== "open") {
        return res.json({ ok: false, reason: "offer_not_open", blockers: ["offer_not_open"] });
      }
  
      stage = "validate_offer_expiry";
      const nowMs = Date.now();
      const expiresAt = typeof offer.expiresAt === "string" ? offer.expiresAt.trim() : "";
      if (expiresAt) {
        const t = Date.parse(expiresAt);
        if (Number.isFinite(t) && t > 0 && t <= nowMs) {
          return res.json({ ok: false, reason: "offer_expired", blockers: ["offer_expired"] });
        }
      } else {
        const ttl = typeof offer.ttl === "number" ? offer.ttl : 0;
        const createdAt = typeof offer.createdAt === "string" ? offer.createdAt.trim() : "";
        if (ttl > 0 && createdAt) {
          const c = Date.parse(createdAt);
          if (Number.isFinite(c) && c > 0 && (c + ttl * 1000) <= nowMs) {
            return res.json({ ok: false, reason: "offer_expired", blockers: ["offer_expired"] });
          }
        }
      }
  
      stage = "validate_fill_size";
      const offerSellAmount = String(offer.sellAmount ?? offer.sell_amount ?? "").trim();
      if (!offerSellAmount) {
        return res.json({ ok: false, reason: "offer_missing_sellAmount", blockers: ["offer_missing_sellAmount"] });
      }
      if (fillSizeStr !== offerSellAmount) {
        return res.json({
          ok: false,
          reason: "partial_fills_disabled",
          blockers: ["partial_fills_disabled", "fill_must_equal_full_sellAmount"]
        });
      }
  
      stage = "validate_swap_fields";
      const kind = typeof offer.swapKind === "string" ? offer.swapKind.trim() : "";
      const pskb = typeof offer.swapPskb === "string" ? offer.swapPskb.trim() : "";
      const p2shAddress = typeof offer.swapP2shAddress === "string" ? offer.swapP2shAddress.trim() : "";
      const commitTxids = Array.isArray(offer.swapCommitTxids) ? offer.swapCommitTxids : [];
  
      if (kind !== "tick_to_kas" && kind !== "ca_to_kas") {
        return res.json({ ok: false, reason: "offer_bad_swapKind", blockers: ["offer_bad_swapKind"] });
      }
      if (!pskb) {
        return res.json({ ok: false, reason: "offer_missing_pskb", blockers: ["offer_missing_pskb"] });
      }
  
      stage = "pskb_decode_proof";
      const arr: any[] = decodePskbPayloadArray(pskb);
      const arrLen = Array.isArray(arr) ? arr.length : 0;
      const p0: any = arrLen > 0 ? arr[0] : null;
      const global0: any = p0?.global ?? null;
      const input0: any = Array.isArray(p0?.inputs) ? p0.inputs[0] : null;
  
      console.log(
        `[offers_accept] proof offerId=${offerId} arrLen=${arrLen} p0Keys=${p0 ? Object.keys(p0).join(",") : "null"}`
      );
      console.log(
        `[offers_accept] proof globalKeys=${global0 ? Object.keys(global0).join(",") : "null"} in0Keys=${input0 ? Object.keys(input0).join(",") : "null"}`
      );
  
      if (arrLen !== 1 || !global0) {
        return res.json({ ok: false, reason: "offer_pskb_bad_shape", blockers: ["offer_pskb_bad_shape"] });
      }
  
      stage = "offer_internal_validate";
      const v = await validateSwapPskb(repoRoot, { phase: "offer", kind, pskb });
      if (!v.ok) {
        return res.json({
          ok: false,
          reason: "offer_internal_validation_failed",
          blockers: Array.isArray(v.errors) && v.errors.length ? v.errors : ["offer_internal_validation_failed"],
          warnings: v.warnings
        });
      }
  
      stage = "build_preview";
      const sellObj: any = offer.sell && typeof offer.sell === "object" ? offer.sell : {};
      const buyObj: any = offer.buy && typeof offer.buy === "object" ? offer.buy : {};
  
      const sendContext: any = {
        offerId,
        amount: offerSellAmount,
        assetId: typeof sellObj.symbol === "string" ? sellObj.symbol : "KAS",
        assetKind: typeof sellObj.type === "string" ? sellObj.type : "KAS",
        address: takerAddress,
        takerWid: takerWid || null
      };
  
      const psktRequest: any = {
        kind,
        offerId,
        fillSize: offerSellAmount,
        pskb,
        p2shAddress: p2shAddress || null,
        commitTxids,
        makerReceiveAddress: typeof offer.makerReceiveAddress === "string" ? offer.makerReceiveAddress : null,
        takerTokenReceiveAddress: typeof offer.takerTokenReceiveAddress === "string" ? offer.takerTokenReceiveAddress : null,
        takerWallet: { wid: takerWid || "", address: takerAddress },
        terms: {
          sell: { type: sellObj.type || null, symbol: sellObj.symbol || null, amount: offerSellAmount },
          buy: { type: buyObj.type || null, symbol: buyObj.symbol || null, amount: String(offer.buyAmount ?? offer.buy_amount ?? "").trim() }
        }
      };
  
      stage = "respond_ok";
      return res.json({ ok: true, offer, sendContext, psktRequest });
    } catch (err) {
      return res.json({
        ok: false,
        reason: `offers_accept_failed:${stage}`,
        blockers: [`offers_accept_failed:${stage}`],
        error: String(err)
      });
    }
  });
}
