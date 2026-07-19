#!/usr/bin/env python3
from __future__ import annotations
from flask import Blueprint, request, jsonify

from wallet.kas_wallet import (
    status as wallet_status,
    create_wallet,
    confirm_backup,
    import_wallet,
    get_fee_payer_address,
    try_derive_address_with_node,
)
from services.krc20_collect import icon_url_for

# ---------------------------------------------------------------------------
# site.yaml + config.yaml helpers (no external deps)
# ---------------------------------------------------------------------------
import pathlib, re, os, json, time, urllib.request, urllib.parse

_HERE = pathlib.Path(__file__).resolve()
# edge_gateway/src/dashboard/routes_wallet.py -> parents[2] == edge_gateway/
_EDGE_ROOT = _HERE.parents[2]
_SITE_YAML = _EDGE_ROOT / "site.yaml"
_CFG_YAML  = _EDGE_ROOT / "config.yaml"

def _active_wallet_address() -> str | None:
    """Return the ACTIVE vault address from edge-gateway/data/wallet/wallet.json."""
    try:
        import os, json
        from pathlib import Path
        p = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / "wallet.json")
        if not p.exists():
            return None
        obj = json.loads(p.read_text(encoding="utf-8"))
        addr = (obj.get("address") or "").strip()
        return addr if addr.startswith("kaspa:") else None
    except Exception:
        return None


def _read_explorer_cfg() -> dict:
    """
    Minimal reader for EXPLORER block in config.yaml.
    Keys: PROVIDER, API_KEY, HOLDINGS_URL, KAS_BALANCE_URL
    """
    out = {"PROVIDER": "", "API_KEY": "", "HOLDINGS_URL": "", "KAS_BALANCE_URL": ""}
    try:
        with open(_CFG_YAML, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        i, n = 0, len(lines)
        while i < n:
            if re.match(r"^\s*EXPLORER\s*:\s*$", lines[i]):
                i += 1
                while i < n and re.match(r"^\s{2,}\S", lines[i]):  # inside EXPLORER:
                    line = lines[i].split("#", 1)[0]
                    m = re.match(r"^\s+(\w+)\s*:\s*(.+?)\s*$", line)
                    if m:
                        k, v = m.group(1).upper(), m.group(2).strip()
                        v = v.strip('"').strip("'")
                        if k in out:
                            out[k] = v
                    i += 1
                break
            i += 1
    except Exception:
        pass
    return out

def _read_network_id() -> str:
    """
    Returns the active Kaspa network id based on config.yaml.

    Falls back to 'testnet-10' if NETWORK is missing or unreadable.
    """
    try:
        with open(_CFG_YAML, "r", encoding="utf-8") as fh:
            for line in fh:
                line_stripped = line.strip()
                if line_stripped.startswith("NETWORK:"):
                    return line_stripped.split(":", 1)[1].strip()
    except Exception:
        pass
    return "testnet-10"

def _http_json(url: str, headers: dict | None = None, timeout: float = 8.0) -> tuple[dict | list | None, dict]:
    """
    Robust JSON fetcher:
      1) Try system curl (uses OS trust store; avoids Python TLS quirks on macOS).
      2) Fallback to urllib if curl fails.
    Returns (obj_or_list_or_None, response_headers_lowercased_dict_or_empty).
    """
    # --- Try curl first ---
    try:
        import subprocess as _sp, json as _json
        cmd = ["curl", "-sS", "--max-time", str(int(timeout))]
        for k, v in (headers or {"Accept": "application/json"}).items():
            cmd += ["-H", f"{k}: {v}"]
        cmd += [url]
        _p = _sp.run(cmd, text=True, capture_output=True, check=False)
        if _p.returncode == 0 and _p.stdout.strip():
            try:
                return _json.loads(_p.stdout), {}
            except Exception:
                pass
    except Exception:
        pass  # fall through to urllib

    # --- Fallback: urllib ---
    req = urllib.request.Request(url, headers=headers or {"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        hdr = {k.lower(): v for k, v in (r.headers or {}).items()}
    try:
        return json.loads(raw.decode("utf-8", "ignore")), hdr
    except Exception:
        return None, hdr

def _cache_paths(addr: str, kind: str) -> tuple[str, str]:
    """
    Cross-platform cache location.
    Linux: honors XDG_RUNTIME_DIR if writable; else tmp.
    macOS/Windows: use tempfile.gettempdir().
    """
    import tempfile, re, os
    base = os.environ.get("XDG_RUNTIME_DIR")
    if not base or not os.path.isdir(base) or not os.access(base, os.W_OK):
        base = tempfile.gettempdir()
    cache_dir = os.path.join(base, "krc20_wallet")
    os.makedirs(cache_dir, exist_ok=True)
    safe = re.sub(r"[^a-zA-Z0-9]+", "_", addr)[-40:]
    p = os.path.join(cache_dir, f"{kind}_{safe}.cache.json")
    return cache_dir, p

def _normalize_kasplex_tokenlist(data: dict | list) -> dict:
    """
    Kasplex /v1/krc20/address/{address}/tokenlist ->
      {"message":"Success","result":[
        {"tick":"KWHR","balance":"275000000","dec":"8"},
        {"ca":"<deploy_txid>","balance":"1000000","dec":"6","name":"MWHK"}
      ]}
    Convert to:
      {
        "tokens": {"KWHR": 275.0, ...},        # Mint-Mode (by ticker)
        "issue":  [                            # Issue-Mode (by contract address / deploy txid)
          {"ca":"<txid>","name":"MWHK","dec":6,"amount":1.0},
          ...
        ]
      }
    """
    tokens: dict[str, float] = {}
    issue: list[dict] = []

    def _to_amount(bal, dec) -> float | None:
        try:
            iv = int(str(bal), 10)
            de = int(str(dec), 10)
            return (iv / (10 ** de)) if de >= 0 else float(iv)
        except Exception:
            return None

    res = data.get("result") if isinstance(data, dict) else None
    if isinstance(res, list):
        for it in res:
            if not isinstance(it, dict):
                continue

            # Mint-Mode entries (by ticker)
            sym = it.get("tick")
            if sym:
                bal = it.get("balance")
                dec = it.get("dec") or it.get("decimal") or 0
                amt = _to_amount(bal, dec) if bal is not None else None
                if amt is not None:
                    tokens[str(sym).upper()] = amt
                continue

            # Issue-Mode entries (by CA)
            ca = it.get("ca")
            if ca:
                bal = it.get("balance")
                dec = it.get("dec") or it.get("decimal") or 0
                amt = _to_amount(bal, dec) if bal is not None else None
                if amt is not None:
                    issue.append({
                        "ca": str(ca),
                        "name": it.get("name") or None,  # may be None; enriched upstream
                        "dec": int(str(dec), 10) if str(dec).isdigit() else 0,
                        "amount": amt
                    })

    return {"tokens": tokens, "issue": issue}

wallet_bp = Blueprint("wallet", __name__, url_prefix="/api/wallet")

@wallet_bp.get("/status")
def api_wallet_status():
    return jsonify(wallet_status()), 200

@wallet_bp.post("/create")
def api_wallet_create():
    js = request.get_json(silent=True) or {}
    num_words = int(js.get("num_words") or 12)
    passphrase = (js.get("passphrase") or "").strip()
    res = create_wallet(num_words, passphrase)
    return jsonify(res), 200

@wallet_bp.post("/confirm-backup")
def api_wallet_confirm():
    """
    Confirm backup (vault-only when wallet_id is provided).
    Vault behavior (no canonical/global side effects):
      - Require passphrase to decrypt mnemonic.
      - Derive addr#0 with BIP-39 passphrase and persist into this vault.
      - Ensure per-vault password file: /home/pi/.kwh_wallets/<WID>.pw
      - Ensure per-vault signer key:   <vault dir>/.kwh_priv.hex (0600)
      - Stamp wallet.json -> state:"ready", has_backup:true, address:"kaspa:..."
    If wallet_id is absent, fall back to canonical confirm_backup() (legacy).
    """
    js = request.get_json(silent=True) or {}
    passphrase = (js.get("passphrase") or js.get("password") or "").strip()
    wallet_id = (js.get("wallet_id") or "").strip()

    if wallet_id:
        # Vault-aware confirmation
        try:
            # Local imports to avoid widening global deps
            from wallet.create_wallet_to_vault import _vault_wallet_json, _scrypt_key, _aesgcm_decrypt
            import json, base64, time, subprocess, os, re
            from pathlib import Path

            vpath = _vault_wallet_json(wallet_id)
            if not vpath or not vpath.exists():
                return jsonify({"ok": False, "error": "VAULT_NOT_FOUND", "wallet_id": wallet_id}), 404

            st = json.loads(vpath.read_text(encoding="utf-8")) if vpath.exists() else {}

            # Idempotent: if already ready with an address, return current state
            if st.get("state") == "ready" and st.get("has_backup") is True and st.get("address"):
                return jsonify({
                    "ok": True, "wallet_id": wallet_id,
                    "state": "ready", "has_backup": True,
                    "address": st.get("address"),
                }), 200

            if st.get("state") != "pending_backup":
                return jsonify({
                    "ok": False, "error": "VAULT_NOT_PENDING",
                    "wallet_id": wallet_id, "state": st.get("state")
                }), 400

            if not passphrase:
                return jsonify({"ok": False, "error": "MISSING_PASSPHRASE_FOR_VAULT_READY"}), 400

            # Decrypt mnemonic from vault json
            salt  = base64.b64decode(st.get("salt",""))
            key   = _scrypt_key(passphrase, salt)
            nonce = base64.b64decode(st.get("nonce",""))
            enc   = base64.b64decode(st.get("enc",""))
            mnemonic = _aesgcm_decrypt(key, nonce, enc).decode("utf-8")

            # Node helper: REPO_ROOT/scripts/derive_kas_addr.mjs
            script = (Path(__file__).resolve().parent.parent.parent.parent / "scripts" / "derive_kas_addr.mjs")
            if not script.exists():
                return jsonify({"ok": False, "error": "MISSING_NODE_DERIVER", "script": str(script)}), 500

            # Derive addr#0 + privkey using BIP-39 passphrase
            cp = subprocess.run(
                ["node", str(script),
                 f"--mnemonic={mnemonic}",
                 f"--bip39pass={passphrase}",
                 "--path=m/44'/111111'/0'/0/0",
                 "--network=mainnet"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20, check=False
            )
            if cp.returncode != 0:
                return jsonify({"ok": False, "error": "VAULT_ADDR_DERIVE_FAILED", "stderr": (cp.stderr or "").strip()}), 500

            try:
                import json as _json
                out = _json.loads((cp.stdout or "").strip() or "{}")
            except Exception:
                return jsonify({"ok": False, "error": "VAULT_ADDR_PARSE_FAILED", "stdout": (cp.stdout or "")}), 500

            addr = (out.get("address") or "").strip()
            priv = (out.get("privkey_hex") or "").strip().lower()
            if not addr.startswith("kaspa:"):
                return jsonify({"ok": False, "error": "VAULT_ADDR_INVALID", "stdout": out}), 500
            if not re.fullmatch(r"[0-9a-f]{64,}", priv):
                return jsonify({"ok": False, "error": "VAULT_KEY_HEX_INVALID"}), 500

            # Ensure per-vault password file
            pw_dir  = Path("/home/pi/.kwh_wallets"); pw_dir.mkdir(parents=True, exist_ok=True)
            pw_path = pw_dir / f"{wallet_id}.pw"
            if not pw_path.exists():
                tmp_pw = pw_path.with_suffix(".tmp")
                tmp_pw.write_text(passphrase, encoding="utf-8")
                try: os.chmod(tmp_pw.as_posix(), 0o600)
                except Exception: pass
                tmp_pw.replace(pw_path)
                try: os.chmod(pw_path.as_posix(), 0o600)
                except Exception: pass

            # Ensure per-vault signer key (.kwh_priv.hex) with atomic write
            key_path = vpath.parent / ".kwh_priv.hex"
            if not key_path.exists():
                tmp_key = key_path.with_suffix(".tmp")
                tmp_key.write_text(priv + "\n", encoding="utf-8")
                try: os.chmod(tmp_key.as_posix(), 0o600)
                except Exception: pass
                tmp_key.replace(key_path)
                try: os.chmod(key_path.as_posix(), 0o600)
                except Exception: pass

            # Stamp vault state to ready + persist address
            st["has_backup"] = True
            st["state"] = "ready"
            st["address"] = addr
            st["updated_at"] = time.time()

            # Atomic save back to this vault
            tmp = vpath.with_suffix(".tmp")
            tmp.write_text(json.dumps(st, indent=2), encoding="utf-8")
            tmp.replace(vpath)

            return jsonify({
                "ok": True, "wallet_id": wallet_id,
                "state": "ready", "has_backup": True,
                "address": addr
            }), 200

        except Exception as e:
            return jsonify({"ok": False, "error": "VAULT_CONFIRM_FAILED", "detail": str(e), "wallet_id": wallet_id}), 500

    # ---- Legacy canonical confirm path (unchanged) --------------------------------
    res = confirm_backup()  # raises if not in pending_backup
    try:
        if res.get("ok") and not res.get("address") and passphrase:
            d = try_derive_address_with_node(passphrase)
            if d.get("ok") and d.get("address"):
                res["address"] = d["address"]
    except Exception:
        pass
    return jsonify(res), 200

@wallet_bp.post("/import")
def api_wallet_import():
    js = request.get_json(silent=True) or {}
    mnemonic = (js.get("mnemonic") or "").strip()
    passphrase = (js.get("passphrase") or "").strip()
    return jsonify(import_wallet(mnemonic, passphrase)), 200

@wallet_bp.get("/receive-address")
def api_wallet_receive():
    # Returns internal address if mode=internal & wallet ready; else falls back
    addr = get_fee_payer_address()
    return jsonify({"ok": True, "address": addr}), 200

@wallet_bp.post("/derive-address")
def api_wallet_derive_address():
    """
    Optional: after C1b script is installed, derive kaspa: address via Node WASM script.
    Body: {"passphrase":"..."}  (used only to decrypt mnemonic locally)
    """
    js = request.get_json(silent=True) or {}
    passphrase = (js.get("passphrase") or "").strip()
    if not passphrase:
        return jsonify({"ok": False, "error": "passphrase_required"}), 400
    res = try_derive_address_with_node(passphrase)
    code = 200 if res.get("ok") else 500
    return jsonify(res), code

@wallet_bp.post("/set-address")
def api_wallet_set_address():
    """
    Manual bridge: accept a kaspa: address (derived by the user from the same seed in Kaspium/KasKeeper).
    """
    js = request.get_json(silent=True) or {}
    addr = (js.get("address") or "").strip()
    from wallet.kas_wallet import set_fee_payer_address
    res = set_fee_payer_address(addr)
    code = 200 if res.get("ok") else 400
    return jsonify(res), code

# ---------------------------------------------------------------------------
# New: holdings endpoint (KAS via kas.fyi RPC; tokens via Kasplex)
# ---------------------------------------------------------------------------

@wallet_bp.get("/holdings")
def api_wallet_holdings():
    """
    Normalized response for UI:
    {
        "address": "kaspa:...",
        "kas": <float|null>,          # KAS balance in KAS (sompi/1e8)
        "tokens": {"KWHR": 275, ...}, # token -> amount (decimals applied)
        "source": "<provider|url>",
        "cached_ms": <int>,
        "ok": true
    }
    """

    # Prefer the ACTIVE wallet address (SoT), else fall back to site.yaml owner.kwh_address
    addr = (request.args.get("address") or get_fee_payer_address() or _active_wallet_address() or "").strip()
    if not addr:
        return jsonify({"ok": False, "reason": "no_address"}), 400

    cfg = _read_explorer_cfg()
    provider = (cfg.get("PROVIDER") or "").strip()
    api_key  = (cfg.get("API_KEY") or "").strip()
    hold_url = (cfg.get("HOLDINGS_URL") or "").strip()
    kas_url  = (cfg.get("KAS_BALANCE_URL") or "").strip()
    # Safe defaults ensure holdings paths run even if config omits URLs.
    if not hold_url:
        hold_url = "https://api.kasplex.org/v1/krc20/address/{address}/tokenlist"
    if not kas_url:
        kas_url  = "https://api.kaspa.org/addresses/{address}/balance"

    out_tokens: dict[str, float] = {}
    out_issue: list[dict] = []
    out_kas: float | None = None
    now = time.time()
    cached_age_ms = 0

    # --- KAS via kas.fyi (RPC getBalanceByAddress) ---
    if kas_url:
        try:
            _, cache_p_kas = _cache_paths(addr, "kas_balance")
            # serve cache if <15s
            cached = None
            try:
                if os.path.exists(cache_p_kas):
                    with open(cache_p_kas, "r", encoding="utf-8") as fh:
                        cached = json.load(fh)
                    cached_age_ms = int(1000 * (now - cached.get("_ts", 0)))
                    if cached.get("address") == addr and cached_age_ms < 15000:
                        out_kas = cached.get("kas")
                    else:
                        cached = None
            except Exception:
                cached = None

            if out_kas is None:
                url = kas_url.format(address=urllib.parse.quote(addr, safe=""))
                headers = {"Accept": "application/json"}
                if "kas.fyi" in url and api_key:
                    headers["x-api-key"] = api_key
                data, _hdr = _http_json(url, headers=headers, timeout=8.0)
                if isinstance(data, dict) and "balance" in data:
                    try:
                        sompi = int(str(data["balance"]), 10)  # sompi
                        out_kas = sompi / 1e8                # KAS
                    except Exception:
                        out_kas = None
                # write cache
                try:
                    tmp = cache_p_kas + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as fh:
                        json.dump({"_ts": now, "address": addr, "kas": out_kas}, fh, separators=(",", ":"))
                    os.replace(tmp, cache_p_kas)
                except Exception:
                    pass
        except Exception:
            out_kas = None

        # --- Tokens via Kasplex tokenlist (Mint-Mode by ticker + Issue-Mode by CA) ---
        if hold_url:
            try:
                _, cache_p_tok = _cache_paths(addr, "wallet_holdings")
                # serve cache if <15s
                cached = None
                try:
                    if os.path.exists(cache_p_tok):
                        with open(cache_p_tok, "r", encoding="utf-8") as fh:
                            cached = json.load(fh)
                        cached_age_ms = int(1000 * (now - (cached.get("_ts", 0))))
                        if cached.get("address") == addr and cached_age_ms < 15000:
                            out_tokens = cached.get("tokens") or {}
                            out_issue  = cached.get("issue") or []
                        else:
                            cached = None
                except Exception:
                    cached = None

                # If nothing cached (or cache miss), fetch fresh tokenlist
                if not out_tokens and not out_issue:
                    url = hold_url.format(address=urllib.parse.quote(addr, safe=""))
                    headers = {"Accept": "application/json"}  # Kasplex: no API key needed
                    data, _hdr = _http_json(url, headers=headers, timeout=8.0)
                    if data is not None:
                        ret = _normalize_kasplex_tokenlist(data)
                        out_tokens = ret.get("tokens", {}) or {}
                        out_issue  = ret.get("issue", []) or []

                # Enrich Issue-Mode entries with name via Kasplex Token Info by CA (best-effort)
                if out_issue:
                    import re

                    def _kasplex_base(u: str) -> str:
                        try:
                            m = re.match(r"^(https?://[^/]+)/v1/krc20/", u or "")
                            return m.group(1) if m else "https://api.kasplex.org"
                        except Exception:
                            return "https://api.kasplex.org"

                    api_base = _kasplex_base(hold_url)

                    def _fetch_token_info_result_obj(ca_str: str) -> dict | None:
                        """
                        Try the *singular* path first:
                        GET {api_base}/v1/krc20/token/{CA}
                        -> {"message":"successful","result":[{...}]}
                        Fallback to the plural path if needed:
                        GET {api_base}/v1/krc20/tokens/{CA}
                        Returns the first dict inside 'result' or None.
                        """
                        paths = [
                            f"{api_base}/v1/krc20/token/{urllib.parse.quote(ca_str, safe='')}",
                            f"{api_base}/v1/krc20/tokens/{urllib.parse.quote(ca_str, safe='')}",
                        ]
                        for p in paths:
                            try:
                                info, _h = _http_json(p, headers={"Accept": "application/json"}, timeout=6.0)
                                if isinstance(info, dict):
                                    res = info.get("result")
                                    if isinstance(res, list) and res:
                                        first = res[0]
                                        if isinstance(first, dict):
                                            return first
                                    if isinstance(res, dict):
                                        return res
                            except Exception:
                                pass
                        return None

                    for it in out_issue:
                        if not isinstance(it, dict):
                            continue
                        if it.get("name"):  # already has a name (from provider or cache)
                            continue
                        ca = it.get("ca")
                        if not ca:
                            continue
                        first = _fetch_token_info_result_obj(str(ca))
                        if not isinstance(first, dict):
                            continue
                        # Exact fields per your observed shape
                        nm = first.get("name")
                        de = first.get("dec") or first.get("decimal")
                        if nm:
                            it["name"] = str(nm)
                        if (de is not None) and str(de).isdigit():
                            it["dec"] = int(str(de), 10)

                # write cache with both tokens and issue (possibly enriched)
                try:
                    tmp = cache_p_tok + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as fh:
                        json.dump({"_ts": now, "address": addr, "tokens": out_tokens, "issue": out_issue},
                                fh, separators=(",", ":"))
                    os.replace(tmp, cache_p_tok)
                except Exception:
                    pass

            except Exception:
                out_tokens = out_tokens or {}
                out_issue  = out_issue  or []

    # Icons: KAS local + per-token via kas.fyi resolver (same logic as /api/tokens/top)
    icons: dict[str, str] = {}
    try:
        icons["KAS"] = "/static/icon/kas.png"
    except Exception:
        pass
    try:
        for _t in (out_tokens or {}).keys():
            try:
                url = icon_url_for(str(_t))
                if url:
                    icons[str(_t)] = url
            except Exception:
                continue
    except Exception:
        pass

    out = {
        "ok": True,
        "address": addr,
        "kas": out_kas,
        "tokens": out_tokens,   # Mint-Mode (tickers)
        "issue": out_issue,     # Issue-Mode (CA + name)
        "icons": icons,
        "source": hold_url or kas_url or None,
        "cached_ms": cached_age_ms
    }
    return jsonify(out), 200

# ---------------------------------------------------------------------------
# Fee preview + Max-sendable endpoints (skeleton, server-owned; caching feerate)
# NOTE: This is a minimal, non-executing implementation to establish contracts.
#       It fetches and caches the live feerate (sompi/gram) from kaspa.org and
#       validates inputs, but it DOES NOT build a dry-run transaction yet.
#       A later change will replace the "UNIMPLEMENTED" reason with real mass/fee.
#       (Contract per “OMA Wallet Fee Previews & Max” handoff.)  # ref
# ---------------------------------------------------------------------------

def _get_kas_feerate_cached(ttl_s: int = 10) -> tuple[int | None, dict]:
    """
    Returns (feerate_sompi_per_gram | None, response_headers_dict).
    Caches the 'priorityBucket.feerate' from https://api.kaspa.org/info/fee-estimate
    for ttl_s seconds using the existing _cache_paths() helper.
    """
    import time, json, os
    # single global cache key
    _, cache_p = _cache_paths("global", "fee_quote")
    now = int(time.time() * 1000)
    # serve warm cache
    try:
        if os.path.exists(cache_p):
            obj = json.loads(open(cache_p, "r", encoding="utf-8").read())
            age_ms = now - int(obj.get("_ts", 0))
            if 0 <= age_ms <= (ttl_s * 1000):
                fr = obj.get("feerate")
                if isinstance(fr, int) and fr >= 0:
                    return fr, {}
    except Exception:
        pass
    # fetch live (pinned SoT)
    url = os.environ.get("FEE_ESTIMATE_URL") or "https://api.kaspa.org/info/fee-estimate"
    data, hdr = _http_json(url, headers={"Accept": "application/json"}, timeout=6.0)
    feerate = None
    try:
        # expected shape: {"priorityBucket":{"feerate": <int>, ...}, ...}
        feerate = int(((data or {}).get("priorityBucket") or {}).get("feerate"))
        if feerate < 0:
            feerate = None
    except Exception:
        feerate = None
    # write cache
    try:
        tmp = cache_p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"_ts": now, "feerate": feerate}, fh, separators=(",", ":"))
        os.replace(tmp, cache_p)
    except Exception:
        pass
    return feerate, hdr

def _get_kas_balance_sompi(addr: str) -> int | None:
    """
    Read KAS balance (sompi) for an address using EXPLORER.KAS_BALANCE_URL or kaspa.org.
    """
    expl = _read_explorer_cfg()
    kas_url = (expl.get("KAS_BALANCE_URL") or "").strip() or "https://api.kaspa.org/addresses/{address}/balance"
    headers = {"Accept": "application/json"}
    api_key = (expl.get("API_KEY") or "").strip()
    if "kas.fyi" in kas_url and api_key:
        headers["x-api-key"] = api_key
    import urllib.parse
    url = kas_url.format(address=urllib.parse.quote(addr, safe=""))
    data, _ = _http_json(url, headers=headers, timeout=8.0)
    try:
        if isinstance(data, dict) and "balance" in data:
            return int(str(data["balance"]), 10)
    except Exception:
        return None
    return None

@wallet_bp.get("/estimate")
def api_wallet_estimate():
    """
    KAS:
      GET /api/wallet/estimate?to=<kaspa:...>&amountSompi=<int>
      -> { ok, feeSompi, totalDebitSompi, utxoCount? }

    TOKEN (Issue/Mint):
      GET /api/wallet/estimate?to=<kaspa:...>&token=<ticker|CA>&amountUnits=<human>
      -> { ok, feeSompi, mass }
    """
    try:
        to = (request.args.get("to") or "").strip()
        token = (request.args.get("token") or request.args.get("tickOrCa") or "").strip()
        amount_sompi_s = (request.args.get("amountSompi") or "").strip()

        # Validate inputs
        if not to.startswith("kaspa:"):
            return jsonify(ok=False, reason="invalid_recipient"), 200
        if token:
            ok2, j2, _tail = _bun_preview_token(
                to_addr=to,
                token_ca_or_tick=token,
                human_units=(request.args.get("amountUnits") or "").strip(),
                mode="estimate",
            )
            if ok2:
                mass_v = j2.get("mass")
                td_v = j2.get("totalDebitSompi")
                return jsonify(
                    ok=True,
                    feeSompi=int(j2.get("feeSompi") or 0),
                    **({"totalDebitSompi": int(td_v)} if isinstance(td_v, (int, str)) and str(td_v).isdigit() else {}),
                    **({"mass": int(mass_v)} if isinstance(mass_v, (int, str)) and str(mass_v).isdigit() else {})
                ), 200
            return jsonify(ok=False, reason=j2.get("error") or "token_estimate_unavailable"), 200
        if not amount_sompi_s.isdigit():
            return jsonify(ok=False, reason="invalid_amountSompi"), 200

        amount_sompi = int(amount_sompi_s)
        if amount_sompi <= 0:
            return jsonify(ok=False, reason="invalid_amountSompi"), 200

        # Convert sompi -> human KAS string for CLI (8dp, trimmed)
        human = f"{amount_sompi/1e8:.8f}".rstrip("0").rstrip(".") or "0"

        # Builder-accurate preview via CLI (no broadcast)
        from pathlib import Path
        import subprocess, json

        apps = (Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix()
        bun = "bun"

        # Read canonical private key (same path as /send stage)
        try:
            priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(encoding="utf-8").strip()
            if not priv_hex:
                return jsonify(ok=False, reason="private_key_missing_or_empty"), 500
        except Exception:
            return jsonify(ok=False, reason="private_key_unreadable"), 500

        cmd = [
            bun, "run", "src/sendKaspa.ts",
            "--privKey",     priv_hex,
            "--destination", to,
            "--amount",      human,
            "--network",     "mainnet",
            "--priorityFee", "0.03",
            "--mode",        "estimate",
            "--logLevel",    "INFO"
        ]
        p = subprocess.run(cmd, cwd=apps, text=True, capture_output=True, timeout=25)

        # Parse stdout JSON only; stderr has logs
        try:
            j = json.loads((p.stdout or "").strip() or "{}")
        except Exception:
            j = {}

        if p.returncode != 0 or not isinstance(j, dict) or not j.get("ok"):
            return jsonify(ok=False, reason=j.get("error") or "unavailable"), 200

        summary = j.get("summary") or {}
        fee_s   = summary.get("fees") or "0"
        utxos   = summary.get("utxos")

        # ---- Solvency check (server-owned; holdings-agnostic preview) ----
        total_debit = amount_sompi + int(fee_s)
        solvency_ok = None
        bal_sompi   = None
        try:
            addr = _active_wallet_address() or ""
            if addr.startswith("kaspa:"):
                cfg     = _read_explorer_cfg()
                kas_url = (cfg.get("KAS_BALANCE_URL") or "https://api.kaspa.org/addresses/{address}/balance")
                url     = kas_url.format(address=urllib.parse.quote(addr, safe=""))
                headers = {"Accept": "application/json"}
                api_key = (cfg.get("API_KEY") or "").strip()
                if "kas.fyi" in url and api_key:
                    headers["x-api-key"] = api_key
                data, _hdr = _http_json(url, headers=headers, timeout=8.0)
                if isinstance(data, dict) and "balance" in data:
                    try:
                        bal_sompi = int(str(data["balance"]), 10)
                    except Exception:
                        bal_sompi = None
                if isinstance(bal_sompi, int):
                    solvency_ok = (total_debit <= bal_sompi)
        except Exception:
            # On telemetry failure, fall through and return the fee preview.
            pass

        return jsonify(
            ok=True,
            feeSompi=int(fee_s),
            totalDebitSompi=total_debit,
            **({"solvencyOk": solvency_ok} if isinstance(solvency_ok, bool) else {}),
            **({"balanceSompi": bal_sompi} if isinstance(bal_sompi, int) else {}),
            **({"utxoCount": utxos} if isinstance(utxos, int) else {})
        ), 200

    except Exception as e:
        return jsonify(ok=False, reason=f"estimate_exception:{e.__class__.__name__}"), 200

def _bun_preview_token(to_addr: str, token_ca_or_tick: str, human_units: str | None, mode: str) -> tuple[bool, dict, str]:
    """
    Token/CA preview with correct CLI routing + robust JSON extraction:
      - Mint-Mode (ticker)  -> transfer.ts  ... --token <TICKER>
      - Issue-Mode (CA hex) -> transfer_issue.ts ... --ca <64hex>
    MAX returns sendableUnits; ESTIMATE returns feeSompi+mass.
    """
    from pathlib import Path
    import re, subprocess, json

    apps = (Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix()
    bun = "bun"

    try:
        priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(encoding="utf-8").strip()
        if not priv_hex:
            return False, {}, "private_key_missing_or_empty"
    except Exception:
        return False, {}, "private_key_unreadable"

    raw = (token_ca_or_tick or "").strip()
    # Detect CA formats: "CA:<64hex>" or bare "<64hex>"
    m_pref = re.match(r"^CA:([0-9a-fA-F]{64})$", raw)
    m_hex  = re.match(r"^[0-9a-fA-F]{64}$", raw)
    is_ca  = bool(m_pref or m_hex)
    ca_hex = (m_pref.group(1) if m_pref else (raw if m_hex else None))

    # Choose script + asset flag
    if is_ca:
        script = "transfer_issue.ts"
        asset_args = ["--ca", ca_hex]
    else:
        script = "transfer.ts"
        asset_args = ["--token", raw]

    # Build command
    cmd = [
        bun, "run", script,
        "--privKey",     priv_hex,
        "--dest",        to_addr,
        "--network",     "mainnet",
        "--priorityFee", "0.03",
        "--timeout",     "20000",     # align with your proven terminal run
        "--logLevel",    "INFO",
        "--json",
    ]
    if mode == "estimate":
        cmd.append("--dry-run")
        cmd.extend(asset_args + ["--amount", (human_units or "0")])
    elif mode == "max":
        # Plan-B: authoritative sweep preview via CLI
        cmd.extend(asset_args + ["--mode","sweep","--preview"])
    else:
        return False, {}, "invalid_mode"

    # Run bun directly; tolerate mixed stdout (logs + JSON)
    try:
        p = subprocess.run(cmd, cwd=apps, text=True, capture_output=True, timeout=20, check=False)
    except Exception as e:
        return False, {}, f"subprocess_error:{e}"

    out = ((p.stdout or "") + ("\n" if p.stdout and p.stderr else "") + (p.stderr or "")).strip()

    # Extract the final JSON object from mixed stdout (line-wise scan from the end)
    j: dict = {}
    for line in reversed(out.splitlines()):
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                j = json.loads(s)
                break
            except Exception:
                continue

    # Success criteria per mode
    if mode == "max":
        ok = (p.returncode == 0) and isinstance(j, dict) and ("sendableUnits" in j)
    else:
        ok = (p.returncode == 0) and isinstance(j, dict) and ("feeSompi" in j)
        if ok and "mass" not in j:
            j["mass"] = 0

    return ok, j, out[-2000:]

@wallet_bp.get("/max-sendable")
def api_wallet_max_sendable():
    """
    TOKEN/CA (reuse holdings SoT — same source used by index.html):
      GET /api/wallet/max-sendable?to=<kaspa:...>&token=<ticker|CA|CA:<64hex>>
      -> { ok: true, sendableUnits }
    """
    to = (request.args.get("to") or "").strip()
    token = (request.args.get("token") or request.args.get("tickOrCa") or "").strip()
    if not to.startswith("kaspa:"):
        return jsonify(ok=False, reason="invalid_recipient"), 200

    try:
        if token:
            # Use the same holdings source-of-truth as the Assets table (no re-derivation)
            resp = api_wallet_holdings()
            resp_obj = resp[0] if isinstance(resp, tuple) else resp
            jh = resp_obj.get_json(silent=True) or {}

            tokens_map = jh.get("tokens") or {}
            issue_list = jh.get("issue") or []

            raw = token.strip()
            sendable = None

            # Accept CA in either form: "CA:<64hex>" or bare "<64hex>"
            ca_hex = None
            m1 = re.match(r"^CA:([0-9a-fA-F]{64})$", raw)
            m2 = re.match(r"^[0-9a-fA-F]{64}$", raw)
            if m1:
                ca_hex = m1.group(1)
            elif m2:
                ca_hex = raw

            if ca_hex:
                # Issue-Mode (CA): find matching entry in holdings.issue[]
                ca_lc = ca_hex.lower()
                for it in (issue_list if isinstance(issue_list, list) else []):
                    if not isinstance(it, dict):
                        continue
                    ca_val = str((it.get("ca") or it.get("contract") or "")).lower()
                    if ca_val == ca_lc:
                        v = it.get("amount")
                        if v is None: v = it.get("balance")
                        if v is None: v = it.get("units")
                        if v is not None:
                            sendable = str(v)
                        break
            else:
                # Mint-Mode (ticker): read from holdings.tokens map (case-tolerant)
                hit = tokens_map.get(raw) or tokens_map.get(raw.upper()) or tokens_map.get(raw.lower())
                if isinstance(hit, (int, float, str)):
                    sendable = str(hit)
                elif isinstance(hit, dict):
                    v = hit.get("balance")
                    if v is None: v = hit.get("amount")
                    if v is None: v = hit.get("units")
                    if v is not None:
                        sendable = str(v)

            if sendable is not None:
                return jsonify(ok=True, sendableUnits=str(sendable)), 200

            return jsonify(ok=False, reason="token_max_unavailable"), 200

        # KAS MAX path is deprecated: UI now sets Amount = holdings and shows sender fee = 0 (ReceiverPays).
        return jsonify(ok=False, reason="deprecated_for_kas"), 200

    except Exception:
        return jsonify(ok=False, reason="max_sendable_error"), 200

# --- BEGIN: /api/wallet/send (Stage-1: conversion echo; NO send execution) ---
@wallet_bp.post("/send")
def api_wallet_send():
    """
    Accepts Wallet UI payload (human amount):
      { "token": "<ticker|'KAS'>", "to": "kaspa:...", "amount": "<human string>" }

    Behavior:
      - KAS: executes a single-step ReceiverPays send via CLI (no preview/sweep).
      - Tokens/CA: resolves decimals and handles MAX/ESTIMATE via existing helpers;
        conversion/dispatch remains unchanged from prior behavior.
    Safety:
      - No top-level imports; everything is inside the function.
      - No module-level state; no side effects on import.
      - Uses pure-Python scanning (no external YAML deps).
    """

    try:
        from flask import request, jsonify
        from decimal import Decimal, InvalidOperation, ROUND_DOWN
        from pathlib import Path
        import re, json

        # 1) Parse & basic validation
        js = request.get_json(silent=True) or {}

        # Phase-1 PSKT swap mode:
        # Payload shape:
        #   {
        #     "mode": "krc20_pskt_swap",
        #     "psktRequest": { ... },
        #     "sendContext": { ... }
        #   }
        mode = str(js.get("mode") or "").strip()
        if mode == "krc20_pskt_swap":
            pskt_request = js.get("psktRequest") or {}
            send_context = js.get("sendContext") or {}

            if not isinstance(pskt_request, dict) or not isinstance(send_context, dict):
                return jsonify(ok=False, error="invalid_pskt_payload"), 400

            payload = pskt_request.get("payload") or {}
            offer_id = str(payload.get("offerId") or "")
            fill_id = str(payload.get("fillId") or "")

            # Cache payload wrapper to a temporary JSON file
            addr_for_cache = (send_context.get("address") or "").strip() or "pskt"
            cache_dir, payload_path = _cache_paths(addr_for_cache, "psktSwap")

            env_payload = {
                # For Phase-1 PSKT swaps we pin to mainnet explicitly.
                # Other wallet send flows still use _read_network_id().
                "networkId": "mainnet",
                "feeSource": "SenderPays",
                # Enable DEBUG so psktSwapEngine.ts emits logDebug traces
                # (source address, amount, network) for solvency debugging.
                "logLevel": "DEBUG",
            }

            payload_wrapper = {
                "psktRequest": pskt_request,
                "sendContext": send_context,
                "env": env_payload,
            }

            Path(payload_path).write_text(json.dumps(payload_wrapper), encoding="utf-8")

            # Read Taker private key (same location as KAS send)
            try:
                priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(
                    encoding="utf-8"
                ).strip()
                if not priv_hex:
                    return jsonify(ok=False, error="private_key_missing_or_empty"), 500
            except Exception:
                return jsonify(ok=False, error="private_key_unreadable"), 500

            # Invoke psktSwap.ts via bun
            import subprocess

            apps = (Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix()
            bun = "bun"
            cmd = [bun, "run", "src/psktSwap.ts",
                "--payload-file", payload_path,
                "--privKey", priv_hex,
                "--network", env_payload["networkId"],
                "--feeSource", env_payload["feeSource"],
                "--logLevel", env_payload["logLevel"]
            ]
            if offer_id:
                cmd.extend(["--offerId", offer_id])
            if fill_id:
                cmd.extend(["--fillId", fill_id])

            # DEBUG: surface PSKT CLI invocation in server logs
            try:
                import sys as _sys
                print(
                    "[PSKT-debug] invoking psktSwap.ts",
                    "addr=", send_context.get("address"),
                    "amount=", send_context.get("amount"),
                    "assetKind=", send_context.get("assetKind"),
                    "networkId=", env_payload.get("networkId"),
                    file=_sys.stderr,
                )
            except Exception:
                # Logging must never break the send path
                pass

            proc = subprocess.run(
                cmd,
                cwd=apps,
                text=True,
                capture_output=True,
            )
            stdout = proc.stdout or ""
            blob = stdout + ("\n" if stdout and proc.stderr else "") + (proc.stderr or "")

            # DEBUG: echo psktSwap.ts stdout/stderr to Flask logs when in DEBUG logLevel
            if env_payload.get("logLevel") == "DEBUG" and blob:
                try:
                    import sys as _sys
                    print(
                        "[PSKT-debug] psktSwap stdout/stderr:\n" + blob[-1000:],
                        file=_sys.stderr,
                    )
                except Exception:
                    # Logging must not change behavior
                    pass

            if proc.returncode != 0:
                return jsonify(ok=False, error=(blob[-2000:] or "pskt_swap_failed")), 500

            try:
                result = json.loads(stdout.strip() or "{}")
            except Exception:
                result = {}

            if not result or result.get("ok") is not True:
                err_msg = (result.get("error") if isinstance(result, dict) else None) or (
                    blob[-2000:] or "pskt_swap_failed"
                )
                return jsonify(ok=False, error=err_msg), 500

            # On success, append a PsktFillNotice into the local inbox.
            try:
                from datetime import datetime, timezone, timedelta

                payload_inner = pskt_request.get("payload") or {}
                offer_id_inner = str(payload_inner.get("offerId") or "")
                fill_id_inner = str(payload_inner.get("fillId") or "")
                maker_recv = str(payload_inner.get("makerReceiveAddress") or "").strip()

                taker_wallet = payload_inner.get("takerWallet") or {}
                taker_wid = str(taker_wallet.get("wid") or "").strip()
                taker_addr = str(taker_wallet.get("address") or "").strip() or str(
                    send_context.get("address") or ""
                ).strip()

                fill_obj = {
                    "sellAmount": str(payload_inner.get("fillSellAmount") or ""),
                    "buyAmount": str(payload_inner.get("fillBuyAmount") or ""),
                    "size": str(payload_inner.get("fillSize") or ""),
                    "ttl": payload_inner.get("ttl"),
                }

                now = datetime.now(timezone.utc)
                notice = {
                    "type": "pskt_fill_notice",
                    "version": "1",
                    "offerId": offer_id_inner,
                    "fillId": fill_id_inner,
                    "maker": {
                        "wid": None,
                        "receiveAddress": maker_recv,
                    },
                    "taker": {
                        "wid": taker_wid,
                        "address": taker_addr,
                    },
                    "fill": fill_obj,
                    "psktRequest": pskt_request,
                    "sendContext": send_context,
                    "makerLeg": {
                        "status": "pending",
                    },
                    "createdAt": now.isoformat().replace("+00:00", "Z"),
                    "expiresAt": None,
                }

                ttl_val = payload_inner.get("ttl")
                if isinstance(ttl_val, int) and ttl_val > 0:
                    expires_at = now + timedelta(seconds=ttl_val)
                    notice["expiresAt"] = expires_at.isoformat().replace("+00:00", "Z")

                _append_pskt_notice(notice)
            except Exception:
                # Inbox failures must not change PSKT send behavior.
                pass

            # Note: for token/CA legs, txid may be None until transfer.ts is extended
            return jsonify(ok=True, txid=result.get("txid")), 200

        # Legacy wallet send payload (non-PSKT)
        token_raw = (js.get("token") or "").strip()
        token     = token_raw.upper()  # normalized ticker form; keep token_raw for CA detection
        dest  = (js.get("to") or "").strip()
        human = (js.get("amount") or "").strip()

        if not token:
            return jsonify(ok=False, error="missing_field:token"), 400
        if not dest or not dest.startswith("kaspa:"):
            return jsonify(ok=False, error="invalid_to_prefix"), 400
        if not human:
            return jsonify(ok=False, error="missing_field:amount"), 400

        # Encumbrance pre-gate (fail-closed). Require matching offer/fill and GO=true when locked.
        offer_id = str(js.get("offerId") or js.get("offer_id") or "").strip()
        fill_id  = str(js.get("fillId")  or js.get("fill_id")  or "").strip()
        try:
            enc = _read_enc()
        except Exception:
            enc = None
        if enc and enc.get("state") == "encumbered":
            if not offer_id or not fill_id:
                return jsonify(ok=False, reason="wallet_encumbered", offerId=enc.get("offer_id"), fillId=enc.get("fill_id")), 423
            if str(offer_id) != str(enc.get("offer_id")) or str(fill_id) != str(enc.get("fill_id")):
                return jsonify(ok=False, reason="wallet_encumbered", offerId=enc.get("offer_id"), fillId=enc.get("fill_id")), 423
            if not enc.get("go", False):
                return jsonify(ok=False, reason="await_go", offerId=enc.get("offer_id"), fillId=enc.get("fill_id")), 423

        # 2) KAS supported via sendKaspa.ts (human amounts or drain-to-zero)
        if token == "KAS":
            import subprocess, re
            try:
                from pathlib import Path
                # Active WID symlink -> actual vault -> .kwh_priv.hex
                priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(encoding="utf-8").strip()
                if not priv_hex:
                    return jsonify(ok=False, error="private_key_missing_or_empty"), 500
            except Exception:
                return jsonify(ok=False, error="private_key_unreadable"), 500

            apps = (Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix()
            bun = "bun"

            # Decide fee source per request: MAX → ReceiverPays (default), non-MAX → SenderPays
            from decimal import Decimal, ROUND_DOWN
            import urllib.parse
            is_max = False
            try:
                # Convert requested human amount to sompi
                amount_sompi = int((Decimal(human).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)) * Decimal(100_000_000))
                # Read active wallet balance (sompi) via explorer
                addr = _active_wallet_address() or ""
                if addr.startswith("kaspa:"):
                    cfg     = _read_explorer_cfg()
                    kas_url = (cfg.get("KAS_BALANCE_URL") or "https://api.kaspa.org/addresses/{address}/balance")
                    url     = kas_url.format(address=urllib.parse.quote(addr, safe=""))
                    headers = {"Accept": "application/json"}
                    api_key = (cfg.get("API_KEY") or "").strip()
                    if "kas.fyi" in url and api_key:
                        headers["x-api-key"] = api_key
                    data, _hdr = _http_json(url, headers=headers, timeout=8.0)
                    if isinstance(data, dict) and "balance" in data:
                        bal_sompi = int(str(data["balance"]), 10)
                        is_max = (amount_sompi == bal_sompi)
            except Exception:
                # On telemetry failure, leave default (ReceiverPays) behavior
                pass

            # ReceiverPays single-step send (no preview/handshake/sweep)
            cmd = [bun, "run", "src/sendKaspa.ts",
                   "--privKey",     priv_hex,
                   "--destination", dest,
                   "--amount",      human,
                   "--network",     "mainnet",
                   "--priorityFee", "0.03",
                   "--timeout",     "8000",
                   "--logLevel",    "INFO",
                   "--mode",        "send"]

            if not is_max:
                cmd.extend(["--feeSource", "SenderPays"])

            proc = subprocess.run(cmd, cwd=(Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix(), text=True, capture_output=True)
            blob = (proc.stdout or "") + ("\n" if proc.stdout and proc.stderr else "") + (proc.stderr or "")
            if proc.returncode != 0:
                return jsonify(ok=False, error=(blob[-2000:] or "kas_send_failed")), 500

            m = re.search(r"\b([0-9a-f]{64})\b", blob, flags=re.IGNORECASE)
            txid = m.group(1) if m else None
            return jsonify(ok=True, txid=txid), 200

        # 3) Optional config path (OMA/KRC20: do not require config.yaml)
        cfg_path = _CFG_YAML if _CFG_YAML.exists() else None  # may be None; fallbacks use Kasplex

        # 4) Get decimals via Kasplex lookup (no config.yaml scan)
        #    Strategy:
        #      (A) Try token info:   {api_base}/v1/krc20/tokens/{TICK}
        #      (B) Fallback by addr: {api_base}/v1/krc20/address/{ADDR}/tokenlist  → find TICK.dec
        #    Accept shapes: {"dec":8,...}, {"result":[{"dec":"8"}]}, bare "8", or "dec=8".
        import subprocess, json, re

        def _kasplex_base() -> str:
            expl = _read_explorer_cfg()
            base = expl.get("HOLDINGS_URL") or ""
            m = re.search(r"^(https?://[^/]+)/v1/krc20/", base)
            return m.group(1) if m else "https://api.kasplex.org"

        def _curl(url: str, timeout: int = 8) -> tuple[int, str, str]:
            try:
                p = subprocess.run(
                    ["curl", "-sS", "--max-time", str(timeout), url],
                    text=True, capture_output=True, check=False
                )
                return p.returncode, (p.stdout or ""), (p.stderr or "")
            except Exception as e:
                return 998, "", f"{e}"

        def _parse_dec(raw: str) -> int | None:
            raw = (raw or "").strip()
            if not raw:
                return None
            # Try JSON
            try:
                j = json.loads(raw)
                if isinstance(j, dict):
                    if isinstance(j.get("dec"), (int, str)) and str(j["dec"]).isdigit():
                        return int(j["dec"])
                    if isinstance(j.get("result"), list) and j["result"]:
                        cand = j["result"][0]
                        if isinstance(cand, dict) and str(cand.get("dec", "")).isdigit():
                            return int(cand["dec"])
                # Some providers return a bare number
                if isinstance(j, (int, float, str)) and str(j).isdigit():
                    return int(j)
            except Exception:
                pass
            # Plain text: "dec=8" or "dec: 8"
            m = re.search(r"\bdec\s*[:=]\s*(\d{1,2})\b", raw, re.IGNORECASE)
            if m:
                return int(m.group(1))
            # Plain integer body
            if re.fullmatch(r"\s*\d{1,2}\s*", raw):
                return int(raw.strip())
            return None

        api_base = _kasplex_base()
        # Support both ticker (Mint-Mode) and CA (Issue-Mode) — accept "CA:<64hex>" or bare "<64hex>"
        decimals = None
        import re
        m_pref = re.match(r"^CA:([0-9a-fA-F]{64})$", token_raw)
        m_hex  = re.match(r"^[0-9a-fA-F]{64}$", token_raw)
        is_ca  = bool(m_pref or m_hex)
        if is_ca:
            import json, urllib.parse, subprocess
            ca = m_pref.group(1) if m_pref else token_raw
            ca = token.split(":", 1)[1].strip()
            if not re.fullmatch(r"[0-9a-fA-F]{64}", ca):
                return jsonify(ok=False, error="invalid_ca_format"), 400

            # (A) Try singular token info first, then plural
            rc, out, err = _curl(f"{api_base}/v1/krc20/token/{urllib.parse.quote(ca, safe='')}", timeout=8)
            if rc == 0:
                try:
                    j = json.loads(out)
                    if isinstance(j, dict):
                        res = j.get("result")
                        if isinstance(res, list) and res:
                            first = res[0] if isinstance(res[0], dict) else None
                            if isinstance(first, dict):
                                de = first.get("dec") or first.get("decimal")
                                if de is not None and str(de).isdigit():
                                    decimals = int(de)
                        elif isinstance(res, dict):
                            de = res.get("dec") or res.get("decimal")
                            if de is not None and str(de).isdigit():
                                decimals = int(de)
                except Exception:
                    pass

            if decimals is None:
                rc2, out2, err2 = _curl(f"{api_base}/v1/krc20/tokens/{urllib.parse.quote(ca, safe='')}", timeout=8)
                if rc2 == 0:
                    try:
                        j2 = json.loads(out2)
                        if isinstance(j2, dict):
                            res2 = j2.get("result")
                            if isinstance(res2, list) and res2:
                                first2 = res2[0] if isinstance(res2[0], dict) else None
                                if isinstance(first2, dict):
                                    de = first2.get("dec") or first2.get("decimal")
                                    if de is not None and str(de).isdigit():
                                        decimals = int(de)
                    except Exception:
                        pass

            # (B) Fallback via our address tokenlist to match by CA
            if decimals is None:
                try:
                    addr = get_fee_payer_address() or ""
                except Exception:
                    addr = ""
                if not addr:
                    addr = (_active_wallet_address() or "")
                if addr:
                    rc3, out3, err3 = _curl(f"{api_base}/v1/krc20/address/{addr}/tokenlist", timeout=8)
                    if rc3 == 0:
                        try:
                            j3 = json.loads(out3)
                            if isinstance(j3, dict) and isinstance(j3.get("result"), list):
                                for it in j3["result"]:
                                    if not isinstance(it, dict):
                                        continue
                                    if str(it.get("ca", "")).lower() == ca.lower():
                                        de = it.get("dec") or it.get("decimal")
                                        if de is not None and str(de).isdigit():
                                            decimals = int(de)
                                            break
                        except Exception:
                            pass

            if decimals is None:
                return jsonify(ok=False, error="unknown_ca_or_missing_decimals"), 400

            # Human -> RAW using decimals
            try:
                q = Decimal(str(human))
            except InvalidOperation:
                return jsonify(ok=False, error="invalid_amount_format"), 400
            if q <= 0:
                return jsonify(ok=False, error="amount_must_be_positive"), 400
            frac_digits = -q.as_tuple().exponent if q.as_tuple().exponent < 0 else 0
            if frac_digits > decimals:
                return jsonify(ok=False, error="amount_precision_exceeds_decimals"), 400
            scale = Decimal(10) ** int(decimals)
            raw_dec = (q * scale).to_integral_value(rounding=ROUND_DOWN)
            if raw_dec <= 0:
                return jsonify(ok=False, error="amount_too_small_for_decimals"), 400
            raw_str = str(raw_dec)

            # Execute Issue-Mode transfer (transfer_issue.ts)
            try:
                from pathlib import Path
                priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(encoding="utf-8").strip()
                if not priv_hex:
                    return jsonify(ok=False, error="private_key_missing_or_empty"), 500
            except Exception:
                return jsonify(ok=False, error="private_key_unreadable"), 500

            cmd = ["bun", "run", "transfer_issue.ts",
                   "--privKey",  priv_hex,
                   "--ca",       ca,
                   "--dest",     dest,
                   "--amount",   raw_str,
                   "--network",  "mainnet",
                   "--priorityFee", "0.03",
                   "--timeout",     "20000",
                   "--logLevel",    "INFO"]
            proc = subprocess.run(cmd, cwd=(Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix(),
                      text=True, capture_output=True)
            blob = (proc.stdout or "") + ("\n" if proc.stdout and proc.stderr else "") + (proc.stderr or "")
            hashes = re.findall(r"\b([0-9a-f]{64})\b", blob, flags=re.IGNORECASE)
            if proc.returncode != 0:
                if hashes:
                    return jsonify(ok=True, txid=hashes[0], note="reveal_timeout"), 200
                return jsonify(ok=False, error=(blob[-2000:] or "send_failed")), 500

            txid = hashes[0] if hashes else None
            return jsonify(ok=True, txid=txid), 200
        else:
            # Mint-Mode ticker path (existing logic)
            tgt = token  # ticker already normalized upstream

            # (A) Token info endpoint
            rc, out, err = _curl(f"{api_base}/v1/krc20/tokens/{tgt}", timeout=8)
            if rc == 0:
                decimals = _parse_dec(out)

            # (B) Fallback via our address tokenlist (only if (A) failed)
            if decimals is None:
                try:
                    addr = get_fee_payer_address() or ""
                except Exception:
                    addr = ""
                if not addr:
                    addr = (_active_wallet_address() or "")
                if addr:
                    rc2, out2, err2 = _curl(f"{api_base}/v1/krc20/address/{addr}/tokenlist", timeout=8)
                    if rc2 == 0:
                        try:
                            j2 = json.loads(out2)
                            if isinstance(j2, dict) and isinstance(j2.get("result"), list):
                                for it in j2["result"]:
                                    if not isinstance(it, dict):
                                        continue
                                    if str(it.get("tick", "")).upper() == tgt.upper():
                                        de = it.get("dec") or it.get("decimal")
                                        if de is not None and str(de).isdigit():
                                            decimals = int(de)
                                            break
                        except Exception:
                            pass

            if decimals is None:
                return jsonify(ok=False, error="unknown_token_or_missing_decimals"), 400
            if not (0 <= int(decimals) <= 18):
                return jsonify(ok=False, error=f"bad_dec_range:{decimals}"), 400

            # Human -> RAW conversion
            try:
                q = Decimal(str(human))
            except InvalidOperation:
                return jsonify(ok=False, error="invalid_amount_format"), 400
            if q <= 0:
                return jsonify(ok=False, error="amount_must_be_positive"), 400
            frac_digits = -q.as_tuple().exponent if q.as_tuple().exponent < 0 else 0
            if frac_digits > decimals:
                return jsonify(ok=False, error="amount_precision_exceeds_decimals"), 400
            scale = Decimal(10) ** int(decimals)
            raw_dec = (q * scale).to_integral_value(rounding=ROUND_DOWN)
            if raw_dec <= 0:
                return jsonify(ok=False, error="amount_too_small_for_decimals"), 400
            raw_str = str(raw_dec)

            # Execute token transfer (Coinchimp transfer.ts)
            import subprocess, re
            try:
                from pathlib import Path
                priv_hex = (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet" / ".kwh_priv.hex").read_text(encoding="utf-8").strip()
                if not priv_hex:
                    return jsonify(ok=False, error="private_key_missing_or_empty"), 500
            except Exception:
                return jsonify(ok=False, error="private_key_unreadable"), 500

            cmd = ["bun", "run", "transfer.ts",
                   "--privKey",  priv_hex,
                   "--ticker",   tgt,
                   "--dest",     dest,
                   "--amount",   raw_str,
                   "--network",  "mainnet",
                   "--priorityFee", "0.03",
                   "--timeout",     "20000",
                   "--logLevel",    "INFO"]
            proc = subprocess.run(cmd, cwd=(Path(_EDGE_ROOT).parent / "kaspa-krc20-apps").as_posix(),
                      text=True, capture_output=True)
            blob = (proc.stdout or "") + ("\n" if proc.stdout and proc.stderr else "") + (proc.stderr or "")
            hashes = re.findall(r"\b([0-9a-f]{64})\b", blob, flags=re.IGNORECASE)
            if proc.returncode != 0:
                if hashes:
                    return jsonify(ok=True, txid=hashes[0], note="reveal_timeout"), 200
                return jsonify(ok=False, error=(blob[-2000:] or "send_failed")), 500

            txid = hashes[0] if hashes else None
            try:
                _enc_on_broadcast(offer_id, fill_id, txid)
            except Exception:
                pass
            return jsonify(ok=True, txid=txid), 200

    except Exception as e:
        return jsonify(ok=False, error=f"send_stage1_exception:{e.__class__.__name__}:{e}"), 500
# --- END: /api/wallet/send (Stage-1) ---


# --- BEGIN: Encumbrance helpers (single-path; file-backed) ---
def _wallet_dir():
    """
    Returns the active wallet directory: edge-gateway/data/wallet/
    """
    from pathlib import Path
    return (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "wallet")

def _enc_path():
    from pathlib import Path
    return (_wallet_dir() / "encumbrance.json")

def _read_enc():
    """
    Read encumbrance manifest or return None.
    """
    import json
    p = _enc_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None

def _write_enc(obj: dict):
    """
    Write encumbrance manifest atomically.
    """
    import json, os, tempfile
    p = _enc_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, p)

def _enc_on_broadcast(offer_id: str | None, fill_id: str | None, txid: str | None):
    """
    Mark the encumbrance as 'broadcast' when offer/fill matches.
    """
    try:
        enc = _read_enc()
        if not enc:
            return
        if str(enc.get("offer_id")) == str(offer_id) and str(enc.get("fill_id")) == str(fill_id):
            enc["state"] = "broadcast"
            if txid:
                enc["txid"] = txid
            _write_enc(enc)
    except Exception:
        # Non-fatal
        pass


def _pskt_inbox_path():
    """
    Local Phase-2-lite inbox for PSKT fill notices.
    edge-gateway/edge-gateway/data/pskt_inbox_local.json
    """
    from pathlib import Path
    return (Path(_EDGE_ROOT) / "edge-gateway" / "data" / "pskt_inbox_local.json")


def _load_pskt_inbox() -> dict:
    """
    Load PSKT inbox or return empty structure.
    """
    import json
    p = _pskt_inbox_path()
    if not p.exists():
        return {"pending": [], "completed": []}
    try:
        box = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"pending": [], "completed": []}
    if not isinstance(box, dict):
        return {"pending": [], "completed": []}
    pending = box.get("pending")
    completed = box.get("completed")
    if not isinstance(pending, list):
        pending = []
    if not isinstance(completed, list):
        completed = []
    return {"pending": pending, "completed": completed}


def _store_pskt_inbox(box: dict) -> None:
    """
    Store PSKT inbox atomically.
    """
    import json, os, tempfile
    p = _pskt_inbox_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    pending = box.get("pending")
    completed = box.get("completed")
    if not isinstance(pending, list):
        pending = []
    if not isinstance(completed, list):
        completed = []
    payload = {"pending": pending, "completed": completed}
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(tmp, p)


def _append_pskt_notice(notice: dict) -> None:
    """
    Append a single PsktFillNotice into the pending inbox.
    """
    try:
        box = _load_pskt_inbox()
        pending = box.get("pending")
        if not isinstance(pending, list):
            pending = []
        pending.append(notice)
        box["pending"] = pending
        _store_pskt_inbox(box)
    except Exception:
        # Inbox failures must not break wallet flows.
        pass
# --- END: Encumbrance helpers ---

# --- BEGIN: Encumbrance endpoints (read/encumber/cancel/go/clear/settled) ---
@wallet_bp.get("/encumbrance")
def api_wallet_encumbrance_get():
    """
    Return current encumbrance manifest or {"state":"none"}.
    """
    try:
        enc = _read_enc()
        if not enc:
            return jsonify(state="none"), 200
        out = dict(enc)
        out["state"] = out.get("state", "encumbered")
        return jsonify(out), 200
    except Exception:
        return jsonify(state="none"), 200

@wallet_bp.get("/pskt/inbox")
def api_wallet_pskt_inbox_get():
    """
    List pending PsktFillNotice entries for the active wallet (Maker).
    """
    try:
        box = _load_pskt_inbox()
        pending = box.get("pending") or []
        completed = box.get("completed") or []

        # Filter pending notices to those that belong to the active wallet
        addr = (_active_wallet_address() or "").strip()
        if addr:
            owned: list[dict] = []
            for notice in pending:
                if not isinstance(notice, dict):
                    continue
                maker = notice.get("maker") or {}
                recv_addr = str(maker.get("receiveAddress") or "").strip()
                if recv_addr and recv_addr == addr:
                    owned.append(notice)
            pending = owned

        return jsonify(ok=True, pending=pending, completed=completed), 200
    except Exception:
        # Read-only; failures must not affect wallet behavior
        return jsonify(ok=False, error="pskt_inbox_error"), 500

@wallet_bp.post("/encumber")
def api_wallet_encumber():
    """
    Create/overwrite the encumbrance manifest in the active wallet dir.
    Body includes offerId, fillId, asset, to, amount and optional Analyzer/sendContext fields.
    """
    try:
        js = request.get_json(silent=True) or {}

        # Core identifiers (required)
        offer_id = str(js.get("offerId") or js.get("offer_id") or "").strip()
        fill_id = str(js.get("fillId") or js.get("fill_id") or "").strip()
        if not offer_id or not fill_id:
            return jsonify(ok=False, error="missing_offer_or_fill"), 400

        # Extended fields from Analyzer payload (all optional)
        sell = js.get("sell") or {}
        buy = js.get("buy") or {}
        receive_ep = js.get("receiveEndpoint") or js.get("receive_endpoint") or {}
        maker = js.get("maker") or {}
        send_context = js.get("send_context") or {}

        # Legacy/top-level fields with sensible defaults
        asset = (js.get("asset") or (sell.get("symbol") if isinstance(sell, dict) else "") or "").strip()
        to = (js.get("to") or (receive_ep.get("address") if isinstance(receive_ep, dict) else "") or "").strip()
        amount = str(js.get("amount") or js.get("sell_amount") or "").strip()

        # Trade amounts
        sell_amount = str(js.get("sell_amount") or js.get("amount") or "").strip()
        buy_amount = str(js.get("buy_amount") or "").strip()

        # Partial policy
        partial_in = js.get("partial") or {}
        partial_enabled = False
        partial_min = None
        partial_step = None
        if isinstance(partial_in, dict):
            partial_enabled = bool(partial_in.get("enabled"))
            if "min" in partial_in:
                partial_min = str(partial_in.get("min"))
            if "step" in partial_in:
                partial_step = str(partial_in.get("step"))

        # TTL (seconds)
        ttl_raw = js.get("ttl")
        try:
            ttl_int = int(ttl_raw) if ttl_raw is not None else 0
        except Exception:
            ttl_int = 0

        # Normalize maker
        maker_obj: dict = {}
        if isinstance(maker, dict):
            if "wid" in maker:
                maker_obj["wid"] = str(maker.get("wid"))
            if "originKind" in maker:
                maker_obj["originKind"] = str(maker.get("originKind"))
            if "fromAddr" in maker:
                maker_obj["fromAddr"] = str(maker.get("fromAddr"))

        # Normalize send_context (prefer client-provided; fall back to maker/asset/amount)
        sc: dict = {}
        if isinstance(send_context, dict):
            if "wid" in send_context:
                sc["wid"] = str(send_context.get("wid"))
            if "address" in send_context:
                sc["address"] = str(send_context.get("address"))
            if "assetKind" in send_context:
                sc["assetKind"] = str(send_context.get("assetKind"))
            if "assetId" in send_context:
                sc["assetId"] = str(send_context.get("assetId"))
            if "amount" in send_context:
                sc["amount"] = str(send_context.get("amount"))
        else:
            if maker_obj.get("wid"):
                sc["wid"] = maker_obj["wid"]
            if maker_obj.get("fromAddr"):
                sc["address"] = maker_obj["fromAddr"]
        if asset and "assetId" not in sc:
            sc["assetId"] = asset
        if amount and "amount" not in sc:
            sc["amount"] = amount

        # Normalize receiveEndpoint
        recv_obj: dict = {}
        if isinstance(receive_ep, dict):
            for key in ("chain_kind", "chain_id", "address", "source", "wid"):
                if key in receive_ep:
                    recv_obj[key] = receive_ep.get(key)

        # Assemble canonical encumbrance manifest
        enc = {
            "offer_id": offer_id,
            "fill_id": fill_id,
            "asset": asset,
            "to": to,
            "amount": amount,
            "state": "encumbered",
            "go": False,
            "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "notes": "Locked until filled or ON release",
            "maker": maker_obj,
            "send_context": sc,
            "sell": sell if isinstance(sell, dict) else {},
            "buy": buy if isinstance(buy, dict) else {},
            "sell_amount": sell_amount,
            "buy_amount": buy_amount,
            "partial": {
                "enabled": partial_enabled,
            },
            "ttl": ttl_int,
            "receiveEndpoint": recv_obj,
        }
        if partial_min is not None:
            enc["partial"]["min"] = partial_min
        if partial_step is not None:
            enc["partial"]["step"] = partial_step

        _write_enc(enc)
        return jsonify(ok=True), 200
    except Exception as e:
        return jsonify(ok=False, error=f"encumber_exception:{e.__class__.__name__}"), 500

@wallet_bp.post("/encumber/cancel")
def api_wallet_encumber_cancel():
    """
    Record cancel intent locally and mark state='canceled' so the wallet unlocks.
    """
    try:
        enc = _read_enc()
        if not enc:
            return jsonify(ok=True, state="none"), 200
        enc["cancel_requested"] = True
        enc["state"] = "canceled"
        _write_enc(enc)
        return jsonify(ok=True, state=enc.get("state", "canceled")), 200
    except Exception as e:
        return jsonify(ok=False, error=f"cancel_exception:{e.__class__.__name__}"), 500

@wallet_bp.post("/encumbrance/go")
def api_wallet_encumbrance_go():
    """
    Dev stub: mark GO=true so offer-matched 'Complete' is allowed by the pre-gate.
    """
    try:
        enc = _read_enc()
        if not enc:
            return jsonify(ok=False, error="no_encumbrance"), 400
        enc["go"] = True
        _write_enc(enc)
        return jsonify(ok=True), 200
    except Exception as e:
        return jsonify(ok=False, error=f"go_exception:{e.__class__.__name__}"), 500

@wallet_bp.post("/encumbrance/clear")
def api_wallet_encumbrance_clear():
    """
    ON-authorized CLEAR: remove the encumbrance lock.
    """
    try:
        p = _enc_path()
        if p.exists():
            p.unlink()
        return jsonify(ok=True), 200
    except Exception as e:
        return jsonify(ok=False, error=f"clear_exception:{e.__class__.__name__}"), 500

@wallet_bp.post("/encumbrance/settled")
def api_wallet_encumbrance_settled():
    """
    Mark settled then unlock (remove manifest).
    """
    try:
        p = _enc_path()
        if p.exists():
            try:
                enc = _read_enc() or {}
                enc["state"] = "settled"
                _write_enc(enc)
            except Exception:
                pass
            p.unlink(missing_ok=True)
        return jsonify(ok=True), 200
    except Exception as e:
        return jsonify(ok=False, error=f"settled_exception:{e.__class__.__name__}"), 500
# --- END: Encumbrance endpoints ---
