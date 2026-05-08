"""Local FastAPI entrypoint: BFF, ASR orchestration, and LLM proxy (M0: health only)."""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, AsyncIterator, Dict, Iterable, Iterator, List, Optional

import requests
from requests import exceptions as req_exc

from app import asr_online_settings
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.asr_service import (
    get_asr_engine,
    get_asr_import_error,
    get_asr_model_name,
    is_asr_importable,
    reset_asr_model_cache,
    transcribe_int16_16k_mono,
)
from app.llm_settings import key_tail_for_display, load_raw, save_raw
from app.online_asr_service import wav_bytes_from_pcm16_16k_mono

_API_PREFIX = "/api"

_LLM_TEST_UA = "realtime-translate/0.1 (llm-test)"
_ASR_SAMPLE_RATE = 16000
_ASR_BYTES_PER_SAMPLE = 2
_ASR_MIN_TRANSCRIBE_SEC = 0.72
_ASR_PARTIAL_INTERVAL_SEC = 0.65
_ASR_ENDPOINT_SILENCE_SEC = 0.55
_ASR_MAX_SEGMENT_SEC = 4.8
_ASR_RMS_SPEECH_THRESHOLD = 450.0
_ASR_INSTALL_JOBS: Dict[str, Dict[str, Any]] = {}
_ASR_INSTALL_LOCK = threading.Lock()
_LLM_REQUEST_LOCK = threading.Lock()
_LLM_LAST_REQUEST_AT = 0.0
_PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v2"
_WHISPER_MODEL_ID = "faster-whisper-medium"
_ONLINE_ASR_MODEL_ID = "online-asr-api"
_PARAKEET_VENV_DIR = ".venv-parakeet"
_PARAKEET_PYTHON_VERSION = "3.12.12"
_DEFAULT_TRANSLATION_SYSTEM_PROMPT = (
    "You are a live interpreter. Translate the user text. "
    "The answer language must be ONLY the target language, including single words, "
    "fragments, and numbers written as that language would normally write them, "
    "not left in the source. "
    "If the user text is already in the target language, return it with minimal edits. "
    "No headings, no quotes around the result, no explanations, no markdown. "
    "Output plain translated text only."
)


def _llm_env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(1.0, float(raw))
    except ValueError:
        return default


def _requests_timeout_connect_read(*, stream: bool) -> tuple[float, float]:
    """requests 的 (connect, read)。流式时 read 为「相邻两次收到数据之间的最大间隔」（慢模型首 token）。"""
    connect = _llm_env_float("RT_LLM_CONNECT_TIMEOUT", 60.0)
    if stream:
        read_gap = _llm_env_float("RT_LLM_STREAM_READ_TIMEOUT", 600.0)
        return (connect, read_gap)
    read_total = _llm_env_float("RT_LLM_READ_TIMEOUT", 300.0)
    return (connect, read_total)


def _llm_min_request_interval() -> float:
    raw = os.getenv("RT_LLM_MIN_REQUEST_INTERVAL", "").strip()
    if not raw:
        return 0.35
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 2.0


def _pace_llm_request() -> None:
    global _LLM_LAST_REQUEST_AT
    interval = _llm_min_request_interval()
    if interval <= 0:
        return
    with _LLM_REQUEST_LOCK:
        now = time.monotonic()
        wait = interval - (now - _LLM_LAST_REQUEST_AT)
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _LLM_LAST_REQUEST_AT = now


def _llm_verify_tls() -> bool:
    return os.getenv("RT_LLM_SSL_VERIFY", "").strip().lower() not in ("0", "false", "no")


def _requests_verify_and_proxies() -> tuple[Any, Optional[Dict[str, str]]]:
    """verify 与可选代理；显式 RT_LLM_HTTPS_PROXY / RT_LLM_HTTP_PROXY 优先于 urllib3 从环境推断。"""
    verify = _llm_verify_tls()
    https_p = os.getenv("RT_LLM_HTTPS_PROXY", "").strip()
    http_p = os.getenv("RT_LLM_HTTP_PROXY", "").strip()
    if https_p or http_p:
        proxies: dict[str, str] = {}
        if http_p:
            proxies["http"] = http_p
        if https_p:
            proxies["https"] = https_p
        elif http_p:
            proxies["https"] = http_p
        return verify, proxies
    return verify, None


def _llm_stream_net_err_message(exc: BaseException) -> str:
    """部分异常 str 为空，避免界面只显示冒号后无内容。"""
    raw = str(exc).strip()
    extra = f"{type(exc).__name__}" + (f": {raw[:200]}" if raw else f": {repr(exc)[:200]}")
    hint = (
        "请核对「设置」中的 Base URL；若走系统代理可设 RT_LLM_HTTPS_PROXY；"
        "流式慢可提高 RT_LLM_STREAM_READ_TIMEOUT（相邻数据间隔秒数，默认 600）；"
        "非流式可提高 RT_LLM_READ_TIMEOUT。"
    )
    return f"无法连接语言模型或等待超时（{extra[:220]}）。{hint}"


def _llm_upstream_error_snippet(parsed: Any) -> str:
    """OpenAI 兼容 JSON 里的 error 字段（部分网关 HTTP 2xx 仍带 error）。"""
    if not isinstance(parsed, dict) or "error" not in parsed:
        return ""
    e = parsed["error"]
    if isinstance(e, dict):
        return str(e.get("message", e.get("code", e)))[:200]
    return str(e)[:200]


def _parse_model_ids(parsed: Any) -> list[str]:
    """OpenAI-compatible /models payload -> model id list."""
    if not isinstance(parsed, dict):
        return []
    data = parsed.get("data")
    if not isinstance(data, list):
        return []
    ids: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
    return ids


def _log_translate_failure(status_code: int, detail: str, model: str, text: str) -> None:
    snippet = (detail or "").replace("\n", " ")[:500]
    print(
        f"[translate] upstream failed status={status_code} model={model} "
        f"text_len={len(text)} detail={snippet}",
        flush=True,
    )


def _pcm16_duration_sec(pcm: bytes | bytearray) -> float:
    return len(pcm) / float(_ASR_SAMPLE_RATE * _ASR_BYTES_PER_SAMPLE)


def _pcm16_rms(pcm: bytes | bytearray) -> float:
    if len(pcm) < _ASR_BYTES_PER_SAMPLE:
        return 0.0
    sample_count = len(pcm) // _ASR_BYTES_PER_SAMPLE
    if sample_count <= 0:
        return 0.0
    # Fast enough for 40ms frames, avoids adding numpy to the hot websocket path.
    total = 0.0
    usable = sample_count * _ASR_BYTES_PER_SAMPLE
    for i in range(0, usable, _ASR_BYTES_PER_SAMPLE):
        sample = int.from_bytes(pcm[i : i + 2], "little", signed=True)
        total += sample * sample
    return (total / sample_count) ** 0.5


def _asr_text_changed(prev: str, current: str) -> bool:
    p = prev.strip()
    c = current.strip()
    if not c:
        return False
    if c == p:
        return False
    if p and c.startswith(p) and len(c) - len(p) < 3:
        return False
    return True


app = FastAPI(title="Realtime Translate API", version="0.1.0")

_origins_env = os.getenv("CORS_ORIGINS", "").strip()
if _origins_env:
    _cors_origins = [o.strip() for o in _origins_env.split(",") if o.strip()]
else:
    _cors_origins = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ]

# 任意本机端口的页面（Vite 随机口、内嵌/浏览器预览、4173 等）可直连 127.0.0.1:18787，不依赖同域 /api 代理
_LOCAL_ORIGIN_RE = r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_LOCAL_ORIGIN_RE,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _asr_status() -> Dict[str, Any]:
    engine = get_asr_engine()
    import_error = get_asr_import_error()
    if import_error:
        return {
            "available": False,
            "engine": engine,
            "model": get_asr_model_name(),
            "import_error": import_error,
        }
    return {
        "available": True,
        "engine": engine,
        "model": get_asr_model_name(),
    }


def _asr_import_error_for_engine(engine: str) -> str:
    if engine == "online_api":
        return _online_asr_config_error()
    if engine == "parakeet":
        return _parakeet_venv_import_error()
    if engine == "faster_whisper":
        return _whisper_import_error()
    return f"unsupported engine {engine!r}"


def _asr_runtime_import_error_for_engine(engine: str) -> str:
    if engine == "online_api":
        return _online_asr_config_error()
    if engine == "parakeet":
        venv_error = _parakeet_venv_import_error()
        if venv_error:
            return venv_error
    try:
        if engine == "parakeet":
            import nemo.collections.asr as nemo_asr  # noqa: F401
        elif engine == "faster_whisper":
            import faster_whisper  # noqa: F401
        else:
            return f"unsupported engine {engine!r}"
    except ImportError as exc:
        return str(exc)
    return ""


def _online_asr_config_error() -> str:
    raw = asr_online_settings.load_raw()
    base_url = (raw.get("base_url") or "").strip()
    model = (raw.get("model") or "").strip()
    api_key = (raw.get("api_key") or "").strip()
    if not base_url or not model or not api_key:
        return "请先保存在线转写 API 配置。"
    if not base_url.startswith(("http://", "https://")):
        return "在线转写 Base URL 须以 http:// 或 https:// 开头。"
    return ""


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(__file__)))


def _parakeet_venv_python() -> str:
    return os.path.join(_project_root(), _PARAKEET_VENV_DIR, "bin", "python")


def _parakeet_venv_import_error() -> str:
    py = _parakeet_venv_python()
    if not os.path.exists(py):
        return "未安装 NVIDIA NeMo"
    try:
        proc = subprocess.run(
            [py, "-c", "import nemo.collections.asr"],
            cwd=_project_root(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return str(exc)[:500]
    if proc.returncode == 0:
        return ""
    return (proc.stdout or "").strip()[-1000:] or f"python exited with {proc.returncode}"


def _python_import_error(python_bin: str, module: str) -> str:
    try:
        proc = subprocess.run(
            [python_bin, "-c", f"import {module}"],
            cwd=_project_root(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return str(exc)[:500]
    if proc.returncode == 0:
        return ""
    return (proc.stdout or "").strip()[-1000:] or f"python exited with {proc.returncode}"


def _whisper_import_error() -> str:
    return _python_import_error(sys.executable, "faster_whisper")


def _asr_model_status() -> list[dict[str, Any]]:
    parakeet_error = _asr_import_error_for_engine("parakeet")
    whisper_error = _asr_import_error_for_engine("faster_whisper")
    online_error = _asr_import_error_for_engine("online_api")
    online_raw = asr_online_settings.load_raw()
    online_model = (online_raw.get("model") or "").strip() or "未配置"
    with _ASR_INSTALL_LOCK:
        parakeet_job = dict(_ASR_INSTALL_JOBS.get(_PARAKEET_MODEL_ID, {}))
        whisper_job = dict(_ASR_INSTALL_JOBS.get(_WHISPER_MODEL_ID, {}))
    return [
        {
            "id": _PARAKEET_MODEL_ID,
            "engine": "parakeet",
            "name": "NVIDIA Parakeet · TDT 0.6B v2",
            "model": "nvidia/parakeet-tdt-0.6b-v2",
            "installed": not parakeet_error,
            "installing": parakeet_job.get("status") == "running",
            "status": parakeet_job.get("status") or ("installed" if not parakeet_error else "not_installed"),
            "message": parakeet_job.get("message") or ("" if not parakeet_error else "未安装 NVIDIA NeMo"),
            "error": parakeet_job.get("error") or "",
        },
        {
            "id": _WHISPER_MODEL_ID,
            "engine": "faster_whisper",
            "name": "faster-whisper · medium",
            "model": "medium",
            "installed": not whisper_error,
            "installing": whisper_job.get("status") == "running",
            "status": whisper_job.get("status") or ("installed" if not whisper_error else "not_installed"),
            "message": whisper_job.get("message") or ("" if not whisper_error else "未安装 faster-whisper"),
            "error": whisper_job.get("error") or whisper_error,
        },
        {
            "id": _ONLINE_ASR_MODEL_ID,
            "engine": "online_api",
            "name": "在线转写 API",
            "model": online_model,
            "installed": not online_error,
            "installing": False,
            "status": "configured" if not online_error else "not_configured",
            "message": "" if not online_error else online_error,
            "error": online_error,
        },
    ]


def _run_asr_install_job(model_id: str) -> None:
    if model_id == _WHISPER_MODEL_ID:
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "running",
                "message": "正在安装 faster-whisper。",
                "error": "",
            }
        try:
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-r",
                    os.path.join(_project_root(), "backend", "requirements.txt"),
                ],
                cwd=_project_root(),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=1800,
                check=False,
            )
            if proc.returncode != 0:
                with _ASR_INSTALL_LOCK:
                    _ASR_INSTALL_JOBS[model_id] = {
                        "status": "failed",
                        "message": "faster-whisper 安装失败。",
                        "error": (proc.stdout or "").strip()[-1200:] or f"pip exited with {proc.returncode}",
                    }
                return
            with _ASR_INSTALL_LOCK:
                _ASR_INSTALL_JOBS[model_id] = {
                    "status": "succeeded",
                    "message": "faster-whisper 已安装。",
                    "error": "",
                }
        except subprocess.TimeoutExpired:
            with _ASR_INSTALL_LOCK:
                _ASR_INSTALL_JOBS[model_id] = {
                    "status": "failed",
                    "message": "faster-whisper 安装超时。",
                    "error": "安装超过 30 分钟仍未结束。",
                }
        except Exception as exc:  # noqa: BLE001
            with _ASR_INSTALL_LOCK:
                _ASR_INSTALL_JOBS[model_id] = {
                    "status": "failed",
                    "message": "faster-whisper 安装异常。",
                    "error": str(exc)[:1200],
                }
        return
    if model_id != _PARAKEET_MODEL_ID:
        return
    uv = shutil.which("uv")
    with _ASR_INSTALL_LOCK:
        _ASR_INSTALL_JOBS[model_id] = {
            "status": "running",
            "message": "正在创建 Python 3.12 环境并安装 Parakeet 依赖，首次安装可能需要几分钟。",
            "error": "",
        }
    if not uv:
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "failed",
                "message": "Parakeet 安装失败。",
                "error": "未找到 uv。请先安装 uv，或手动创建 Python 3.12 环境后安装 requirements-parakeet.txt。",
            }
        return
    try:
        root = _project_root()
        steps = [
            [uv, "venv", _PARAKEET_VENV_DIR, "--python", _PARAKEET_PYTHON_VERSION],
            [
                uv,
                "pip",
                "install",
                "--python",
                _parakeet_venv_python(),
                "-r",
                os.path.join("backend", "requirements.txt"),
                "-r",
                os.path.join("backend", "requirements-parakeet.txt"),
            ],
            [_parakeet_venv_python(), "-c", "import nemo.collections.asr"],
        ]
        outputs: list[str] = []
        for cmd in steps:
            proc = subprocess.run(
                cmd,
                cwd=root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=1800,
                check=False,
            )
            outputs.append(f"$ {' '.join(cmd)}\n{proc.stdout or ''}")
            if proc.returncode != 0:
                output = "\n\n".join(outputs).strip()
                with _ASR_INSTALL_LOCK:
                    _ASR_INSTALL_JOBS[model_id] = {
                        "status": "failed",
                        "message": "Parakeet 安装失败。",
                        "error": output[-1200:] or f"install step exited with {proc.returncode}",
                    }
                return
        proc = subprocess.run(
            [_parakeet_venv_python(), "-c", "import sys; print(sys.version.split()[0])"],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "succeeded",
                "message": "Parakeet 已安装。重启软件后即可启用。",
                "error": "",
            }
    except subprocess.TimeoutExpired:
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "failed",
                "message": "Parakeet 安装超时。",
                "error": "安装超过 30 分钟仍未结束，请在终端手动运行 npm run api:install:parakeet 查看完整输出。",
            }
    except Exception as exc:  # noqa: BLE001
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "failed",
                "message": "Parakeet 安装异常。",
                "error": str(exc)[:1200],
            }


@app.get(f"{_API_PREFIX}/asr/models")
def get_asr_models() -> Dict[str, Any]:
    return {
        "ok": True,
        "current": _asr_status(),
        "models": _asr_model_status(),
    }


@app.post(f"{_API_PREFIX}/asr/models/{{model_id}}/install")
def install_asr_model(model_id: str) -> Dict[str, Any]:
    if model_id not in (_PARAKEET_MODEL_ID, _WHISPER_MODEL_ID):
        raise HTTPException(status_code=404, detail="未知 ASR 模型。")
    if model_id == _WHISPER_MODEL_ID:
        if not _asr_import_error_for_engine("faster_whisper"):
            with _ASR_INSTALL_LOCK:
                _ASR_INSTALL_JOBS[model_id] = {
                    "status": "succeeded",
                    "message": "faster-whisper 已安装。",
                    "error": "",
                }
            return {"ok": True, "status": "installed", "message": "faster-whisper 已安装。"}
        with _ASR_INSTALL_LOCK:
            existing = _ASR_INSTALL_JOBS.get(model_id)
            if existing and existing.get("status") == "running":
                return {"ok": True, "status": "running", "message": existing.get("message", "正在安装。")}
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "running",
                "message": "正在安装 faster-whisper。",
                "error": "",
            }
        t = threading.Thread(target=_run_asr_install_job, args=(model_id,), daemon=True, name="asr-install-whisper")
        t.start()
        return {"ok": True, "status": "running", "message": "已开始安装 faster-whisper。"}
    if not _asr_import_error_for_engine("parakeet"):
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS[model_id] = {
                "status": "succeeded",
                "message": "Parakeet 已安装。重启软件后即可启用。",
                "error": "",
            }
        return {"ok": True, "status": "installed", "message": "Parakeet 已安装。"}
    with _ASR_INSTALL_LOCK:
        existing = _ASR_INSTALL_JOBS.get(model_id)
        if existing and existing.get("status") == "running":
            return {"ok": True, "status": "running", "message": existing.get("message", "正在安装。")}
        _ASR_INSTALL_JOBS[model_id] = {
            "status": "running",
            "message": "正在安装 Parakeet 依赖，首次安装可能需要几分钟。",
            "error": "",
        }
    t = threading.Thread(target=_run_asr_install_job, args=(model_id,), daemon=True, name="asr-install")
    t.start()
    return {"ok": True, "status": "running", "message": "已开始安装 Parakeet。"}


@app.post(f"{_API_PREFIX}/asr/models/{{model_id}}/uninstall")
def uninstall_asr_model(model_id: str) -> Dict[str, Any]:
    if model_id not in (_PARAKEET_MODEL_ID, _WHISPER_MODEL_ID):
        raise HTTPException(status_code=404, detail="未知 ASR 模型。")
    if model_id == _WHISPER_MODEL_ID:
        if get_asr_engine() == "faster_whisper":
            if not _asr_import_error_for_engine("parakeet"):
                os.environ["RT_ASR_ENGINE"] = "parakeet"
                os.environ["RT_ASR_MODEL"] = "nvidia/parakeet-tdt-0.6b-v2"
                reset_asr_model_cache()
            else:
                raise HTTPException(status_code=400, detail="当前正在使用 faster-whisper，且没有其他可用转写模型。")
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "uninstall", "-y", "faster-whisper"],
            cwd=_project_root(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=600,
            check=False,
        )
        if proc.returncode != 0:
            raise HTTPException(
                status_code=400,
                detail=f"卸载失败：{(proc.stdout or '').strip()[-500:]}",
            )
        with _ASR_INSTALL_LOCK:
            _ASR_INSTALL_JOBS.pop(model_id, None)
        return {"ok": True, "status": "not_installed", "message": "已卸载。"}
    if get_asr_engine() == "parakeet":
        os.environ["RT_ASR_ENGINE"] = "faster_whisper"
        os.environ["RT_ASR_MODEL"] = "medium"
        reset_asr_model_cache()
    venv_dir = os.path.join(_project_root(), _PARAKEET_VENV_DIR)
    if os.path.exists(venv_dir):
        trash_dir = f"{venv_dir}.uninstalled-{uuid.uuid4().hex[:8]}"
        try:
            os.replace(venv_dir, trash_dir)
            shutil.rmtree(trash_dir, ignore_errors=True)
        except OSError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"卸载失败：{str(exc)[:200]}",
            ) from exc
    with _ASR_INSTALL_LOCK:
        _ASR_INSTALL_JOBS.pop(model_id, None)
    return {"ok": True, "status": "not_installed", "message": "已卸载。"}


@app.post(f"{_API_PREFIX}/asr/models/{{model_id}}/activate")
def activate_asr_model(model_id: str) -> Dict[str, Any]:
    if model_id == _PARAKEET_MODEL_ID:
        engine = "parakeet"
        model = "nvidia/parakeet-tdt-0.6b-v2"
    elif model_id == _WHISPER_MODEL_ID:
        engine = "faster_whisper"
        model = "medium"
    elif model_id == _ONLINE_ASR_MODEL_ID:
        engine = "online_api"
        raw = asr_online_settings.load_raw()
        model = (raw.get("model") or "").strip()
    else:
        raise HTTPException(status_code=404, detail="未知 ASR 模型。")
    import_error = _asr_runtime_import_error_for_engine(engine)
    if import_error:
        raise HTTPException(
            status_code=400,
            detail="当前模型还不能直接启用。请先完成安装，或重启软件后再试。",
        )
    os.environ["RT_ASR_ENGINE"] = engine
    os.environ["RT_ASR_MODEL"] = model
    reset_asr_model_cache()
    return {"ok": True, "engine": engine, "model": model, "message": "已启用。"}


@app.get(f"{_API_PREFIX}/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "realtime-translate-api",
        "asr": _asr_status(),
        # 供前端与「仍在跑旧版 uvicorn」时的诊断区分（旧进程无此字段且无 LLM 路由会 404）
        "llm_settings": True,
        # 含 POST /api/settings/llm/test；旧进程无此字段
        "llm_test": True,
        # 含在线 ASR API 配置与测试路由
        "asr_online_settings": True,
        # 当前进程翻译走 requests/urllib3；无此字段多为未重启的旧 API
        "llm_translate": "requests",
    }


class LlmSettingsOut(BaseModel):
    vendor: str
    base_url: str
    model: str
    api_key_configured: bool
    api_key_tail: Optional[str] = None


class LlmSettingsIn(BaseModel):
    vendor: str = Field(min_length=1, max_length=64)
    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="")


class AsrOnlineSettingsOut(BaseModel):
    vendor: str
    base_url: str
    model: str
    api_key_configured: bool
    api_key_tail: Optional[str] = None
    language_hint: Optional[str] = None


class AsrOnlineSettingsIn(BaseModel):
    vendor: str = Field(default="openai-audio-compatible", min_length=1, max_length=64)
    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="")
    language_hint: Optional[str] = Field(default=None, max_length=20)


class PromptSettingsOut(BaseModel):
    system_prompt: str
    default_system_prompt: str


class PromptSettingsIn(BaseModel):
    system_prompt: str = Field(min_length=1, max_length=4000)


# UI 中文名 / 与前端 code 的别名 → 无歧义英文，提高翻译模型对目标语遵从度
_LLM_LABEL_ALIASES: Dict[str, str] = {
    "auto": "auto-detect",
    "自动检测": "auto-detect",
    "en": "English",
    "英语": "English",
    "zh": "Simplified Chinese",
    "中文": "Simplified Chinese",
    "ja": "Japanese",
    "日语": "Japanese",
    "ko": "Korean",
    "韩语": "Korean",
}


def _llm_source_label(raw: str) -> str:
    s = (raw or "auto").strip() or "auto"
    return _LLM_LABEL_ALIASES.get(s, s)


def _llm_target_label(raw: str) -> str:
    s = (raw or "").strip()
    return _LLM_LABEL_ALIASES.get(s, s)


# 与前端 LANGS value 一致，供提示词锁脚本 / BCP-47
_LANG_TO_BCP47: Dict[str, str] = {
    "en": "en",
    "zh": "zh-Hans",
    "ja": "ja",
    "ko": "ko",
    "auto": "",
}


def _bcp47_from_code(code: Optional[str]) -> str:
    c = (code or "").strip()
    if c in ("", "auto"):
        return ""
    return _LANG_TO_BCP47.get(c, c)


class TranslateIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    source_language: str = Field(default="auto", max_length=80)
    target_language: str = Field(min_length=1, max_length=80)
    source_lang_code: Optional[str] = Field(default=None, max_length=20)
    target_lang_code: Optional[str] = Field(default=None, max_length=20)
    previous_source_text: Optional[str] = Field(default=None, max_length=4000)
    previous_translation_text: Optional[str] = Field(default=None, max_length=4000)


class TranslateOut(BaseModel):
    ok: bool
    translation: str


def _is_realtime_reasoning_model(model: str) -> bool:
    model_l = (model or "").lower()
    return any(
        marker in model_l
        for marker in ("glm-5", "deepseek-reasoner", "o1", "o3", "o4", "gpt-5")
    )


def _supports_disabled_thinking_param(model: str) -> bool:
    model_l = (model or "").lower()
    return model_l.startswith("glm-") or "glm-5" in model_l


@app.get(f"{_API_PREFIX}/settings/llm", response_model=LlmSettingsOut)
def get_llm_settings() -> LlmSettingsOut:
    raw = load_raw()
    key = (raw.get("api_key") or "").strip()
    return LlmSettingsOut(
        vendor=(raw.get("vendor") or "openai-compatible")[:64],
        base_url=(raw.get("base_url") or "")[:2000],
        model=(raw.get("model") or "")[:200],
        api_key_configured=bool(key),
        api_key_tail=key_tail_for_display(key),
    )


@app.post(f"{_API_PREFIX}/settings/llm")
def post_llm_settings(body: LlmSettingsIn) -> Dict[str, Any]:
    b = (body.base_url or "").strip()
    m = (body.model or "").strip()
    v = (body.vendor or "").strip()
    if not b.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Base URL 须以 http:// 或 https:// 开头",
        )
    new_key = (body.api_key or "").strip()
    raw = load_raw()
    old_key = (raw.get("api_key") or "").strip()
    if not new_key and not old_key:
        raise HTTPException(status_code=400, detail="请填写 API Key")
    final_key = new_key if new_key else old_key
    if not final_key:
        raise HTTPException(status_code=400, detail="请填写 API Key")
    save_raw(
        {
            "vendor": v,
            "base_url": b,
            "model": m,
            "api_key": final_key,
            "system_prompt": (raw.get("system_prompt") or "").strip(),
        },
    )
    return {"ok": True, "message": "saved"}


@app.get(f"{_API_PREFIX}/settings/asr-online", response_model=AsrOnlineSettingsOut)
def get_asr_online_settings() -> AsrOnlineSettingsOut:
    raw = asr_online_settings.load_raw()
    key = (raw.get("api_key") or "").strip()
    return AsrOnlineSettingsOut(
        vendor=(raw.get("vendor") or "openai-audio-compatible")[:64],
        base_url=(raw.get("base_url") or "")[:2000],
        model=(raw.get("model") or "")[:200],
        api_key_configured=bool(key),
        api_key_tail=asr_online_settings.key_tail_for_display(key),
        language_hint=(raw.get("language_hint") or "")[:20] or None,
    )


@app.post(f"{_API_PREFIX}/settings/asr-online")
def post_asr_online_settings(body: AsrOnlineSettingsIn) -> Dict[str, Any]:
    base_url = (body.base_url or "").strip()
    model = (body.model or "").strip()
    vendor = (body.vendor or "").strip()
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Base URL 须以 http:// 或 https:// 开头",
        )
    new_key = (body.api_key or "").strip()
    raw = asr_online_settings.load_raw()
    old_key = (raw.get("api_key") or "").strip()
    if not new_key and not old_key:
        raise HTTPException(status_code=400, detail="请填写 API Key")
    final_key = new_key if new_key else old_key
    payload: dict[str, Any] = {
        "vendor": vendor,
        "base_url": base_url,
        "model": model,
        "api_key": final_key,
    }
    if body.language_hint:
        payload["language_hint"] = body.language_hint.strip()
    asr_online_settings.save_raw(payload)
    return {"ok": True, "message": "saved"}


def _tiny_wav_for_asr_test() -> bytes:
    # 0.4s silence is enough to validate OpenAI-style multipart audio routing without sending user audio.
    return wav_bytes_from_pcm16_16k_mono(b"\x00\x00" * int(_ASR_SAMPLE_RATE * 0.4))


@app.post(f"{_API_PREFIX}/settings/asr-online/test")
def test_asr_online_settings(body: AsrOnlineSettingsIn) -> Dict[str, Any]:
    base_url = (body.base_url or "").strip().rstrip("/")
    model = (body.model or "").strip()
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Base URL 须以 http:// 或 https:// 开头",
        )
    new_key = (body.api_key or "").strip()
    raw = asr_online_settings.load_raw()
    old_key = (raw.get("api_key") or "").strip()
    if not new_key and not old_key:
        raise HTTPException(
            status_code=400,
            detail="请填写 API Key，或先点击「保存」再测已存 Key。",
        )
    final_key = new_key if new_key else old_key
    headers = {
        "Authorization": f"Bearer {final_key}",
        "Accept": "application/json",
        "User-Agent": "realtime-translate/0.1 (online-asr-test)",
    }
    try:
        r = requests.post(
            f"{base_url}/audio/transcriptions",
            headers=headers,
            data={
                "model": model,
                **({"language": body.language_hint.strip()} if body.language_hint and body.language_hint.strip() not in ("auto", "") else {}),
            },
            files={"file": ("test.wav", _tiny_wav_for_asr_test(), "audio/wav")},
            timeout=(30.0, 120.0),
        )
    except req_exc.ConnectionError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"无法连接：{str(exc)[:200]}",
        ) from exc
    except req_exc.Timeout as exc:
        raise HTTPException(
            status_code=400,
            detail="请求超时，请检查网络与 Base URL。",
        ) from exc
    except req_exc.RequestException as exc:
        raise HTTPException(
            status_code=400,
            detail=f"请求失败：{str(exc)[:200]}",
        ) from exc

    parsed: Any = None
    try:
        parsed = r.json()
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    err_snip = _llm_upstream_error_snippet(parsed) if parsed is not None else ""
    if 200 <= r.status_code < 300 and not err_snip:
        return {"ok": True, "message": "连接成功，在线转写端点有响应。"}
    if r.status_code in (401, 403):
        detail = err_snip or "Key 或权限无效。"
        raise HTTPException(
            status_code=400,
            detail=f"Key 或权限无效（HTTP {r.status_code}）：{detail}",
        )
    if r.status_code in (404, 405):
        try:
            models_r = requests.get(
                f"{base_url}/models",
                headers=headers,
                timeout=(30.0, 120.0),
            )
        except req_exc.RequestException as exc:
            raise HTTPException(
                status_code=400,
                detail=f"转写端点不可用，且模型列表验证失败：{str(exc)[:200]}",
            ) from exc
        try:
            models_parsed: Any = models_r.json()
        except (json.JSONDecodeError, TypeError, ValueError):
            models_parsed = None
        models_err = _llm_upstream_error_snippet(models_parsed)
        if 200 <= models_r.status_code < 300 and not models_err:
            model_ids = _parse_model_ids(models_parsed)
            if model_ids and model not in model_ids:
                preview = "、".join(model_ids[:8])
                more = " 等" if len(model_ids) > 8 else ""
                raise HTTPException(
                    status_code=400,
                    detail=f"端点与 Key 有效，但模型列表中未找到 {model}。可用模型示例：{preview}{more}",
                )
            return {"ok": True, "message": "连接成功，模型列表可用；该端点未验证实际转写。"}
    if r.status_code == 400 and not err_snip:
        return {"ok": True, "message": "端点已响应；测试音频未被接受，但鉴权与路由可达。"}
    detail = err_snip or (r.text or "")[:300] or "无响应内容"
    raise HTTPException(
        status_code=400,
        detail=f"在线转写端点返回 HTTP {r.status_code}：{detail}"[:500],
    )


def _load_translation_system_prompt() -> str:
    raw = load_raw()
    custom = (raw.get("system_prompt") or "").strip()
    return custom or _DEFAULT_TRANSLATION_SYSTEM_PROMPT


@app.get(f"{_API_PREFIX}/settings/prompt", response_model=PromptSettingsOut)
def get_prompt_settings() -> PromptSettingsOut:
    return PromptSettingsOut(
        system_prompt=_load_translation_system_prompt(),
        default_system_prompt=_DEFAULT_TRANSLATION_SYSTEM_PROMPT,
    )


@app.post(f"{_API_PREFIX}/settings/prompt")
def post_prompt_settings(body: PromptSettingsIn) -> Dict[str, Any]:
    prompt = (body.system_prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="请填写系统提示词")
    raw = load_raw()
    raw["system_prompt"] = prompt
    save_raw(raw)
    return {"ok": True, "message": "saved"}


@app.post(f"{_API_PREFIX}/settings/llm/test")
def test_llm_settings(body: LlmSettingsIn) -> Dict[str, Any]:
    b = (body.base_url or "").strip()
    m = (body.model or "").strip()
    if not b.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Base URL 须以 http:// 或 https:// 开头",
        )
    new_key = (body.api_key or "").strip()
    raw = load_raw()
    old_key = (raw.get("api_key") or "").strip()
    if not new_key and not old_key:
        raise HTTPException(
            status_code=400,
            detail="请填写 API Key，或先点击「保存」再测已存 Key。",
        )
    final_key = new_key if new_key else old_key
    base = b.rstrip("/")
    verify, proxies = _requests_verify_and_proxies()
    to = _requests_timeout_connect_read(stream=False)
    headers = {
        "Authorization": f"Bearer {final_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": _LLM_TEST_UA,
    }
    try:
        models_r = requests.get(
            f"{base}/models",
            headers=headers,
            timeout=to,
            verify=verify,
            proxies=proxies,
        )
        models_parsed: Any
        try:
            models_parsed = models_r.json()
        except (json.JSONDecodeError, TypeError, ValueError):
            models_parsed = None
        models_err = _llm_upstream_error_snippet(models_parsed)
        if 200 <= models_r.status_code < 300 and not models_err:
            model_ids = _parse_model_ids(models_parsed)
            if not model_ids:
                return {"ok": True, "message": "连接成功，端点与 Key 有效。"}
            if m in model_ids:
                return {"ok": True, "message": "连接成功，模型可用。"}
            preview = "、".join(model_ids[:8])
            more = " 等" if len(model_ids) > 8 else ""
            raise HTTPException(
                status_code=400,
                detail=f"端点与 Key 有效，但模型列表中未找到 {m}。可用模型示例：{preview}{more}",
            )
        if models_r.status_code in (401, 403):
            if models_err:
                raise HTTPException(
                    status_code=400,
                    detail=f"Key 或权限无效（HTTP {models_r.status_code}）：{models_err}",
                )
            raise HTTPException(
                status_code=400,
                detail="Key 或权限无效（HTTP 401/403）。",
            )

        # Some OpenAI-compatible gateways do not expose /models. Fall back to
        # a minimal chat request only when model listing is unavailable.
        r = requests.post(
            f"{base}/chat/completions",
            headers=headers,
            json={
                "model": m,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 8,
            },
            timeout=to,
            verify=verify,
            proxies=proxies,
        )
    except req_exc.ConnectionError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"无法连接：{str(exc)[:200]}",
        ) from exc
    except req_exc.Timeout as exc:
        raise HTTPException(
            status_code=400,
            detail="请求超时，请检查网络与 Base URL。",
        ) from exc
    except req_exc.RequestException as exc:
        raise HTTPException(
            status_code=400,
            detail=f"请求失败：{str(exc)[:200]}",
        ) from exc

    try:
        parsed: Any = r.json()
    except (json.JSONDecodeError, TypeError, ValueError):
        parsed = None
    err_snip = _llm_upstream_error_snippet(parsed) if parsed is not None else ""

    if 200 <= r.status_code < 300:
        if err_snip:
            raise HTTPException(
                status_code=400,
                detail=f"端点已响应（HTTP {r.status_code}），但返回错误：{err_snip}",
            )
        return {"ok": True, "message": "连接成功，兼容端点有响应。"}
    if r.status_code in (401, 403):
        if err_snip:
            raise HTTPException(
                status_code=400,
                detail=f"Key 或权限无效（HTTP {r.status_code}）：{err_snip}",
            )
        raise HTTPException(
            status_code=400,
            detail="Key 或权限无效（HTTP 401/403）。",
        )
    if not err_snip:
        err_snip = (r.text or "")[:200]
    msg = f"端点返回 HTTP {r.status_code}"
    if err_snip.strip():
        msg += f"：{err_snip.strip()}"
    raise HTTPException(status_code=400, detail=msg)


def _load_llm_config_for_translate() -> tuple[str, str, str]:
    raw = load_raw()
    base_url = (raw.get("base_url") or "").strip().rstrip("/")
    model = (raw.get("model") or "").strip()
    api_key = (raw.get("api_key") or "").strip()
    if not base_url or not model or not api_key:
        raise HTTPException(
            status_code=400,
            detail="请先在设置中保存语言模型配置。",
        )
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="已保存的 Base URL 无效，请在设置中检查。",
        )
    return base_url, model, api_key


def _openai_translate_request_json(
    body: TranslateIn,
    model: str,
    *,
    stream: bool,
) -> Dict[str, Any]:
    src = _llm_source_label(body.source_language)
    tgt = (body.target_language or "").strip()
    tgt = _llm_target_label(tgt) if tgt else tgt
    text = (body.text or "").strip()
    previous_source = (body.previous_source_text or "").strip()
    previous_translation = (body.previous_translation_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="没有可翻译的原文。")
    if not tgt:
        raise HTTPException(status_code=400, detail="没有目标语言。")

    tgt_bcp = _bcp47_from_code(body.target_lang_code)
    src_bcp = _bcp47_from_code(body.source_lang_code)
    _parts: List[str] = []
    if src_bcp:
        _parts.append(f"Source BCP-47: {src_bcp}.")
    if tgt_bcp:
        _parts.append(
            f"Target BCP-47: {tgt_bcp}. The entire output must be in that language and script, "
            "including one-word or sentence fragments, not the source."
        )
    locale_block = " ".join(_parts) if _parts else ""
    zh_extra = (
        "For Simplified Chinese, use standard Mainland Simplified characters only; "
        "do not leave body text in English or the source language. "
        if (body.target_lang_code or "").strip() == "zh" or "Simplified Chinese" in tgt
        else ""
    )
    reasoning_like = _is_realtime_reasoning_model(model)
    # 实时翻译的首 token 延迟很敏感，但推理模型会消耗隐藏 token；预算过小会返回 length + 空 content。
    if reasoning_like:
        max_tokens = min(1536, max(256 if stream else 384, int(len(text) * 1.8) + 160))
    elif stream:
        max_tokens = min(2048, max(96, int(len(text) * 1.6) + 64))
    else:
        max_tokens = min(4096, max(256, int(len(text) * 1.6) + 128))
    context_block = ""
    translate_instruction = (
        "Translate the full block below. It may be the latest buffered fragment of live speech; "
        "keep the wording natural, do not over-literalize partial phrases, and fully use the target language."
    )
    if previous_source or previous_translation:
        context_bits: list[str] = []
        if previous_source:
            context_bits.append(f"Previous source context:\n{previous_source[-600:]}")
        if previous_translation:
            context_bits.append(f"Previous target-language translation context:\n{previous_translation[-600:]}")
        context_block = "\n\n".join(context_bits)
        translate_instruction = (
            "Use the previous context only for continuity. Translate ONLY the current source block below; "
            "do not repeat or revise the previous translation. If the current block is a fragment, "
            "make it read naturally as a continuation."
        )
    req: Dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": f"{_load_translation_system_prompt()} {zh_extra}".strip(),
            },
            {
                "role": "user",
                "content": (
                    f"Source: {src}\n"
                    f"Target: {tgt}\n"
                    f"{(locale_block + chr(10)) if locale_block else ''}"
                    f"{(context_block + chr(10) + chr(10)) if context_block else ''}"
                    f"{translate_instruction}\n\n"
                    f"Current source block:\n{text}"
                ),
            },
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if stream and _supports_disabled_thinking_param(model):
        req["thinking"] = {"type": "disabled"}
    return req


def _ndjson_error_line(message: str) -> bytes:
    return (json.dumps({"e": message}, ensure_ascii=False) + "\n").encode("utf-8")


def _openai_content_to_str(content: Any) -> str:
    """将 OpenAI/兼容端的 message 或 delta .content 规范为可拼接的文本；支持 str 或 content parts 列表。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        t = content.get("text")
        if isinstance(t, str) and t:
            return t
        c0 = content.get("content")
        if isinstance(c0, str) and c0:
            return c0
        if c0 is not None:
            return _openai_content_to_str(c0)
        p = content.get("parts")
        if p is not None:
            return _openai_content_to_str(p)
        return ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                it = item.get("type", "")
                if it in ("tool_calls", "tool_call", "refusal", "refusals", "function_call", "file_ref"):
                    continue
                t = item.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)
                c2 = item.get("content")
                if isinstance(c2, str) and c2:
                    parts.append(c2)
                elif c2 is not None:
                    s = _openai_content_to_str(c2)
                    if s:
                        parts.append(s)
        return "".join(parts)
    return ""


def _text_from_stream_chunk_choice(ch: Any) -> str:
    """从流式单帧 choices[] 中取出助手文本；兼容 string / 数组 content、delta.text、末帧 message。"""
    if not isinstance(ch, dict):
        return ""
    delta = ch.get("delta")
    if isinstance(delta, dict):
        s = _openai_content_to_str(delta.get("content"))
        if s:
            return s
        t = delta.get("text")
        if isinstance(t, str) and t:
            return t
        ot = delta.get("output_text")
        if isinstance(ot, str) and ot:
            return ot
    message = ch.get("message")
    if isinstance(message, dict):
        s2 = _openai_content_to_str(message.get("content"))
        if s2:
            return s2
    if isinstance(ch.get("text"), str) and ch["text"]:
        return ch["text"]
    return ""


def _text_from_stream_chunk_candidate(gem: Any) -> str:
    """
    兼容流式里 candidates[]（如部分 Gemini/Vertex 封装）、content.parts 等形态；
    先按 OpenAI choice 解析，再尝试嵌套 content。
    """
    if not isinstance(gem, dict):
        return ""
    t0 = _text_from_stream_chunk_choice(gem)
    if t0:
        return t0
    c = gem.get("content")
    if isinstance(c, str) and c.strip():
        return c
    if isinstance(c, dict):
        t1 = _openai_content_to_str(c.get("parts") or c.get("content") or c)
        if t1:
            return t1
    return ""


def _iter_openai_stream_chunk_pieces(
    j: Any,
) -> tuple[Optional[bytes], list[str]]:
    """
    解析一帧 data 或裸行 JSON。返回 (error_ndjson, text_pieces)：
    error 非空时应终止整个流；否则 pieces 中每项输出为 {\"c\":...}。
    """
    if not isinstance(j, dict):
        return (None, [])
    err_obj = j.get("error", None)
    if err_obj is not None and err_obj is not False and not (j.get("choices") or j.get("candidates") or j.get("output")):
        em = (err_obj or {}).get("message", str(err_obj)) if isinstance(err_obj, dict) else str(err_obj)
        return (_ndjson_error_line(str(em)[:400]), [])

    pieces: list[str] = []
    event_type = j.get("type")
    if isinstance(event_type, str) and event_type in (
        "response.output_text.delta",
        "response.refusal.delta",
        "content_block_delta",
        "message_delta",
    ):
        delta = j.get("delta")
        if isinstance(delta, str) and delta:
            pieces.append(delta)
        elif isinstance(delta, dict):
            delta_text = _openai_content_to_str(
                delta.get("text")
                or delta.get("content")
                or delta.get("output_text")
                or delta,
            )
            if delta_text:
                pieces.append(delta_text)
    for ch in j.get("choices") or []:
        if not isinstance(ch, dict):
            continue
        piece = _text_from_stream_chunk_choice(ch)
        if piece:
            pieces.append(piece)
    for gem in j.get("candidates") or []:
        t = _text_from_stream_chunk_candidate(gem)
        if t:
            pieces.append(t)
    if not pieces:
        out = j.get("output")
        if isinstance(out, dict):
            for ch2 in (out.get("choices") or out.get("candidates") or []):
                if not isinstance(ch2, dict):
                    continue
                p2 = _text_from_stream_chunk_choice(ch2) or _text_from_stream_chunk_candidate(ch2)
                if p2:
                    pieces.append(p2)
            t_out = out.get("text")
            if not pieces and isinstance(t_out, str) and t_out:
                pieces.append(t_out)
    if not pieces:
        # 少数实现/代理在流中直接给顶层 message，不套 choices
        top_msg = j.get("message")
        if isinstance(top_msg, dict):
            t3 = _openai_content_to_str(top_msg.get("content"))
            if t3:
                pieces.append(t3)
        elif isinstance(top_msg, str) and top_msg:
            pieces.append(top_msg)
        t_resp = j.get("response")
        if not pieces and isinstance(t_resp, str) and t_resp:
            pieces.append(t_resp)
    if not pieces:
        top_delta = j.get("delta")
        if isinstance(top_delta, str) and top_delta:
            pieces.append(top_delta)
        elif isinstance(top_delta, dict):
            t_delta = _openai_content_to_str(
                top_delta.get("text")
                or top_delta.get("content")
                or top_delta.get("output_text")
                or top_delta,
            )
            if t_delta:
                pieces.append(t_delta)
    if not pieces:
        for key in ("content", "text", "output_text"):
            val = j.get(key)
            if isinstance(val, str) and val:
                pieces.append(val)
                break
            if isinstance(val, (dict, list)):
                t_val = _openai_content_to_str(val)
                if t_val:
                    pieces.append(t_val)
                    break
    return (None, pieces)


def _iter_ndjson_bytes_from_sse_lines(
    lines: Iterable[str],
    *,
    empty_ok: bool = True,
) -> Iterator[bytes]:
    """将上游 OpenAI 式 SSE 文本行（含裸 JSON 错误行）转为 NDJSON：{\"c\"}… / {\"ok\":true} / {\"e\"}。"""
    out_any = False
    data_prefix = "data: "
    for line_s in lines:
        if not line_s or not line_s.strip():
            continue
        if line_s[0] == "\ufeff":
            line_s = line_s[1:]
        j: Any = None
        if line_s.startswith("data: "):
            data = line_s[len(data_prefix) :].strip()
            if data == "[DONE]":
                break
            try:
                j = json.loads(data)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
        elif line_s.startswith("data:"):
            data = line_s[5:].lstrip()
            if data == "[DONE]":
                break
            try:
                j = json.loads(data)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
        else:
            # 部分网关在流里直接输出与 OpenAI 相同语义的**裸 JSON 行**（无 "data: " 前缀）；
            # 旧实现一律 continue，导致收不到任何 delta，误以为「流未返回内容」。
            ls = line_s.strip()
            if not ls.startswith("{"):
                continue
            try:
                jbare: Any = json.loads(ls)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            j = jbare

        if j is None:
            continue
        err_line, pieces = _iter_openai_stream_chunk_pieces(j)
        if err_line is not None:
            yield err_line
            return
        for piece in pieces:
            out_any = True
            yield (json.dumps({"c": piece}, ensure_ascii=False) + "\n").encode("utf-8")
    if not out_any:
        # 上游偶发只发 role/finish 帧或空流。实时翻译里这不是致命错误：
        # 流式展示路径需要把它暴露为错误，让前端立即走非流式兜底，避免重复空等。
        if empty_ok:
            yield (json.dumps({"ok": True}, ensure_ascii=False) + "\n").encode("utf-8")
        else:
            yield _ndjson_error_line("翻译流未返回内容。")
        return
    yield (json.dumps({"ok": True}, ensure_ascii=False) + "\n").encode("utf-8")


def _llm_requests_post_chat(
    base_url: str,
    headers: dict[str, str],
    json_body: Dict[str, Any],
    *,
    stream: bool,
) -> requests.Response:
    """POST /chat/completions；用 urllib3/requests，对部分网关比 httpx 更稳；连接失败时短暂重试。"""
    verify, proxies = _requests_verify_and_proxies()
    timeout = _requests_timeout_connect_read(stream=stream)
    url = f"{base_url}/chat/completions"
    last_exc: Optional[BaseException] = None
    for attempt in range(3):
        try:
            _pace_llm_request()
            return requests.post(
                url,
                headers=headers,
                json=json_body,
                stream=stream,
                timeout=timeout,
                verify=verify,
                proxies=proxies,
            )
        except (req_exc.ConnectionError, req_exc.Timeout) as exc:
            last_exc = exc
            time.sleep(0.35 * (attempt + 1))
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("unreachable")


def _llm_retry_without_thinking_if_needed(
    response: requests.Response,
    base_url: str,
    headers: dict[str, str],
    json_body: Dict[str, Any],
    *,
    stream: bool,
) -> requests.Response:
    if response.status_code not in (400, 422) or "thinking" not in json_body:
        return response
    body_text = (response.text or "")[:1000]
    if "thinking" not in body_text.lower():
        return response
    try:
        response.close()
    except Exception:
        pass
    retry_body = dict(json_body)
    retry_body.pop("thinking", None)
    return _llm_requests_post_chat(
        base_url,
        headers=headers,
        json_body=retry_body,
        stream=stream,
    )


def _llm_rate_limit_retry_delay(response: requests.Response) -> float:
    raw = (response.headers.get("Retry-After") or "").strip()
    if raw:
        try:
            return min(8.0, max(1.0, float(raw)))
        except ValueError:
            pass
    return _llm_env_float("RT_LLM_RATE_LIMIT_RETRY_DELAY", 2.0)


def _llm_retry_rate_limit_once(
    response: requests.Response,
    base_url: str,
    headers: dict[str, str],
    json_body: Dict[str, Any],
    *,
    stream: bool,
) -> requests.Response:
    if response.status_code != 429:
        return response
    try:
        response.close()
    except Exception:
        pass
    time.sleep(_llm_rate_limit_retry_delay(response))
    return _llm_requests_post_chat(
        base_url,
        headers=headers,
        json_body=json_body,
        stream=stream,
    )


def _sse_lines_from_requests_stream(r: requests.Response) -> Iterator[str]:
    # requests 默认 chunk_size=512，会把很多很小的 SSE delta 缓冲到 512 字节后才交给 iter_lines。
    # 对实时字幕而言这会直接表现为“流式很慢”，这里用 1 字节换最低首包/逐 token 延迟。
    # 部分 OpenAI 兼容网关未声明 charset，requests 会按 ISO-8859-1 解码，中文流会变成乱码。
    for line in r.iter_lines(chunk_size=1, decode_unicode=False):
        if not line:
            continue
        if isinstance(line, bytes):
            line_s = line.decode("utf-8", errors="replace")
        else:
            line_s = str(line)
        if line_s.strip():
            yield line_s


def _sync_translate_stream_producer(body: TranslateIn, out_q: "queue.Queue[Optional[bytes]]") -> None:
    """在线程内用 requests 流式读 SSE（urllib3），规避部分环境下 httpx 超时/空异常。"""
    try:
        base_url, model, api_key = _load_llm_config_for_translate()
        req = _openai_translate_request_json(body, model, stream=True)
    except HTTPException as exc:
        d = exc.detail
        msg = d if isinstance(d, str) else "请求无效"
        out_q.put(_ndjson_error_line(str(msg)[:500]))
        out_q.put(None)
        return
    tlog = (body.text or "").strip()[:200]
    robj: Optional[requests.Response] = None
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "realtime-translate/0.1 (translate-stream)",
        }
        robj = _llm_requests_post_chat(
            base_url,
            headers=headers,
            json_body=req,
            stream=True,
        )
        robj = _llm_retry_without_thinking_if_needed(
            robj,
            base_url,
            headers,
            req,
            stream=True,
        )
        robj = _llm_retry_rate_limit_once(
            robj,
            base_url,
            headers,
            req,
            stream=True,
        )
        if robj.status_code < 200 or robj.status_code >= 300:
            body_text = (robj.text or "")[:800]
            parsed_err: Any = None
            try:
                parsed_err = json.loads(body_text)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
            err_snip = (
                _llm_upstream_error_snippet(parsed_err) if isinstance(parsed_err, dict) else ""
            )
            detail = err_snip or body_text[:200]
            _log_translate_failure(robj.status_code, detail, model, tlog)
            out_q.put(
                _ndjson_error_line(
                    f"翻译端点返回 HTTP {robj.status_code}：{detail}"[:500],
                ),
            )
            out_q.put(None)
            return
        for chunk in _iter_ndjson_bytes_from_sse_lines(
            _sse_lines_from_requests_stream(robj),
            empty_ok=False,
        ):
            out_q.put(chunk)
    except (req_exc.ConnectionError, req_exc.Timeout) as exc:
        out_q.put(_ndjson_error_line(_llm_stream_net_err_message(exc)[:500]))
    except req_exc.RequestException as exc:
        out_q.put(_ndjson_error_line(f"翻译流失败：{str(exc)[:200]}"))
    except Exception as exc:  # noqa: BLE001
        out_q.put(_ndjson_error_line(f"翻译流异常：{str(exc)[:200]}"))
    finally:
        if robj is not None:
            try:
                robj.close()
            except Exception:
                pass
        out_q.put(None)


async def _translate_stream_generator(body: TranslateIn) -> AsyncIterator[bytes]:
    out_q: queue.Queue[Optional[bytes]] = queue.Queue()
    worker = threading.Thread(
        target=_sync_translate_stream_producer,
        args=(body, out_q),
        daemon=True,
        name="translate-stream",
    )
    worker.start()
    try:
        while True:
            item = await asyncio.to_thread(out_q.get)
            if item is None:
                break
            yield item
    finally:
        worker.join(timeout=60.0)


@app.post(f"{_API_PREFIX}/translate/stream")
async def translate_text_stream(body: TranslateIn) -> StreamingResponse:
    return StreamingResponse(
        _translate_stream_generator(body),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sync_translate_accumulate_via_stream(body: TranslateIn) -> str:
    """
    与 /translate/stream 相同：发流式 /chat/completions，经 NDJSON 聚合为整段字符串。
    /api/translate 也仅走本函数，与浏览器侧流式展示共用同一套解析，避免多路径偏差。
    """
    base_url, model, api_key = _load_llm_config_for_translate()
    tlog = (body.text or "").strip()[:200]
    jreq = _openai_translate_request_json(body, model, stream=True)
    r: Optional[requests.Response] = None
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "realtime-translate/0.1 (translate-fallback-stream)",
        }
        r = _llm_requests_post_chat(
            base_url,
            headers=headers,
            json_body=jreq,
            stream=True,
        )
        r = _llm_retry_without_thinking_if_needed(
            r,
            base_url,
            headers,
            jreq,
            stream=True,
        )
        r = _llm_retry_rate_limit_once(
            r,
            base_url,
            headers,
            jreq,
            stream=True,
        )
        if r.status_code < 200 or r.status_code >= 300:
            body_text = (r.text or "")[:800]
            parsed_err: Any = None
            try:
                parsed_err = json.loads(body_text)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
            err_snip = (
                _llm_upstream_error_snippet(parsed_err) if isinstance(parsed_err, dict) else ""
            )
            detail = err_snip or body_text[:200]
            _log_translate_failure(r.status_code, detail, model, tlog)
            return ""
        accum: list[str] = []
        for block in _iter_ndjson_bytes_from_sse_lines(_sse_lines_from_requests_stream(r)):
            for line in block.decode("utf-8").splitlines():
                s = line.strip()
                if not s:
                    continue
                o: Any
                try:
                    o = json.loads(s)
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
                if not isinstance(o, dict):
                    continue
                if o.get("e"):
                    raise HTTPException(
                        status_code=400,
                        detail=str(o.get("e", "翻译流未返回内容。"))[:500],
                    )
                if o.get("ok") is True:
                    break
                c = o.get("c")
                if isinstance(c, str) and c:
                    accum.append(c)
        return "".join(accum).strip()
    except HTTPException:
        raise
    except (req_exc.ConnectionError, req_exc.Timeout) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"流式回退：无法连接或超时 {str(exc)[:200]}",
        ) from exc
    except req_exc.RequestException as exc:
        raise HTTPException(
            status_code=400,
            detail=f"流式回退：请求失败 {str(exc)[:200]}",
        ) from exc
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass


def _sync_translate_post_request(body: TranslateIn) -> TranslateOut:
    """非流式翻译兜底：当上游流式偶发空帧时，保留一条稳定 JSON 路径。"""
    base_url, model, api_key = _load_llm_config_for_translate()
    tlog = (body.text or "").strip()[:200]
    req = _openai_translate_request_json(body, model, stream=False)
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "realtime-translate/0.1 (translate-json)",
        }
        r = _llm_requests_post_chat(
            base_url,
            headers=headers,
            json_body=req,
            stream=False,
        )
        r = _llm_retry_rate_limit_once(
            r,
            base_url,
            headers,
            req,
            stream=False,
        )
    except (req_exc.ConnectionError, req_exc.Timeout) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"无法连接或超时：{str(exc)[:200]}",
        ) from exc
    except req_exc.RequestException as exc:
        raise HTTPException(
            status_code=400,
            detail=f"翻译请求失败：{str(exc)[:200]}",
        ) from exc

    body_text = (r.text or "")[:2000]
    try:
        parsed: Any = r.json()
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="翻译端点返回了非 JSON 响应。") from exc

    err_snip = _llm_upstream_error_snippet(parsed)
    if r.status_code < 200 or r.status_code >= 300 or err_snip:
        detail = err_snip or body_text[:300]
        _log_translate_failure(r.status_code, detail, model, tlog)
        raise HTTPException(
            status_code=400,
            detail=f"翻译端点返回 HTTP {r.status_code}：{detail}"[:500],
        )

    pieces: list[str] = []
    if isinstance(parsed, dict):
        for ch in parsed.get("choices") or []:
            t = _text_from_stream_chunk_choice(ch)
            if t:
                pieces.append(t)
        if not pieces:
            output = parsed.get("output")
            if isinstance(output, list):
                for item in output:
                    t = _openai_content_to_str(item)
                    if t:
                        pieces.append(t)
            elif isinstance(output, (dict, str)):
                t = _openai_content_to_str(output)
                if t:
                    pieces.append(t)
        if not pieces:
            for key in ("translation", "content", "text", "output_text", "response"):
                val = parsed.get(key)
                if isinstance(val, str) and val:
                    pieces.append(val)
                    break
                if isinstance(val, (dict, list)):
                    t = _openai_content_to_str(val)
                    if t:
                        pieces.append(t)
                        break

    translation = "".join(pieces).strip()
    if translation:
        return TranslateOut(ok=True, translation=translation)
    stream_translation = _sync_translate_accumulate_via_stream(body)
    if stream_translation:
        return TranslateOut(ok=True, translation=stream_translation)
    raise HTTPException(status_code=400, detail="翻译端点未返回译文。")


@app.post(f"{_API_PREFIX}/translate", response_model=TranslateOut)
async def translate_text(body: TranslateIn) -> TranslateOut:
    return await asyncio.to_thread(_sync_translate_post_request, body)


@app.websocket(f"{_API_PREFIX}/asr/ws")
async def asr_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    if not is_asr_importable():
        import_error = get_asr_import_error()
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "message": "asr_unavailable",
                    "detail": import_error,
                }
            )
        except Exception:
            pass
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
        return
    language: Optional[str] = "en"
    try:
        first = await websocket.receive()
    except WebSocketDisconnect:
        return
    if first.get("type") != "websocket.receive":
        return
    text0 = first.get("text")
    if not isinstance(text0, str):
        await websocket.close(code=1003, reason="first message must be JSON config string")
        return
    try:
        cfg = json.loads(text0)
    except json.JSONDecodeError:
        await websocket.close(code=1003, reason="invalid JSON config")
        return
    if cfg.get("type") != "config":
        await websocket.close(code=1003, reason="expected type config")
        return
    raw_lang = cfg.get("language")
    if isinstance(raw_lang, str) and raw_lang:
        language = None if raw_lang == "auto" else raw_lang

    loop = asyncio.get_running_loop()
    sid = uuid.uuid4().hex[:16]
    segment_id = 1
    segment_pcm = bytearray()
    last_voice_at = time.monotonic()
    last_partial_at = 0.0
    last_emitted_by_segment: dict[int, str] = {}
    segment_started_at = time.monotonic()
    session_started_at = segment_started_at
    asr_task: Optional[asyncio.Task[tuple[int, bool, str, int, int, float]]] = None
    await websocket.send_json(
        {
            "type": "started",
            "action": "started",
            "sid": sid,
            "engine": get_asr_engine(),
            "model": get_asr_model_name(),
            "sample_rate": _ASR_SAMPLE_RATE,
            "frame_ms": 40,
        }
    )

    def _schedule_asr_job(*, final: bool, now: float) -> bool:
        nonlocal asr_task, last_partial_at
        if asr_task is not None and not asr_task.done():
            return False
        pcm = bytes(segment_pcm)
        sid0 = segment_id
        bg_ms = int((segment_started_at - session_started_at) * 1000)
        ed_ms = int((now - session_started_at) * 1000)

        async def _run_snapshot() -> tuple[int, bool, str, int, int, float]:
            started = time.monotonic()

            def _run() -> str:
                return transcribe_int16_16k_mono(
                    pcm,
                    language=language,
                )

            text = await loop.run_in_executor(None, _run)
            return (sid0, final, text, bg_ms, ed_ms, time.monotonic() - started)

        asr_task = asyncio.create_task(_run_snapshot())
        last_partial_at = now
        return True

    async def _flush_asr_job() -> None:
        nonlocal asr_task
        if asr_task is None or not asr_task.done():
            return
        task = asr_task
        asr_task = None
        try:
            sid0, final0, text, bg_ms, ed_ms, cost_sec = task.result()
        except Exception as exc:  # noqa: BLE001
            await websocket.send_json(
                {
                    "type": "error",
                    "message": "asr failed",
                    "detail": str(exc)[:200],
                }
            )
            return
        t = (text or "").strip()
        previous = last_emitted_by_segment.get(sid0, "")
        if not t or not (_asr_text_changed(previous, t) or final0):
            return
        last_emitted_by_segment[sid0] = t
        await websocket.send_json(
            {
                "type": "final_transcript" if final0 else "partial_transcript",
                "action": "result",
                "text": t,
                "segment_id": sid0,
                "final": final0,
                "result_type": 0 if final0 else 1,
                "bg_ms": bg_ms,
                "ed_ms": ed_ms,
                "asr_cost_ms": int(cost_sec * 1000),
            }
        )

    try:
        while True:
            await _flush_asr_job()
            try:
                msg = await asyncio.wait_for(websocket.receive(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            if msg.get("type") == "websocket.disconnect":
                break
            text_msg = msg.get("text")
            if isinstance(text_msg, str):
                try:
                    ctrl = json.loads(text_msg)
                except json.JSONDecodeError:
                    continue
                if ctrl.get("end") is True or ctrl.get("type") == "end":
                    if segment_pcm:
                        if asr_task is not None and not asr_task.done():
                            try:
                                await asyncio.wait_for(asr_task, timeout=30.0)
                            except asyncio.TimeoutError:
                                await websocket.send_json(
                                    {
                                        "type": "error",
                                        "message": "asr failed",
                                        "detail": "ASR timed out before final flush",
                                    }
                                )
                            await _flush_asr_job()
                        _schedule_asr_job(final=True, now=time.monotonic())
                        if asr_task is not None:
                            try:
                                await asyncio.wait_for(asr_task, timeout=30.0)
                            except asyncio.TimeoutError:
                                await websocket.send_json(
                                    {
                                        "type": "error",
                                        "message": "asr failed",
                                        "detail": "final ASR timed out",
                                    }
                                )
                            await _flush_asr_job()
                    break
                continue
            b = msg.get("bytes")
            if not b:
                continue
            if not isinstance(b, (bytes, bytearray, memoryview)):
                continue
            now = time.monotonic()
            frame = bytes(b)
            segment_pcm.extend(frame)
            if _pcm16_rms(frame) >= _ASR_RMS_SPEECH_THRESHOLD:
                last_voice_at = now

            duration = _pcm16_duration_sec(segment_pcm)
            if duration < _ASR_MIN_TRANSCRIBE_SEC:
                continue

            is_endpoint = now - last_voice_at >= _ASR_ENDPOINT_SILENCE_SEC
            is_too_long = duration >= _ASR_MAX_SEGMENT_SEC
            should_partial = now - last_partial_at >= _ASR_PARTIAL_INTERVAL_SEC
            if not (is_endpoint or is_too_long or should_partial):
                continue
            final = bool(is_endpoint or is_too_long)
            if not _schedule_asr_job(final=final, now=now):
                continue
            if final:
                segment_id += 1
                segment_pcm = bytearray()
                segment_started_at = time.monotonic()
                last_voice_at = segment_started_at
                last_partial_at = 0.0
    except WebSocketDisconnect:
        pass
