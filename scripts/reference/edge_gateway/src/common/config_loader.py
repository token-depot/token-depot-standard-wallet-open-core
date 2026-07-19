from __future__ import annotations
import os, tempfile, yaml
from pathlib import Path
from typing import Any, Dict, Optional

def _find_repo_root() -> Path:
    p = Path(__file__).resolve()
    for anc in [p.parent, *p.parents]:
        if (anc / "edge_gateway").is_dir():
            return anc if anc.name != "edge_gateway" else anc.parent
    return Path(__file__).resolve().parents[3]

REPO_ROOT: Path = _find_repo_root()
CFG_PATH: Path  = (REPO_ROOT / "edge_gateway" / "config.yaml").resolve()
SITE_PATH: Path = (REPO_ROOT / "edge_gateway" / "site.yaml").resolve()

def _read_yaml(path: Path) -> Dict[str, Any]:
    if not path.exists(): return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}

def _atomic_write_yaml(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    os.close(fd)
    Path(tmp).write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    os.replace(tmp, path)

def load_config() -> Dict[str, Any]: return _read_yaml(CFG_PATH)
def load_site()   -> Dict[str, Any]:
    # Wallet-only build: do not use site.yaml
    return {}

def save_config_admin(admin_updates: Dict[str, Any]) -> Dict[str, Any]:
    cfg = load_config(); admin = cfg.get("ADMIN") or {}; admin.update(admin_updates or {})
    cfg["ADMIN"] = admin; _atomic_write_yaml(CFG_PATH, cfg); return cfg

def save_site(site_updates: Dict[str, Any]) -> Dict[str, Any]:
    # Wallet-only build: do not persist site.yaml
    current: Dict[str, Any] = {}
    current.update(site_updates or {})
    return current

def get_timezone() -> str:
    site = load_site()
    tz = site.get("timezone") or (site.get("location") or {}).get("timezone") or (load_config().get("TIMEZONE"))
    return tz or "America/New_York"

def mask_secret(s: Optional[str]) -> str:
    if not s: return ""
    return "••••••" if len(s) < 4 else f"{s[:2]}••••{s[-2:]}"
def save_full_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Persist the entire config dict as-is."""
    _atomic_write_yaml(CFG_PATH, cfg)
    return cfg
