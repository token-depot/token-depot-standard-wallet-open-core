"""
OMA Wallet — Offers API (read-only analyzer & metadata bind)
Behavior-Lock: single path, no fallbacks, no parallel send logic.
This module DOES NOT broadcast, sign, or alter the existing /api/wallet/send flow.

Endpoints (all JSON; HTTP 200 with {ok:false,...} on errors):
- POST /api/offers/analyze   → validate payload, fetch market data, and report blockers/notes (read-only; may call server-side price feeds, never signs or broadcasts)
- POST /api/offers/bind      → allocate OFFER_ID and FILL_ID and echo minimal draft metadata

To take effect, the blueprint must be registered in the Flask app factory separately.

Spec refs:
- Swaps Modal flow: Analyze → Make Offer (Bind) → Confirm & Encumber → Complete
- Analyzer is read-only; Bind is metadata-only; encumbrance uses existing wallet routes
"""

from __future__ import annotations

import re
import sys
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Tuple

from flask import Blueprint, jsonify, request

bp = Blueprint("offers_bp", __name__, url_prefix="/api/offers")

# -------- helpers --------

HEX_64_RE = re.compile(r"^[a-fA-F0-9]{64}$")
ERC_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")

def _json() -> Dict[str, Any]:
    try:
        j = request.get_json(force=True, silent=False)  # enforce JSON; raise on invalid
        if not isinstance(j, dict):
            return {}
        return j
    except Exception:
        return {}

def _is_krc20_ticker(s: str) -> bool:
    # Conservative: 2..12 uppercase letters/digits/underscore. (Server registries will validate precisely later.)
    return bool(re.fullmatch(r"[A-Z0-9_]{2,12}", s or ""))

def _is_krc20_ca(s: str) -> bool:
    s = s or ""
    if s.upper().startswith("CA:"):
        s = s[3:]
    return bool(HEX_64_RE.fullmatch(s))

def _is_erc20_addr(s: str) -> bool:
    return bool(ERC_ADDR_RE.fullmatch(s or ""))

def _safe_str(x: Any) -> str:
    try:
        return str(x)
    except Exception:
        return ""

def _validate_receive_endpoint(body: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """
    Validate the optional receiveEndpoint struct sent by the Swaps UI.

    This enforces the v3.2 Receive Endpoint model at a shape/sanity level only:
    - chain_kind ∈ {KASPA, EVM}
    - chain_id is coherent with chain_kind
    - address matches basic kaspa:/0x… expectations
    """
    blockers: List[str] = []
    notes: List[str] = []

    recv = body.get("receiveEndpoint") or {}
    if not isinstance(recv, dict) or not recv:
        # Swaps UI is expected to always send a receiveEndpoint; treat missing as a blocker.
        blockers.append("receive_endpoint_missing")
        return blockers, notes

    chain_kind = _safe_str(recv.get("chain_kind")).upper()
    chain_id   = recv.get("chain_id")
    address    = _safe_str(recv.get("address"))
    source     = _safe_str(recv.get("source") or "")

    if not chain_kind:
        blockers.append("receive_chain_kind_missing")
    elif chain_kind not in ("KASPA", "EVM"):
        blockers.append("receive_chain_kind_invalid")

    if chain_kind == "KASPA":
        if chain_id not in (None, 0):
            blockers.append("receive_chain_id_invalid")
    elif chain_kind == "EVM":
        if not isinstance(chain_id, int):
            blockers.append("receive_chain_id_missing")

    if not address:
        blockers.append("receive_address_missing")
    else:
        if chain_kind == "KASPA":
            # Conservative: must look like a kaspa: address and be reasonably long.
            if not (address.startswith("kaspa:") and len(address) > 12):
                blockers.append("receive_address_invalid")
        elif chain_kind == "EVM":
            if not _is_erc20_addr(address):
                blockers.append("receive_address_invalid")

    if source.lower() == "external":
        notes.append("receive_endpoint_external")

    return blockers, notes

def _mk_id(prefix: str) -> str:
    # Deterministic-friendly ULID substitute using time + uuid4 tail (sortable first half).
    return f"{prefix}_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"

def _echo_err(reason: str, **more):
    out = {"ok": False, "reason": reason}
    out.update({k: v for k, v in more.items() if v is not None})
    return jsonify(out), 200

def _normalize_trade_amounts(body: Dict[str, Any], blockers: List[str], notes: List[str]) -> Dict[str, str] | None:
    """
    Normalize sell_amount / buy_amount from the request body and compute an implied price.

    - sell_amount: how much of the Sell asset the Maker is offering
    - buy_amount:  how much of the Buy asset the Maker wants to receive
    - price:       buy_amount / sell_amount

    On error, appends blocker codes to `blockers` and returns None.
    On success, returns a dict with stringified decimals.
    """
    sell_raw = _safe_str(body.get("sell_amount") or body.get("amount") or "").replace(",", "")
    buy_raw = _safe_str(body.get("buy_amount") or "").replace(",", "")

    if not sell_raw:
        blockers.append("no_sell_amount")
        return None
    if not buy_raw:
        blockers.append("no_buy_amount")
        return None
    try:
        sell_amt = Decimal(sell_raw)
    except (InvalidOperation, ValueError):
        blockers.append("invalid_sell_amount")
        return None
    try:
        buy_amt = Decimal(buy_raw)
    except (InvalidOperation, ValueError):
        blockers.append("invalid_buy_amount")
        return None
    if sell_amt <= 0:
        blockers.append("sell_amount_must_be_positive")
        return None
    if buy_amt <= 0:
        blockers.append("buy_amount_must_be_positive")
        return None
    try:
        price = buy_amt / sell_amt
    except (InvalidOperation, ZeroDivisionError):
        blockers.append("price_computation_failed")
        return None

    # Format the implied price for human-readable output. We clamp to 8 decimal
    # places to avoid extremely long repeating decimals in both the trade note
    # and the API response, while keeping the internal Decimal value intact.
    try:
        price_q = price.quantize(Decimal("0.00000001"))
    except (InvalidOperation, ValueError):
        price_q = price
    price_str = str(price_q.normalize())

    # Enrich trade note with asset symbols and use "offer=" instead of "price=".
    sell_sym = ""
    buy_sym = ""
    try:
        sell_obj = body.get("sell") or {}
        buy_obj = body.get("buy") or {}
        sell_sym = str(
            sell_obj.get("symbol")
            or sell_obj.get("ticker")
            or sell_obj.get("assetId")
            or ""
        ).strip()
        buy_sym = str(
            buy_obj.get("symbol")
            or buy_obj.get("ticker")
            or buy_obj.get("assetId")
            or ""
        ).strip()
    except Exception:
        sell_sym = ""
        buy_sym = ""

    sell_desc = f"{sell_amt} {sell_sym}".strip()
    buy_desc  = f"{buy_amt} {buy_sym}".strip()
    notes.append(f"trade: sell {sell_desc} -> buy {buy_desc} offer={price_str}")

    return {
        "sell_amount": str(sell_amt.normalize()),
        "buy_amount": str(buy_amt.normalize()),
        "price": price_str,
    }

def _normalize_trade_quantities(trade: Dict[str, str] | None) -> Tuple[Decimal, Decimal] | Tuple[None, None]:
    """
    Convert the stringified trade amounts from _normalize_trade_amounts into Decimal quantities.

    This helper is intentionally price-agnostic; it only normalizes leg sizes for the
    trade (sell_amount and buy_amount) and does not perform any valuation.

    Returns (sell_qty, buy_qty) as Decimal pairs when both values parse cleanly,
    or (None, None) if trade is missing or invalid.
    """
    if not trade:
        return None, None

    sell_raw = _safe_str(trade.get("sell_amount") or "")
    buy_raw = _safe_str(trade.get("buy_amount") or "")
    if not sell_raw or not buy_raw:
        return None, None

    try:
        sell_qty = Decimal(sell_raw)
        buy_qty = Decimal(buy_raw)
    except (InvalidOperation, ValueError):
        return None, None

    return sell_qty, buy_qty


class PriceProvider:
    """
    Market data provider for Analyzer (Kas.fyi now; Kasplex later).

    This version knows how to:
      - Resolve the Kas.fyi API key using the same pattern as /api/tokens/top:
        config.yaml -> KAS_FYI_API_KEY -> env KAS_FYI_API_KEY
      - Query kas.fyi for mint-mode KRC-20 tickers via services.krc20_collect.
    It remains deliberately conservative: if anything is misconfigured or the
    upstream API fails, it returns (None, None, reason) instead of raising.
    """

    def _resolve_kasusd_endpoint(self) -> Tuple[str, int]:
        """
        Resolve the canonical KAS→USD price feed.

        By default we use the official Kaspa REST API /info/price endpoint:
          https://api.kaspa.org/info/price

        Optional override in config.yaml:

          MARKET:
            KASUSD_URL: "https://api.kaspa.org/info/price"
            KASUSD_TIMEOUT_SECONDS: 8
        """
        url = ""
        timeout = 8
        try:
            from common.config_loader import load_config
            cfg = load_config() or {}
            market = cfg.get("MARKET") or {}
            url = (market.get("KASUSD_URL") or "").strip()
            t_raw = market.get("KASUSD_TIMEOUT_SECONDS")
            if isinstance(t_raw, (int, float)) and t_raw > 0:
                timeout = int(t_raw)
        except Exception:
            # Fall back to hard-coded defaults below.
            pass

        if not url:
            url = "https://api.kaspa.org/info/price"
        return url, timeout

    def quote_kas(self) -> Tuple[float, float | None]:
        """
        Return (price_kas, price_usd) for 1 KAS.

        price_kas is always 1.0 for KAS-relative pricing in the Analyzer.
        price_usd is looked up from the canonical KASUSD feed (Kaspa REST
        /info/price) when possible; on any failure we fall back to None and
        leave USD fields unpriced.
        """
        url, timeout = self._resolve_kasusd_endpoint()

        try:
            import json
            import urllib.request, urllib.error

            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "ignore")
            js = json.loads(raw)
            price = js.get("price")
            pu = float(price) if price is not None else None
        except Exception:
            pu = None

        # Even if we fail to get a USD quote, 1 KAS is always 1.0 in KAS terms.
        return 1.0, pu

    def _resolve_kasfyi_api_key(self) -> str:
        """
        Resolve the kas.fyi API key using the same precedence as /api/tokens/top:

          1) config.yaml -> KAS_FYI_API_KEY
          2) environment -> KAS_FYI_API_KEY

        (Analyzer does not accept ?apikey= overrides from the request.)
        """
        api_key = ""
        try:
            from common.config_loader import load_config
            cfg = load_config() or {}
            api_key = (cfg.get("KAS_FYI_API_KEY") or "").strip()
        except Exception:
            api_key = ""
        if not api_key:
            try:
                import os
                api_key = (os.getenv("KAS_FYI_API_KEY") or "").strip()
            except Exception:
                api_key = ""
        return api_key

    def _kasfyi_market_row(self, ticker: str) -> Tuple[Dict[str, Any] | None, str]:
        """
        Fetch raw market-data row for a single KRC-20 ticker from kas.fyi.

        Returns (row, reason). On success, row is a dict and reason is "".
        On failure, row is None and reason describes why (missing key, errors, etc.).
        """
        ticker = (ticker or "").strip().upper()
        if not ticker:
            return None, "missing_ticker"

        api_key = self._resolve_kasfyi_api_key()
        if not api_key:
            return None, "missing_kasfyi_api_key"

        try:
            from services.krc20_collect import get_market_data_for
        except Exception:
            return None, "krc20_collect_missing"

        try:
            rows = get_market_data_for([ticker], api_key=api_key)
        except ValueError as ve:
            return None, f"kasfyi_value_error:{ve}"
        except Exception:
            return None, "kasfyi_exception"

        if not rows:
            return None, "kasfyi_no_results"

        row = rows[0] or {}
        if not isinstance(row, dict):
            return None, "kasfyi_bad_row"

        return row, ""

    def _kasfyi_metadata_row(self, ticker: str) -> Tuple[Dict[str, Any] | None, str]:
        """
        Method 2: fetch /v1/tokens/krc20/{ticker}/metadata from kas.fyi.

        This is intentionally decoupled from _kasfyi_market_row so that we can
        mix market-data and metadata in a controlled way. It does not change
        Analyzer behavior until quote_asset() starts calling it.

        Returns (metadata, reason). On success, metadata is a dict and reason
        is an empty string. On any failure, metadata is None and reason
        explains why (e.g. missing_ticker, http_404, parse_error).
        """
        ticker = (ticker or "").strip().upper()
        if not ticker:
            return None, "missing_ticker"

        api_key = self._resolve_kasfyi_api_key()
        if not api_key:
            return None, "missing_kasfyi_api_key"

        import json
        import urllib.error
        import urllib.request

        url = f"https://api.kas.fyi/v1/tokens/krc20/{ticker}/metadata"
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "x-api-key": api_key,
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw = resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            # We do not propagate bodies here; just return a structured reason.
            try:
                _ = e.read()  # exhaust the body for completeness
            except Exception:
                pass
            return None, f"kasfyi_metadata_http_{e.code}"
        except Exception:
            return None, "kasfyi_metadata_exception"

        try:
            js = json.loads(raw)
        except Exception:
            return None, "kasfyi_metadata_parse_error"

        result = js.get("result")
        if not isinstance(result, dict):
            return None, "kasfyi_metadata_no_result"

        return result, ""

    def _extract_price_usd_from_metadata(
        self, metadata: Dict[str, Any]
    ) -> Tuple[float | None, str]:
        """
        Given a metadata dict from _kasfyi_metadata_row, choose a single USD price.

        Selection rule (deterministic):
          - Prefer the market row with the highest 24h USD volume.
          - If multiple markets tie on volume, prefer the lexicographically
            smallest 'name' field.

        Returns (price_usd, reason). When no suitable price is found,
        price_usd is None and reason explains why.
        """
        markets = metadata.get("markets")
        if not isinstance(markets, list) or not markets:
            return None, "kasfyi_metadata_no_markets"

        best_price: float | None = None
        best_volume: float = -1.0
        best_name: str = ""

        for m in markets:
            if not isinstance(m, dict):
                continue

            td = m.get("tradingData") or {}
            price = td.get("price") or {}
            volume = td.get("volume") or {}

            # Price in USD for this market row
            try:
                raw_price = price.get("usd")
                price_usd = float(raw_price) if raw_price is not None else None
            except (TypeError, ValueError):
                price_usd = None
            if price_usd is None:
                continue

            # 24h volume in USD (0 if missing/bad)
            try:
                raw_vol = volume.get("usd")
                vol_usd = float(raw_vol) if raw_vol is not None else 0.0
            except (TypeError, ValueError):
                vol_usd = 0.0

            name = str(m.get("name") or "")

            if (
                vol_usd > best_volume
                or (
                    vol_usd == best_volume
                    and (best_name == "" or name < best_name)
                )
            ):
                best_volume = vol_usd
                best_price = price_usd
                best_name = name

        if best_price is None:
            return None, "kasfyi_metadata_no_price"

        return best_price, ""

    def describe_asset(self, asset: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
        """
        Turn a sell/buy asset descriptor into a normalized metadata dict for assetMeta.

        Returns (meta, reason). meta always has a stable set of keys:
          kind, ticker, symbol, name, ca, decimals,
          totalMinted, maxSupply, holderTotal, transferTotal, mintTotal,
          primaryMarket, explorerUrl, logoUrl, isVerified

        On failure or partial data, fields are left as None and reason explains why.
        """
        base: Dict[str, Any] = {
            "kind": None,
            "ticker": None,
            "symbol": None,
            "name": None,
            "ca": None,
            "decimals": None,
            "totalMinted": None,
            "maxSupply": None,
            "holderTotal": None,
            "transferTotal": None,
            "mintTotal": None,
            "primaryMarket": None,
            "explorerUrl": None,
            "logoUrl": None,
            "isVerified": None,
        }

        def _norm(meta: Any) -> Dict[str, Any]:
            if not isinstance(meta, dict):
                return base.copy()
            merged = base.copy()
            for k, v in meta.items():
                if k in merged:
                    merged[k] = v
            return merged

        if not isinstance(asset, dict):
            return _norm({}), "asset_not_describable"

        asset_type = (asset.get("type") or "").upper()
        sym = _safe_str(asset.get("symbol") or asset.get("ticker") or "").upper().strip()

        # KAS coin: static metadata
        if asset_type == "KAS" or sym == "KAS":
            meta = {
                "kind": "KAS",
                "ticker": "KAS",
                "symbol": "KAS",
                "name": "Kaspa",
                "ca": None,
                "decimals": 8,
            }
            return _norm(meta), ""

        # Mint-mode KRC-20 by ticker
        if asset_type in ("KRC", "KRC20") and sym:
            # Lazy init metadata cache
            cache = getattr(self, "_meta_cache", None)
            if not isinstance(cache, dict):
                cache = {}
                setattr(self, "_meta_cache", cache)

            key = f"KRC20:TICKER:{sym}"
            metadata = cache.get(key)
            reason = ""

            if not isinstance(metadata, dict):
                metadata, reason = self._kasfyi_metadata_row(sym)
                if isinstance(metadata, dict):
                    cache[key] = metadata

            if not isinstance(metadata, dict):
                # Still return basic identity even if metadata is missing.
                meta = {
                    "kind": "KRC20",
                    "ticker": sym,
                    "symbol": sym,
                }
                return _norm(meta), reason or "no_metadata"

            result = metadata  # _kasfyi_metadata_row already returns the "result" dict

            meta: Dict[str, Any] = {
                "kind": "KRC20",
                "ticker": str(result.get("ticker") or sym).upper(),
                "symbol": str(result.get("ticker") or sym).upper(),
                "name": result.get("name") or result.get("ticker") or sym,
            }

            # CA (if present)
            ca_val = result.get("ca") or result.get("contractAddress")
            if isinstance(ca_val, str):
                meta["ca"] = ca_val

            # Decimals (kas.fyi uses "decimal"; allow "dec"/"decimals" as fallback)
            dec_val = result.get("decimal")
            if dec_val is None:
                dec_val = result.get("dec")
            if dec_val is None:
                dec_val = result.get("decimals")
            try:
                if dec_val is not None:
                    meta["decimals"] = int(dec_val)
            except (TypeError, ValueError):
                meta["decimals"] = None

            # Supply / counts
            for field in ("totalMinted", "maxSupply"):
                v = result.get(field)
                if v is not None:
                    meta[field] = str(v)
            for field in ("holderTotal", "transferTotal", "mintTotal"):
                v = result.get(field)
                try:
                    meta[field] = int(v)
                except (TypeError, ValueError):
                    meta[field] = None

            # Primary market (first markets[] row, if any)
            markets = result.get("markets") or []
            if isinstance(markets, list) and markets:
                m = markets[0] or {}
                td = m.get("tradingData") or {}
                price = td.get("price") or {}
                volume = td.get("volume") or {}

                pm: Dict[str, Any] = {}
                pm["marketName"] = m.get("name")

                # USD price
                try:
                    raw_price = price.get("usd")
                    pm["priceUsd"] = float(raw_price) if raw_price is not None else None
                except (TypeError, ValueError):
                    pm["priceUsd"] = None

                # 24h USD volume
                try:
                    raw_vol = volume.get("usd")
                    pm["volume24hUsd"] = float(raw_vol) if raw_vol is not None else None
                except (TypeError, ValueError):
                    pm["volume24hUsd"] = None

                meta_meta = m.get("metadata") or {}
                pm["exchangeLabel"] = meta_meta.get("name")
                pm["exchangeUrl"] = meta_meta.get("url")
                pm["source"] = "kas.fyi"

                meta["primaryMarket"] = pm

            # Explorer/logo/verified are not provided by kas.fyi; leave as None.
            return _norm(meta), reason or ""

        # Unsupported types (EVM, CA-only, etc.)
        meta = {
            "kind": asset_type or None,
            "ticker": sym or None,
            "symbol": sym or None,
        }
        return _norm(meta), "asset_type_not_supported_for_metadata"

    def _quote_mint_token(self, ticker: str) -> Tuple[float | None, float | None, str]:
        """
        Quote a mint-mode KRC-20 token by ticker via kas.fyi.

        Returns (price_kas, price_usd, reason). If both prices are unavailable,
        price_kas and price_usd are None and reason explains why.
        """
        row, reason = self._kasfyi_market_row(ticker)
        if not row:
            return None, None, reason or "kasfyi_no_row"

        price = row.get("price") or {}
        price_usd = price.get("usd")
        price_kas = price.get("kas")

        pk: float | None
        pu: float | None

        try:
            pk = float(price_kas) if price_kas is not None else None
        except (TypeError, ValueError):
            pk = None
        try:
            pu = float(price_usd) if price_usd is not None else None
        except (TypeError, ValueError):
            pu = None

        if pk is None and pu is None:
            return None, None, "kasfyi_missing_price"

        return pk, pu, ""

    def _quote_mint_token_combined(self, ticker: str) -> Tuple[float | None, float | None, str]:
        """
        Quote a mint-mode KRC-20 token using both kas.fyi market-data (Method 1)
        and kas.fyi metadata (Method 2).

        - price_kas is taken from market-data (price.kas) when available.
        - price_usd prefers metadata (markets[*].tradingData.price.usd) and
          falls back to market-data price.usd if metadata is unavailable.

        If neither source yields a price in any currency, returns
        (None, None, reason) where reason explains why.
        """
        # Method 1: market-data (price in KAS and/or USD)
        try:
            pk_md, pu_md, reason_md = self._quote_mint_token(ticker)
        except Exception:
            pk_md, pu_md, reason_md = None, None, "kasfyi_market_exception"

        # Method 2: metadata (USD price derived from markets[])
        metadata = None
        reason_meta = ""
        try:
            metadata, reason_meta = self._kasfyi_metadata_row(ticker)
        except Exception:
            metadata, reason_meta = None, "kasfyi_metadata_exception"

        price_usd_meta: float | None = None
        reason_meta_price = ""
        if metadata is not None:
            price_usd_meta, reason_meta_price = self._extract_price_usd_from_metadata(metadata)

        price_kas = pk_md
        price_usd = price_usd_meta if price_usd_meta is not None else pu_md

        if price_kas is None and price_usd is None:
            # Choose the most informative reason we have.
            for r in (reason_meta_price, reason_meta, reason_md, "kasfyi_missing_price"):
                if r:
                    return None, None, r
            return None, None, "kasfyi_missing_price"

        # At least one side is priced; treat as success and leave reason empty so
        # _compute_price_refs() does not emit a note for this leg.
        return price_kas, price_usd, ""


    def quote_asset(self, asset: Dict[str, Any]) -> Tuple[float | None, float | None, str]:
        """
        Given an asset descriptor (sell/buy struct), return (price_kas, price_usd, reason).

        Current support:
          - KAS coin: returns (1.0, None, "kas_stub")
          - Mint-mode KRC-20 (by ticker, no CA): uses kas.fyi via krc20_collect
        All other asset types (Issue-mode CA tokens, ERC-20, etc.) return
        (None, None, "asset_not_priced") for now.
        """
        if not isinstance(asset, dict):
            return None, None, "asset_not_dict"

        asset_type = str(asset.get("type") or "").upper()
        sym = (str(asset.get("symbol") or asset.get("ticker") or "").strip()).upper()

        if not sym and asset_type != "KAS":
            return None, None, "missing_symbol"

        # KAS coin — use quote_kas; USD side to be integrated later.
        if asset_type == "KAS":
            pk, pu = self.quote_kas()
            return pk, pu, "kas_stub"

        # Mint-mode KRC-20 (ticker without CA)
        if asset_type in ("KRC", "KRC20") and _is_krc20_ticker(sym) and not _is_krc20_ca(sym):
            pk, pu, reason = self._quote_mint_token_combined(sym)
            if pk is None and pu is None:
                return None, None, reason or "mint_token_unpriced"
            return pk, pu, reason or "ok"

        # Unsupported / not yet priced (Issue-mode CA, ERC-20, etc.)
        return None, None, "asset_not_priced"


def get_price_provider() -> PriceProvider:
    """
    Return the PriceProvider to use for Analyzer priceRefs.

    In this module we always return the in-process provider, which is currently
    wired to kas.fyi for mint-mode KRC-20 tokens and leaves other asset types
    unpriced. Later modules may swap this for a configurable provider that also
    uses Kasplex for CA tokens.
    """
    return PriceProvider()


def _compute_price_refs(
    sell: Dict[str, Any] | None,
    buy: Dict[str, Any] | None,
    trade: Dict[str, str] | None,
    notes: List[str],
) -> Dict[str, Any]:
    """
    Compute priceRefs.{sell,buy,kas} for Analyzer using the configured PriceProvider.

    This helper is conservative:
      - If trade amounts are missing/invalid, returns a stub with only symbol/kind.
      - If pricing is unavailable or the upstream API fails, leaves price/value
        fields as None and records non-trivial reasons in notes.
      - It never raises; caller should treat missing prices as 'unpriced' legs.
    """
    sell = sell or {}
    buy = buy or {}

    price_refs: Dict[str, Any] = {
        "sell": {
            "symbol": sell.get("symbol"),
            "kind":  sell.get("type"),
            "price_kas": None,
            "value_kas": None,
            "value_usd": None,
        },
        "buy": {
            "symbol": buy.get("symbol"),
            "kind":  buy.get("type"),
            "price_kas": None,
            "value_kas": None,
            "value_usd": None,
        },
        "kas": {
            "symbol": "KAS",
            "kind": "KAS",
            "price_kas": None,
            "value_kas": None,
            "value_usd": None,
        },
    }

    if not trade:
        # Shape-only analyze; nothing to price.
        return price_refs

    sell_qty, buy_qty = _normalize_trade_quantities(trade)
    if sell_qty is None or buy_qty is None:
        # Trade exists but amounts failed to normalize; leave priceRefs empty.
        return price_refs

    provider = get_price_provider()

    # Best-effort baseline: attach a KAS→USD quote to the "kas" row so the UI
    # can derive a KASUSD rate from priceRefs.kas.price_usd.
    kas_row = price_refs.get("kas") or {
        "symbol": "KAS",
        "kind": "KAS",
        "price_kas": 1.0,
        "value_kas": None,
        "value_usd": None,
    }
    try:
        _kas_price_kas, kas_price_usd = provider.quote_kas()
    except Exception:
        kas_price_usd = None

    # Keep KAS at 1.0 in KAS terms and stash the USD quote (if any) under
    # price_usd so the front-end can treat it as the KASUSD rate.
    kas_row["price_kas"] = 1.0
    if isinstance(kas_price_usd, (int, float)):
        kas_row["price_usd"] = float(kas_price_usd)
    price_refs["kas"] = kas_row

    def _fill_leg(key: str, asset: Dict[str, Any], qty: Decimal) -> None:
        ref = price_refs.get(key)
        if ref is None:
            return
        if not isinstance(asset, dict):
            notes.append(f"price_ref_{key}:asset_not_dict")
            return

        try:
            price_kas, price_usd, reason = provider.quote_asset(asset)
        except Exception:
            notes.append(f"price_ref_{key}:provider_exception")
            return

        if price_kas is not None:
            ref["price_kas"] = price_kas
            try:
                vk = qty * Decimal(str(price_kas))
                ref["value_kas"] = float(vk)
            except Exception:
                ref["value_kas"] = None

        if price_usd is not None:
            try:
                vu = qty * Decimal(str(price_usd))
                ref["value_usd"] = float(vu)
            except Exception:
                ref["value_usd"] = None

        # Only surface non-trivial reasons; 'ok', 'kas_stub', and expected
        # 'asset_not_priced' / 'mint_token_unpriced' remain silent.
        if reason and reason not in ("ok", "kas_stub", "asset_not_priced", "mint_token_unpriced"):
            notes.append(f"price_ref_{key}:{reason}")

    _fill_leg("sell", sell, sell_qty)
    _fill_leg("buy", buy, buy_qty)

    # KAS baseline row remains present for symmetry, but it is treated like any
    # other asset: if no price feed is available, its fields stay as None. We do
    # not currently populate KAS value_kas/value_usd here; the UI can rely on
    # the per-leg value_usd fields directly.
    return price_refs


def _compute_asset_meta(
    provider: PriceProvider,
    sell: Dict[str, Any] | None,
    buy: Dict[str, Any] | None,
    notes: List[str],
) -> Dict[str, Any]:
    """
    Build assetMeta.sell / assetMeta.buy using PriceProvider.describe_asset().
    Always returns both keys; individual fields may be None when metadata is missing.
    """
    sell = sell or {}
    buy = buy or {}

    meta_sell, reason_sell = provider.describe_asset(sell)
    meta_buy, reason_buy = provider.describe_asset(buy)

    base: Dict[str, Any] = {
        "kind": None,
        "ticker": None,
        "symbol": None,
        "name": None,
        "ca": None,
        "decimals": None,
        "totalMinted": None,
        "maxSupply": None,
        "holderTotal": None,
        "transferTotal": None,
        "mintTotal": None,
        "primaryMarket": None,
        "explorerUrl": None,
        "logoUrl": None,
        "isVerified": None,
    }

    def _norm(meta: Any) -> Dict[str, Any]:
        if not isinstance(meta, dict):
            return base.copy()
        merged = base.copy()
        for k, v in meta.items():
            if k in merged:
                merged[k] = v
        return merged

    if reason_sell:
        notes.append(f"asset_meta_sell:{reason_sell}")
    if reason_buy:
        notes.append(f"asset_meta_buy:{reason_buy}")

    return {
        "sell": _norm(meta_sell),
        "buy": _norm(meta_buy),
    }

# -------- /analyze (read-only) --------
@bp.post("/analyze")
def api_offers_analyze():
    """
    Validate offer form and report basic blockers/notes.

    This endpoint is intentionally read-only. It may call server-side registries
    and price feeds (Kas.fyi, Kasplex, or similar), but it never signs or
    broadcasts transactions. It does not compute builder-accurate fees; that
    remains server-side analyzer work to add later.
    """
    body = _json()
    if not body:
        return _echo_err("invalid_json")

    sell = body.get("sell") or {}
    buy  = body.get("buy")  or {}
    amount = _safe_str(body.get("amount"))
    partial = body.get("partial") or {}
    ttl = body.get("ttl")

    blockers: List[str] = []
    notes: List[str] = []

    # Validate amount
    try:
        amt = float(amount.replace(",", "")) if isinstance(amount, str) else float(amount)
        if not (amt > 0):
            blockers.append("amount_must_be_positive")
    except Exception:
        blockers.append("invalid_amount")

    # Validate SELL (owned: KAS or KRC-20 ticker/CA)
    sell_type = (sell.get("type") or "").upper()
    sell_sym  = _safe_str(sell.get("symbol") or sell.get("ticker") or sell.get("ca") or "")
    if sell_type in ("KAS", "KRC", "KRC20"):
        if sell_type == "KAS":
            pass  # KAS is allowed
        else:
            if not (_is_krc20_ticker(sell_sym) or _is_krc20_ca(sell_sym)):
                blockers.append("sell_asset_invalid")
    elif sell_type in ("ETH", "ERC20"):
        # EVM sells are allowed at shape level; deep contract/chain checks will be added later.
        # For now we do not treat missing symbol/contract as a blocker.
        pass
    else:
        blockers.append("sell_type_invalid")

    # Validate BUY (ticker/CA or ERC-20 0x…)
    buy_sym = _safe_str(buy.get("symbol") or buy.get("ticker") or buy.get("ca") or buy.get("contract") or "")
    if _is_erc20_addr(buy_sym):
        # ERC-20 requires a chainId; we'll pin exact chains in the registry proxy later.
        chain_id = buy.get("chainId")
        if not isinstance(chain_id, int):
            blockers.append("buy_chain_missing")
    else:
        if not (_is_krc20_ticker(buy_sym) or _is_krc20_ca(buy_sym) or buy_sym.upper() == "KAS"):
            blockers.append("buy_asset_invalid")

    # Partial fills policy
    if bool(partial.get("enabled")):
        try:
            min_fill = float(_safe_str(partial.get("min") or "0").replace(",", ""))
            step     = float(_safe_str(partial.get("step") or "0").replace(",", ""))
            if not (min_fill > 0):
                blockers.append("partial_min_fill_required")
            if not (step > 0):
                blockers.append("partial_step_size_required")
        except Exception:
            blockers.append("partial_fields_invalid")
        else:
            # Compare min_fill against the Maker's requested Buy amount, not the Sell amount.
            buy_total = None
            buy_raw = body.get("buy_amount")
            try:
                if buy_raw is not None:
                    buy_total = float(_safe_str(buy_raw).replace(",", ""))
            except Exception:
                buy_total = None
            if buy_total is not None and buy_total > 0 and min_fill > buy_total:
                blockers.append("partial_min_exceeds_amount")

    # TTL sanity
    try:
        ttl_int = int(ttl)
        if not (30 <= ttl_int <= 24*60*60):
            blockers.append("ttl_out_of_range")
    except Exception:
        blockers.append("ttl_invalid")

    # Trade amounts (sell_amount / buy_amount + implied price)
    trade = _normalize_trade_amounts(body, blockers, notes)

    # Receive Endpoint (if present)
    recv_blockers, recv_notes = _validate_receive_endpoint(body)
    blockers.extend(recv_blockers)
    notes.extend(recv_notes)

    # Notes & placeholders (pricing via PriceProvider; no fee engine yet)
    fees = {"kas": None, "gas": None}

    ok = len(blockers) == 0

    # Solvency flags (still stubbed; real holdings checks will be added later).
    # priceRefs semantics:
    # - price_kas: per-unit price in KAS for 1 unit of the asset (when known)
    # - value_kas: trade leg value in KAS for this offer (amount * price_kas)
    # - value_usd: trade leg value in USD for this trade leg
    solvency: Dict[str, Any] = {
        "sell_ok": None,
        "fee_ok": None,
    }

    price_refs: Dict[str, Any] = _compute_price_refs(sell, buy, trade, notes)

    # Build asset metadata for both legs (KAS / KRC-20) using the same provider.
    try:
        provider = get_price_provider()
        asset_meta = _compute_asset_meta(provider, sell, buy, notes)
    except Exception:
        # Fail-closed: keep assetMeta minimal but never break Analyzer.
        asset_meta = {
            "sell": {
                "kind": None,
                "ticker": None,
                "symbol": None,
                "name": None,
                "ca": None,
                "decimals": None,
                "totalMinted": None,
                "maxSupply": None,
                "holderTotal": None,
                "transferTotal": None,
                "mintTotal": None,
                "primaryMarket": None,
                "explorerUrl": None,
                "logoUrl": None,
                "isVerified": None,
            },
            "buy": {
                "kind": None,
                "ticker": None,
                "symbol": None,
                "name": None,
                "ca": None,
                "decimals": None,
                "totalMinted": None,
                "maxSupply": None,
                "holderTotal": None,
                "transferTotal": None,
                "mintTotal": None,
                "primaryMarket": None,
                "explorerUrl": None,
                "logoUrl": None,
                "isVerified": None,
            },
        }

    resp: Dict[str, Any] = {
        "ok": ok,
        "fees": fees,
        "solvency": solvency,
        "blockers": blockers,
        "notes": notes,
        "priceRefs": price_refs,
        "assetMeta": asset_meta,
        "trade": {
            "sell": sell,
            "buy": buy,
            "amount": amount,
            "partial": partial,
            "ttl": ttl,
        },
        "receiveEndpoint": body.get("receiveEndpoint") or {},
        "echo": {
            "sell": sell,
            "buy": buy,
            "amount": amount,
            "partial": partial,
            "ttl": ttl,
        },
    }

    if trade is not None:
        resp["sell_amount"] = trade["sell_amount"]
        resp["buy_amount"] = trade["buy_amount"]
        resp["price"] = trade["price"]
        resp["trade"]["sell_amount"] = trade["sell_amount"]
        resp["trade"]["buy_amount"] = trade["buy_amount"]
        resp["trade"]["price"] = trade["price"]

    return jsonify(resp), 200

# -------- /bind (metadata-only) --------

@bp.post("/bind")
def api_offers_bind():
    """
    Allocate OFFER_ID (and seed FILL_ID) for a draft.
    Does not encumber. UI will call existing /api/wallet/encumber next.
    """
    body = _json()
    if not body:
        return _echo_err("invalid_json")

    offer_id = _mk_id("OFFER")
    fill_id  = _mk_id("FILL")

    # Optional trade snapshot (best-effort; bind remains metadata-only)
    trade = None
    try:
        tmp_blockers: List[str] = []
        tmp_notes: List[str] = []
        trade = _normalize_trade_amounts(body, tmp_blockers, tmp_notes)
    except Exception:
        trade = None

    # Best-effort correlation line to stderr (no secrets). One line per bind.
    try:
        wid = (body.get("maker") or {}).get("wid") or ""
        print(f"[offers.bind] offer_id={offer_id} fill_id={fill_id} wid={wid}", file=sys.stderr, flush=True)
    except Exception:
        pass

    # Best-effort: append/update this offer in the local offers feed.
    try:
        sell = body.get("sell") or {}
        buy = body.get("buy") or {}
        partial = body.get("partial") or {}
        ttl = body.get("ttl")
        receive_ep = body.get("receiveEndpoint") or {}
        maker = body.get("maker") or {}

        offer_entry: Dict[str, Any] = {
            "offerId": offer_id,
            "fillId": fill_id,
            "state": "open",
            "sell": sell if isinstance(sell, dict) else {},
            "buy": buy if isinstance(buy, dict) else {},
            "partial": partial if isinstance(partial, dict) else {},
            "ttl": ttl,
            "receiveEndpoint": receive_ep if isinstance(receive_ep, dict) else {},
            "maker": maker if isinstance(maker, dict) else {},
        }

        if trade is not None:
            offer_entry["sellAmount"] = trade.get("sell_amount")
            offer_entry["buyAmount"] = trade.get("buy_amount")
            offer_entry["price"] = trade.get("price")

        _append_offer_to_feed(offer_entry)
    except Exception:
        # Feed updates are best-effort and must not break bind.
        pass

    resp: Dict[str, Any] = {
        "ok": True,
        "offer_id": offer_id,
        "fill_id": fill_id,
    }
    if trade is not None:
        resp["sell_amount"] = trade["sell_amount"]
        resp["buy_amount"] = trade["buy_amount"]
        resp["price"] = trade["price"]

    return jsonify(resp), 200

def _parse_accept_request(body: Dict[str, Any]) -> Tuple[str, str, Dict[str, Any], List[str], List[str]]:
    """Parse and lightly validate a Taker accept request body.

    This helper is intentionally conservative and shape-only. Deeper checks
    (balances, Analyzer, ON staleness) will be layered on in later modules.
    """
    blockers: List[str] = []
    notes: List[str] = []

    offer_id = _safe_str((body.get("offerId") or body.get("offer_id") or "")).strip()
    fill_size_raw = _safe_str(body.get("fillSize") or "").strip()
    taker_wallet_raw = body.get("takerWallet") or body.get("taker_wallet") or {}

    if not offer_id:
        blockers.append("missing_offer_id")
    if not fill_size_raw:
        blockers.append("missing_fill_size")
        # We can still return a contract-shaped error even if fill size is missing.

    taker_wallet: Dict[str, Any] = {}
    if not isinstance(taker_wallet_raw, dict) or not taker_wallet_raw:
        blockers.append("missing_taker_wallet")
    else:
        wid = _safe_str(taker_wallet_raw.get("wid") or "").strip()
        address = _safe_str(taker_wallet_raw.get("address") or "").strip()
        taker_wallet = {"wid": wid, "address": address}
        if not address:
            blockers.append("taker_address_missing")
        elif not address.startswith("kaspa:"):
            blockers.append("taker_address_invalid")

    return offer_id, fill_size_raw, taker_wallet, blockers, notes


def _load_offers_feed() -> List[Dict[str, Any]]:
    """Load and normalize all offers from the ON feed file.

    The ON engine must periodically write ``edge-gateway/data/offers_local.json``
    with the following structure:

        {
          "offers": [
            {
              "offerId": "OFFER_0001",
              "fillId": "FILL_0001",        # optional
              "state": "open",              # "open" | "filled" | "cancelled" | ...

              "sellAmount": "1000.00000000",
              "buyAmount": "2.50000000",
              "price": "0.00250000",        # optional; if absent we may compute it

              "sell": {
                "symbol": "KAS",
                "type": "KAS",              # or "KRC20"
                "decimals": 8,
                "ca": null,                 # contract/address for KRC-20, if any
                "chain": "KRC20-L1"         # or another ON-defined chain label
              },

              "buy": {
                "symbol": "NACHO",
                "type": "KRC20",
                "decimals": 8,
                "ca": "...",
                "chain": "KRC20-L1"
              },

              "meta": {
                "...": "ON-specific metadata (maker wid, address, timestamps, notes)"
              }
            }
          ]
        }

    Keys such as ``fillId``, ``price`` and ``meta`` are optional, but if present
    they are passed through to the UI and accept logic.

    This function is the single adapter between the ON feed file and the
    Offer Board and /accept endpoints. On any error or malformed JSON, it
    returns an empty list (treated as "no offers") and does not consult any
    other files or feeds.
    """
    try:
        from pathlib import Path
        import json

        here = Path(__file__).resolve()
        edge_root = here.parents[2]
        offers_path = edge_root / "edge-gateway" / "data" / "offers_local.json"
        if not offers_path.exists():
            return []

        obj = json.loads(offers_path.read_text(encoding="utf-8"))
        raw_offers = obj.get("offers") or []
        normalized: List[Dict[str, Any]] = []

        for raw in raw_offers:
            if not isinstance(raw, dict):
                continue
            offer = dict(raw)

            # Normalize id fields.
            if "offerId" not in offer and "offer_id" in offer:
                offer["offerId"] = offer["offer_id"]
            if "fillId" not in offer and "fill_id" in offer:
                offer["fillId"] = offer["fill_id"]

            # Normalize amount fields.
            if "sellAmount" not in offer and "sell_amount" in offer:
                offer["sellAmount"] = offer["sell_amount"]
            if "buyAmount" not in offer and "buy_amount" in offer:
                offer["buyAmount"] = offer["buy_amount"]

            # Default state.
            if "state" not in offer:
                offer["state"] = "open"

            # Ensure sell/buy legs exist and have basic defaults.
            sell = offer.get("sell")
            if not isinstance(sell, dict):
                sell = {}
                offer["sell"] = sell
            buy = offer.get("buy")
            if not isinstance(buy, dict):
                buy = {}
                offer["buy"] = buy

            sell.setdefault("decimals", 8)
            buy.setdefault("decimals", 8)

            s_sym = _safe_str(sell.get("symbol") or "").upper()
            b_sym = _safe_str(buy.get("symbol") or "").upper()
            if not sell.get("type"):
                sell["type"] = "KAS" if s_sym == "KAS" else "KRC20"
            if not buy.get("type"):
                buy["type"] = "KAS" if b_sym == "KAS" else "KRC20"

            # Normalize or compute price where possible.
            price_raw = _safe_str(offer.get("price") or "")
            if price_raw:
                try:
                    p = Decimal(price_raw)
                    p_q = p.quantize(Decimal("0.00000001"))
                    offer["price"] = str(p_q.normalize())
                except Exception:
                    offer["price"] = price_raw
            else:
                s_amt = _safe_str(offer.get("sellAmount") or "")
                b_amt = _safe_str(offer.get("buyAmount") or "")
                try:
                    s_dec = Decimal(s_amt)
                    b_dec = Decimal(b_amt)
                    if s_dec > 0 and b_dec > 0:
                        p = (b_dec / s_dec).quantize(Decimal("0.00000001"))
                        offer["price"] = str(p.normalize())
                except Exception:
                    # Leave price absent if we cannot compute it safely.
                    pass

            normalized.append(offer)

        return normalized
    except Exception:
        # Fail-closed: an empty Offer Board is acceptable.
        return []


def _append_offer_to_feed(offer_entry: Dict[str, Any]) -> None:
    """Append or replace a single OfferSummary in the local offers feed.

    Phase-1: used only for Maker-created offers from this OMA instance.
    """
    try:
        from pathlib import Path
        import json

        if not isinstance(offer_entry, dict):
            return

        oid = _safe_str(offer_entry.get("offerId") or "").strip()
        if not oid:
            return

        here = Path(__file__).resolve()
        edge_root = here.parents[2]
        feed_path = edge_root / "edge-gateway" / "data" / "offers_local.json"
        tmp_path = feed_path.with_suffix(feed_path.suffix + ".tmp")

        # Load existing feed (best-effort).
        feed_obj: Dict[str, Any] = {"offers": []}
        if feed_path.exists():
            try:
                existing = json.loads(feed_path.read_text(encoding="utf-8"))
                if isinstance(existing, dict):
                    offers = existing.get("offers")
                    if isinstance(offers, list):
                        feed_obj["offers"] = offers
            except Exception:
                # Malformed feed; reset to empty.
                feed_obj = {"offers": []}

        existing_offers: List[Dict[str, Any]] = []
        for o in feed_obj["offers"]:
            if not isinstance(o, dict):
                continue
            existing_oid = _safe_str(o.get("offerId") or "").strip()
            if existing_oid and existing_oid == oid:
                continue
            existing_offers.append(o)
        existing_offers.append(offer_entry)
        feed_obj["offers"] = existing_offers

        feed_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path.write_text(json.dumps(feed_obj, indent=2, sort_keys=True), encoding="utf-8")
        tmp_path.replace(feed_path)
    except Exception:
        # Fail-closed: Offer Board feed is best-effort only.
        return


def _load_offer_summary(offer_id: str) -> Tuple[Dict[str, Any] | None, str | None]:
    """Lookup an OfferSummary from the local offers feed."""
    if not offer_id:
        return None, "offer_unavailable"

    offers = _load_offers_feed()
    if not offers:
        return None, "offer_unavailable"

    for offer in offers:
        oid = _safe_str(offer.get("offerId") or "").strip()
        if oid == offer_id:
            return offer, None

    return None, "offer_not_found"


def _validate_accept_fill(
    offer: Dict[str, Any],
    fill_size_raw: str,
) -> Tuple[str | None, str | None, List[str], List[str]]:
    """Validate the Taker's fill size against an OfferSummary.

    - fill_size_raw is expressed in SELL units.
    - Returns (fill_sell_str, fill_buy_str, blockers, notes).
    """
    blockers: List[str] = []
    notes: List[str] = []

    # Total amounts from the offer.
    sell_total_raw = _safe_str(offer.get("sellAmount") or offer.get("sell_amount") or "")
    buy_total_raw = _safe_str(offer.get("buyAmount") or offer.get("buy_amount") or "")
    if not sell_total_raw or not buy_total_raw:
        blockers.append("offer_missing_amounts")
        return None, None, blockers, notes

    try:
        sell_total = Decimal(sell_total_raw)
        buy_total = Decimal(buy_total_raw)
    except InvalidOperation:
        blockers.append("offer_amounts_invalid")
        return None, None, blockers, notes

    if sell_total <= 0 or buy_total <= 0:
        blockers.append("offer_amounts_non_positive")
        return None, None, blockers, notes

    # Requested fill size (in SELL units).
    fill_raw = _safe_str(fill_size_raw or "")
    try:
        fill_sell = Decimal(fill_raw)
    except InvalidOperation:
        blockers.append("fill_size_invalid")
        return None, None, blockers, notes

    if fill_sell <= 0:
        blockers.append("fill_size_non_positive")
        return None, None, blockers, notes
    if fill_sell > sell_total:
        blockers.append("fill_size_exceeds_available")
        return None, None, blockers, notes

    # Partial-fill constraints from the offer (optional).
    partial = offer.get("partial") or {}
    if bool(partial.get("enabled")):
        min_raw = _safe_str(partial.get("min") or "")
        step_raw = _safe_str(partial.get("step") or "")
        try:
            min_fill = Decimal(min_raw) if min_raw else None
        except InvalidOperation:
            min_fill = None
        try:
            step = Decimal(step_raw) if step_raw else None
        except InvalidOperation:
            step = None

        if min_fill is not None and min_fill > 0 and fill_sell < min_fill:
            blockers.append("fill_size_below_min")
        if step is not None and step > 0 and min_fill is not None and fill_sell >= min_fill:
            # (fill_sell - min_fill) must be a multiple of step within decimal precision.
            try:
                remainder = (fill_sell - min_fill) % step
                if remainder != 0:
                    blockers.append("fill_size_not_on_step")
            except InvalidOperation:
                blockers.append("fill_size_step_check_failed")
    else:
        # No partials: require full fill.
        if fill_sell != sell_total:
            blockers.append("partial_not_allowed")

    if blockers:
        return None, None, blockers, notes

    # Compute proportional BUY amount for this fill.
    try:
        price = buy_total / sell_total
        fill_buy = price * fill_sell
        # Quantize to 8 decimals for stability.
        fill_sell_q = fill_sell.quantize(Decimal("0.00000001"))
        fill_buy_q = fill_buy.quantize(Decimal("0.00000001"))
    except Exception:
        blockers.append("fill_trade_math_error")
        return None, None, blockers, notes

    fill_sell_str = str(fill_sell_q.normalize())
    fill_buy_str = str(fill_buy_q.normalize())
    notes.append(f"accept_fill: sell={fill_sell_str} buy={fill_buy_str}")
    return fill_sell_str, fill_buy_str, blockers, notes


@bp.get("/list")
def api_offers_list():
    """List offers from the local offers feed for the Offer Board UI.

    This endpoint is read-only and returns OfferSummary objects. It does
    not sign, broadcast, or modify any wallet or encumbrance state.
    """
    from flask import request

    state_filter = _safe_str((request.args.get("state") or "")).strip()
    offers = _load_offers_feed()

    if state_filter:
        offers = [o for o in offers if _safe_str(o.get("state") or "") == state_filter]

    resp: Dict[str, Any] = {
        "ok": True,
        "items": offers,
    }
    return jsonify(resp), 200


@bp.post("/accept")
def api_offers_accept():
    """Taker preflight for filling an existing offer.

    Phase-1B: this endpoint prepares PSKT and sendContext inputs for the
    canonical /api/wallet/send builder, but does not sign or broadcast.
    """
    body = _json()
    if not body:
        return _echo_err("invalid_json")

    offer_id, fill_size_raw, taker_wallet, blockers, notes = _parse_accept_request(body)
    if blockers:
        return _echo_err("invalid_request", blockers=blockers, notes=notes or None)

    offer_summary, offer_reason = _load_offer_summary(offer_id)
    if offer_summary is None:
        blk = [offer_reason or "offer_unavailable"]
        nts = notes + [f"Offer {offer_id} could not be loaded."]
        return _echo_err(offer_reason or "offer_unavailable", blockers=blk, notes=nts)

    fill_sell, fill_buy, fill_blockers, fill_notes = _validate_accept_fill(offer_summary, fill_size_raw)
    notes.extend(fill_notes)
    if fill_blockers:
        return _echo_err("invalid_size", blockers=fill_blockers, notes=notes or None)

    # Build a minimal Analyzer stub for now; real re-analysis will be added later.
    analyzer: Dict[str, Any] = {
        "blockers": [],
        "notes": notes,
        "assetMeta": offer_summary.get("assetMeta") or {},
    }

    # Construct PSKT request payload (data only, no signing).
    sell_leg = offer_summary.get("sell") or {}
    buy_leg = offer_summary.get("buy") or {}
    # Maker receive address from the offer's receiveEndpoint (if present).
    recv_ep = offer_summary.get("receiveEndpoint") or {}
    maker_receive_addr = ""
    if isinstance(recv_ep, dict):
        maker_receive_addr = _safe_str(recv_ep.get("address") or "")

    pskt_payload: Dict[str, Any] = {
        "offerId": offer_id,
        "fillSize": fill_size_raw,
        "fillSellAmount": fill_sell,
        "fillBuyAmount": fill_buy,
        "sell": sell_leg,
        "buy": buy_leg,
        "partial": offer_summary.get("partial") or {},
        "ttl": offer_summary.get("ttl"),
        "takerWallet": taker_wallet,
        # New: explicit Maker receive address for the PSKT engine.
        "makerReceiveAddress": maker_receive_addr,
    }

    pskt_request: Dict[str, Any] = {
        "kind": "KRC20_SWAP",
        "payload": pskt_payload,
    }

    # Taker sendContext: they send the BUY asset to receive the SELL asset.
    buy_type = (buy_leg.get("type") or "").upper()
    buy_symbol = _safe_str(buy_leg.get("symbol") or buy_leg.get("assetId") or buy_leg.get("ticker") or "")
    if buy_type == "KAS":
        asset_kind = "KAS"
        asset_id = "KAS"
    else:
        asset_kind = "KRC20"
        asset_id = buy_symbol

    send_context: Dict[str, Any] = {
        "wid": taker_wallet.get("wid") or "",
        "address": taker_wallet.get("address") or "",
        "assetKind": asset_kind,
        "assetId": asset_id,
        "amount": fill_buy,
    }

    resp: Dict[str, Any] = {
        "ok": True,
        "offer": offer_summary,
        "analyzer": analyzer,
        "psktRequest": pskt_request,
        "sendContext": send_context,
    }
    return jsonify(resp), 200


