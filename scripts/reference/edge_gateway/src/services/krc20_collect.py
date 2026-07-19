# edge_gateway/src/services/krc20_collect.py
from __future__ import annotations

import os, re, time
from typing import Dict, Any, List, Optional

try:
    import requests
except Exception:
    requests = None

# ---------- public endpoints ----------
# Kasplex (mainnet) — documented, paginated token list
# Docs: https://docs-kasplex.gitbook.io/krc20/tools-and-reference/kasplex-indexer-api/krc-20/get-token-list
KASPLEX_TOKENLIST = "https://api.kasplex.org/v1/krc20/tokenlist"

# kas.fyi Developer Platform — market data (needs API key)
# Docs: https://docs.kas.fyi/quickstart
KASFYI_MARKET_DATA = "https://api.kas.fyi/v1/tokens/krc20/market-data"

# kaspa.com token detail pages (for icons)
KASPACOM_TOKEN_PAGE = "https://kaspa.com/tokens/marketplace/token/{ticker}"

# ---------- common helpers ----------
def _need_requests():
    if requests is None:
        raise RuntimeError("requests library not installed (pip install requests)")

def _http_get_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = 15) -> Dict[str, Any]:
    _need_requests()
    r = requests.get(url, headers=headers or {}, timeout=timeout)
    r.raise_for_status()
    return r.json()

def _http_get_text(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = 10) -> str:
    _need_requests()
    base_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "close",
    }
    if headers:
        base_headers.update(headers)
    r = requests.get(url, headers=base_headers, timeout=timeout)
    r.raise_for_status()
    return r.text

def _num(x: Any) -> float:
    try:
        if x is None:
            return 0.0
        return float(x)
    except Exception:
        try:
            return float(str(x))
        except Exception:
            return 0.0

def _http_head_is_image(url: str, timeout: int = 8) -> bool:
    _need_requests()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        ),
        "Accept": "*/*",
        "Connection": "close",
    }
    try:
        r = requests.head(url, headers=headers, timeout=timeout, allow_redirects=True)
        if r.status_code >= 400:
            # Some CDNs disallow HEAD; fall back to a lightweight GET
            r = requests.get(url, headers=headers, timeout=timeout, stream=True, allow_redirects=True)
        if r.status_code >= 400:
            return False
        ct = (r.headers.get("Content-Type") or "").lower()
        return ("image/" in ct) or url.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"))
    except Exception:
        return False

# ---------- 1) Kasplex: full ticker universe (paginated) ----------
def list_all_tickers(limit: Optional[int] = None) -> List[str]:
    """
    Follow Kasplex tokenlist pagination via 'next' until None or 'limit' reached.
    Returns uppercase ticker strings.
    """
    ticks: List[str] = []
    url = KASPLEX_TOKENLIST
    next_cursor: Optional[str] = None
    while True:
        q = url if not next_cursor else f"{url}?next={next_cursor}"
        js = _http_get_json(q)
        for row in js.get("result") or []:
            t = str(row.get("tick") or row.get("name") or "").strip()
            if t:
                ticks.append(t.upper())
                if limit and len(ticks) >= limit:
                    return ticks
        next_cursor = js.get("next") or None
        if not next_cursor:
            break
        # be polite
        time.sleep(0.1)
    return ticks

# ---------- 2) kas.fyi: market data for a set of tickers ----------
def get_market_data_for(tickers: List[str], api_key: Optional[str]) -> List[Dict[str, Any]]:
    """
    Query kas.fyi for market data (price USD/KAS, 24h volume USD, market cap USD, rank).
    Splits into chunks of up to 500 tickers per call.
    """
    if not api_key:
        raise ValueError("Missing kas.fyi API key (set KAS_FYI_API_KEY env var)")
    if not tickers:
        return []
    headers = {"x-api-key": api_key}
    out: List[Dict[str, Any]] = []
    uniq = sorted(set(tickers))
    # chunk at 500 per call
    for i in range(0, len(uniq), 500):
        group = uniq[i:i+500]
        url = f"{KASFYI_MARKET_DATA}?tickers={','.join(group)}"
        js = _http_get_json(url, headers=headers)
        out.extend(js.get("results") or [])
        time.sleep(0.15)
    return out

def normalize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    price = row.get("price") or {}
    vol24 = row.get("volume24h") or {}
    mcap  = row.get("marketCap") or {}
    return {
        "ticker": (row.get("ticker") or "").upper(),
        "rank": _num(row.get("rank")) or None,
        "price": _num(price.get("usd") if isinstance(price, dict) else None) or _num(price.get("kas") if isinstance(price, dict) else None),
        "volume_24h": _num(vol24.get("usd") if isinstance(vol24, dict) else None),
        "market_cap": _num(mcap.get("usd") if isinstance(mcap, dict) else None),
        # We'll add icon_url later
    }

def rank_and_filter(rows: List[Dict[str, Any]], top_n: int = 10) -> List[Dict[str, Any]]:
    norm = [normalize_row(r) for r in rows]
    # filter empties
    norm = [r for r in norm if (r["market_cap"] > 0 and r["price"] > 0)]
    # rank by market cap desc, then 24h volume desc
    norm.sort(key=lambda r: (r["market_cap"], r["volume_24h"]), reverse=True)
    return norm[:max(0, top_n)]

# ---------- 3) kaspa.com icons ----------
KRC20_ICON_CDN = "https://krc20-assets.kas.fyi/icons"

def icon_url_for(ticker: str) -> str:
    """
    Return a working icon URL from the kas.fyi CDN if one exists.
    Tries common extensions and both UPPER/lower case tickers.
    If no file is found, returns "" (let the UI show a placeholder).
    """
    t = (ticker or "").strip()
    if not t:
        return ""
    candidates: List[str] = []
    for name in (t.upper(), t.lower()):
        for ext in (".png", ".svg", ".webp", ".jpg", ".jpeg", ".gif"):
            candidates.append(f"{KRC20_ICON_CDN}/{name}{ext}")
    for url in candidates:
        if _http_head_is_image(url):
            return url
    return ""

# ---------- 4) High-level: Top-N collector ----------
def collect_top_tokens(n: int = 10, limit_universe: Optional[int] = None, api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    1) List all tickers from Kasplex (paginated, optionally capped).
    2) Fetch market data for that universe from kas.fyi.
    3) Rank & filter to Top-N by market cap (USD).
    4) Attach deterministic icon_url from kas.fyi CDN.
    """
    api_key = api_key or os.getenv("KAS_FYI_API_KEY") or ""
    ticks = list_all_tickers(limit=limit_universe if limit_universe not in (0, None) else None)
    market_rows = get_market_data_for(ticks, api_key=api_key)
    top = rank_and_filter(market_rows, top_n=n)

    enriched: List[Dict[str, Any]] = []
    for r in top:
        r2 = dict(r)
        r2["icon_url"] = icon_url_for(r["ticker"])  # always set; UI can fall back if 404
        enriched.append(r2)

    return {
        "ok": True,
        "base": "USD",
        "count": len(enriched),
        "updated_at": int(time.time() * 1000),
        "tokens": enriched,
    }

# ---------- 5) Local search helper ----------
def search_tickers_local(query: str, limit: int = 8) -> List[str]:
    q = (query or "").strip().upper()
    if len(q) < 2:
        return []
    ticks = list_all_tickers(limit=None)
    hits = [t for t in ticks if q in t]
    hits.sort()
    return hits[:limit]
