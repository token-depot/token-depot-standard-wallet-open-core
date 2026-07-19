from __future__ import annotations
from typing import Optional, Dict, Any, Tuple
from pathlib import Path
import os, json, base64, time, secrets, hashlib
import subprocess

from mnemonic import Mnemonic
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from common.config_loader import load_config, load_site, REPO_ROOT

# -----------------------------------------------------------------------------
# Canonical ACTIVE wallet store
# IMPORTANT: do NOT .resolve() here — keep the symlink so /api/wallet/select
# takes effect without a server restart. We only ensure the parent "data" exists.
# -----------------------------------------------------------------------------
DATA_DIR = (REPO_ROOT / "edge_gateway" / "edge-gateway" / "data" / "wallet")
(REPO_ROOT / "edge_gateway" / "edge-gateway" / "data").mkdir(parents=True, exist_ok=True)
WALLET_JSON = DATA_DIR / "wallet.json"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def _now() -> float:
    return time.time()

def _scrypt_key(passphrase: str, salt: bytes, n: int = 2**14, r: int = 8, p: int = 1, dklen: int = 32) -> bytes:
    """
    Singular path: use cryptography’s Scrypt (no hashlib.scrypt).
    """
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    kdf = Scrypt(salt=salt, length=dklen, n=n, r=r, p=p)
    return kdf.derive(passphrase.encode("utf-8"))

def _aesgcm_encrypt(key: bytes, plaintext: bytes) -> Tuple[bytes, bytes]:
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    return nonce, ct

def _aesgcm_decrypt(key: bytes, nonce: bytes, ciphertext: bytes) -> bytes:
    return AESGCM(key).decrypt(nonce, ciphertext, None)

def _load_state() -> Dict[str, Any]:
    if WALLET_JSON.exists():
        return json.loads(WALLET_JSON.read_text(encoding="utf-8"))
    return {"state": "uninitialized", "created_at": None, "has_backup": False}

def _save_state(obj: Dict[str, Any]) -> None:
    WALLET_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = WALLET_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, WALLET_JSON)
    try:
        os.chmod(WALLET_JSON.as_posix(), 0o600)
    except Exception:
        pass

def _salt_material() -> bytes:
    """
    Derive a stable device/site salt; load_site() returns {} in wallet-only builds,
    which is acceptable — we still incorporate REPO_ROOT to vary per install.
    """
    site = load_site() or {}
    site_id = str(site.get("site_id") or "Site").encode("utf-8")
    path_tag = str(REPO_ROOT).encode("utf-8")
    h = hashlib.sha256(site_id + b"|" + path_tag).digest()
    return h[:16]

# -----------------------------------------------------------------------------
# Public API (canonical ACTIVE wallet)
# -----------------------------------------------------------------------------
def status() -> Dict[str, Any]:
    st = _load_state()
    addr = st.get("address")
    return {
        "ok": True,
        "state": st.get("state"),
        "address": addr,
        "has_backup": st.get("has_backup", False)
    }

def get_fee_payer_address() -> Optional[str]:
    """
    Optional convenience: read a configured fee payer address.
    """
    cfg = load_config() or {}
    fees = cfg.get("FEES", {}) if isinstance(cfg, dict) else {}
    if isinstance(fees, dict) and (fees.get("FEE_PAYER_ADDR")):
        return str(fees["FEE_PAYER_ADDR"])
    # legacy/site fallback retained as a no-op-friendly path (site typically {} in wallet-only)
    site = load_site() or {}
    owner = site.get("owner", {}) if isinstance(site, dict) else {}
    return owner.get("kas_address")

def create_wallet(num_words: int, passphrase: str) -> Dict[str, Any]:
    """
    Initialize the ACTIVE wallet (canonical). Returns mnemonic ONCE.
    """
    if num_words not in (12, 24): raise ValueError("num_words must be 12 or 24")
    if not passphrase: raise ValueError("passphrase required")

    st = _load_state()
    if st.get("state") not in ("uninitialized", "locked"):
        raise RuntimeError("wallet exists")

    m = Mnemonic("english")
    mnemonic = m.generate(strength=128 if num_words == 12 else 256)

    salt = _salt_material()
    key  = _scrypt_key(passphrase, salt)
    nonce, enc = _aesgcm_encrypt(key, mnemonic.encode("utf-8"))

    st.update({
        "state": "pending_backup",
        "has_backup": False,
        "address": None,            # filled after derive step
        "salt":   base64.b64encode(salt).decode(),
        "scrypt": {"n": 16384, "r": 8, "p": 1, "dklen": 32},
        "nonce":  base64.b64encode(nonce).decode(),
        "enc":    base64.b64encode(enc).decode(),
        "created_at": st.get("created_at") or _now(),
        "updated_at": _now(),
    })
    _save_state(st)

    # Return mnemonic ONCE (caller must show and then confirm backup)
    return {"ok": True, "mnemonic": mnemonic, "state": st["state"]}

def confirm_backup(passphrase: str) -> Dict[str, Any]:
    """
    Mark ACTIVE wallet as backed up; intended for canonical flow.
    """
    if not passphrase: raise ValueError("passphrase required")

    st = _load_state()
    if st.get("state") != "pending_backup":
        raise RuntimeError("wallet not in pending_backup state")

    st["has_backup"] = True
    st["state"] = "ready"
    st["updated_at"] = _now()
    _save_state(st)

    return {"ok": True, "state": st["state"], "has_backup": True, "address": st.get("address")}

def import_wallet(mnemonic: str, passphrase: str) -> Dict[str, Any]:
    """
    Import an existing mnemonic into the ACTIVE wallet (canonical store).
    """
    if not mnemonic or not passphrase: raise ValueError("mnemonic and passphrase required")
    m = Mnemonic("english")
    if not m.check(mnemonic.strip()): raise ValueError("invalid mnemonic")

    salt = _salt_material()
    key  = _scrypt_key(passphrase, salt)
    nonce, enc = _aesgcm_encrypt(key, mnemonic.strip().encode("utf-8"))

    st = _load_state()
    st.update({
        "state": "pending_backup",
        "has_backup": True,         # already have the phrase
        "address": None,            # will be derived
        "salt":   base64.b64encode(salt).decode(),
        "scrypt": {"n": 16384, "r": 8, "p": 1, "dklen": 32},
        "nonce":  base64.b64encode(nonce).decode(),
        "enc":    base64.b64encode(enc).decode(),
        "created_at": st.get("created_at") or _now(),
        "updated_at": _now(),
    })
    _save_state(st)
    return {"ok": True, "state": st["state"]}

def _unlock(passphrase: str) -> str:
    """
    Decrypt the mnemonic from ACTIVE wallet using passphrase.
    """
    st = _load_state()
    if not st.get("enc") or not st.get("nonce") or not st.get("salt"):
        raise RuntimeError("wallet not initialized")
    key = _scrypt_key(passphrase, base64.b64decode(st["salt"]))
    return _aesgcm_decrypt(key, base64.b64decode(st["nonce"]), base64.b64decode(st["enc"])).decode("utf-8")

def try_derive_address_with_node(passphrase: str, account_path: str = "m/44'/111111'/0'/0/0", network: str = "mainnet") -> Dict[str, Any]:
    """
    Best-effort address derivation via local Node helper (scripts/derive_kas_addr.mjs).
    Returns {ok, address?, stdout?, stderr?}. Non-fatal on error.
    """
    try:
        mnemonic = _unlock(passphrase)
    except Exception as e:
        return {"ok": False, "reason": f"unlock_error:{e.__class__.__name__}"}

    script = (REPO_ROOT / "scripts" / "derive_kas_addr.mjs")
    if not script.exists():
        return {"ok": False, "reason": "missing_node_helper", "script": script.as_posix()}

    try:
        cp = subprocess.run(
            ["node", script.as_posix(),
             f"--mnemonic={mnemonic}",
             f"--bip39pass={passphrase}",
             f"--path={account_path}",
             f"--network={network}"],
            text=True, capture_output=True, check=False, timeout=20
        )
        out = (cp.stdout or "").strip()
        if cp.returncode != 0:
            return {"ok": False, "reason": "subprocess_failed", "stdout": out, "stderr": (cp.stderr or "").strip()}

        try:
            obj = json.loads(out) if out else {}
        except Exception:
            obj = {}
        address = (obj.get("address") or "").strip()
        if address.startswith("kaspa:"):
            # Write derived address into ACTIVE state
            st = _load_state()
            st["address"] = address
            st["updated_at"] = _now()
            _save_state(st)
            return {"ok": True, "address": address}
        return {"ok": False, "reason": "addr_parse_failed", "stdout": out}
    except Exception as e:
        return {"ok": False, "reason": f"subprocess_error:{e}"}

def set_fee_payer_address(addr: str) -> Dict[str, Any]:
    """
    Manually set an address in the ACTIVE wallet (e.g., fee payer); validates kaspa: prefix.
    """
    addr = (addr or "").strip()
    if not (addr.startswith("kaspa:") and 12 <= len(addr) <= 120):
        return {"ok": False, "error": "invalid_kas_address"}
    st = _load_state()
    st["address"] = addr
    st["updated_at"] = _now()
    _save_state(st)
    return {"ok": True, "address": addr}
