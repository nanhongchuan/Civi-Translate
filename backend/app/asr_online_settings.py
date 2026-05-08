"""本机在线 ASR 连接信息持久化：独立于翻译模型配置。"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Optional

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DEFAULT_FILE = _DATA_DIR / "asr_online_settings.json"


def settings_path() -> Path:
    raw = os.getenv("RT_ASR_ONLINE_SETTINGS_FILE", "").strip()
    if raw:
        return Path(raw).expanduser()
    return _DEFAULT_FILE


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def load_raw() -> dict[str, Any]:
    path = settings_path()
    if not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            return {}
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_raw(payload: dict[str, Any]) -> None:
    path = settings_path()
    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    _atomic_write(path, raw.encode("utf-8"))


def key_tail_for_display(api_key: str) -> Optional[str]:
    s = (api_key or "").strip()
    if len(s) <= 4:
        return s if s else None
    return s[-4:]
