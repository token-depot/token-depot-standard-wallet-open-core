from __future__ import annotations
from typing import Optional, Dict, Any, Tuple
from pathlib import Path
import os, json, base64, time, secrets, hashlib

from mnemonic import Mnemonic
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from common.config_loader import load_config, load_site, REPO_ROOT

# ---- helpers ----------------------------------------------------------------

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

# ---- vault API ---------------------------------------------------------------

# Vault root: $REPO/edge_gateway/edge-gateway/data/wallets/<WALLET_ID>/
VAULT_ROOT = (REPO_ROOT / "edge_gateway" / "edge-gateway" / "data" / "wallets").resolve()

def _vault_wallet_json(wallet_id: str) -> Path:
    """
    Resolve the wallet.json path for a given WALLET_ID under the vault, creating the
    <VAULT_ROOT>/<WALLET_ID>/ directory if needed (0755).
    """
    wid = (wallet_id or "").strip()
    if not wid or "/" in wid or ".." in wid:
        raise ValueError("invalid wallet_id")
    d = (VAULT_ROOT / wid)
    d.mkdir(parents=True, exist_ok=True)  # 0755 by default
    return d / "wallet.json"

def _load_state_from(path: Path) -> Dict[str, Any]:
    """
    Load state from the given wallet.json path (vault-scoped). If absent, return a
    minimal uninitialized state (no secrets).
    """
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"state": "uninitialized", "created_at": None, "has_backup": False}

def _save_state_to(path: Path, obj: Dict[str, Any]) -> None:
    """
    Atomic save to the specified wallet.json path inside the vault.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path.as_posix(), 0o600)
    except Exception:
        pass

def create_wallet_to_vault(wallet_id: str, num_words: int, passphrase: str, mnemonic: Optional[str] = None) -> Dict[str, Any]:
    """
    Create or IMPORT a wallet into the vault ONLY, leaving the canonical active wallet untouched.

    Writes:  $REPO/edge_gateway/edge-gateway/data/wallets/<WALLET_ID>/wallet.json  (0600)

    Returns: { ok, wallet_id, mnemonic, state, path }

    If `mnemonic` is provided, it must be a valid English BIP-39 phrase of exactly 12 or 24 words.
    Otherwise, generate a new mnemonic with `num_words` (12 or 24).
    Idempotent per WALLET_ID: if the target wallet.json already exists in a non-uninitialized
    state, raises RuntimeError("wallet exists").
    """
    if num_words not in (12, 24):
        raise ValueError("num_words must be 12 or 24")
    if not passphrase:
        raise ValueError("passphrase required")

    target = _vault_wallet_json(wallet_id)
    st = _load_state_from(target)
    if st.get("state") not in ("uninitialized", "locked"):
        # For an already-initialized vault file, refuse to overwrite
        raise RuntimeError("wallet exists")

    # Determine mnemonic (import vs create)
    m = Mnemonic("english")
    if mnemonic:
        # normalize: lower-case, single spaces
        mn = " ".join((mnemonic or "").strip().lower().split())
        wc = len(mn.split())
        if wc not in (12, 24):
            raise ValueError("mnemonic must be exactly 12 or 24 words")
        if not m.check(mn):
            raise ValueError("invalid BIP-39 mnemonic checksum")
        mnemonic = mn
        num_words = wc  # reflect actual supplied length
    else:
        mnemonic = m.generate(strength=128 if num_words == 12 else 256)

    # Encrypt & persist (address derived later during confirm/derive step)
    salt = _salt_material()
    key  = _scrypt_key(passphrase, salt)
    nonce, enc = _aesgcm_encrypt(key, mnemonic.encode("utf-8"))

    st.update({
        "state": "pending_backup",
        "has_backup": False,
        "address": None,             # will be derived later
        "salt": base64.b64encode(salt).decode(),
        "scrypt": {"n": 16384, "r": 8, "p": 1, "dklen": 32},
        "nonce": base64.b64encode(nonce).decode(),
        "enc": base64.b64encode(enc).decode(),
        "created_at": st.get("created_at") or _now(),
        "updated_at": _now(),
    })

    _save_state_to(target, st)

    return {
        "ok": True,
        "wallet_id": wallet_id,
        "mnemonic": mnemonic,   # show ONCE to caller; confirm-backup sets ready/address
        "state": st["state"],
        "path": str(target),
    }

