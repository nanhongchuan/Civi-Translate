"""Local ASR adapters. Models load lazily on first use."""

from __future__ import annotations

import os
import tempfile
import threading
import wave
from typing import Any, Iterable, Iterator, Optional

import numpy as np

# ASR engines are optional for import-time health; actual load is lazy.
_LAZY_MODEL: Any = None
_LAZY_ENGINE: str = ""
_LAZY_LOCK = threading.Lock()
_DEFAULT_DEVICE = "cpu"
_DEFAULT_COMPUTE = "int8"
_DEFAULT_WHISPER_MODEL = "base"
_DEFAULT_PARAKEET_MODEL = "nvidia/parakeet-tdt-0.6b-v2"
_DEFAULT_ONLINE_MODEL = "未配置"


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def _vad_filter_enabled() -> bool:
    v = os.getenv("RT_ASR_VAD_FILTER", "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def get_asr_engine() -> str:
    raw = os.getenv("RT_ASR_ENGINE", "faster_whisper").strip().lower()
    aliases = {
        "faster-whisper": "faster_whisper",
        "whisper": "faster_whisper",
        "nemo": "parakeet",
        "nvidia-parakeet": "parakeet",
        "online": "online_api",
        "online-api": "online_api",
        "online_asr": "online_api",
    }
    return aliases.get(raw, raw) or "faster_whisper"


def get_asr_model_name() -> str:
    engine = get_asr_engine()
    if engine == "online_api":
        try:
            from app.online_asr_service import get_online_asr_model_name

            return get_online_asr_model_name()
        except Exception:
            return _DEFAULT_ONLINE_MODEL
    default = _DEFAULT_PARAKEET_MODEL if engine == "parakeet" else _DEFAULT_WHISPER_MODEL
    return os.getenv("RT_ASR_MODEL", default).strip() or default


def get_asr_import_error() -> str:
    engine = get_asr_engine()
    try:
        if engine == "online_api":
            from app.online_asr_service import get_online_asr_config_error

            return get_online_asr_config_error()
        if engine == "parakeet":
            import nemo.collections.asr as nemo_asr  # noqa: F401
        elif engine == "faster_whisper":
            import faster_whisper  # noqa: F401
        else:
            return f"unsupported RT_ASR_ENGINE={engine!r}"
    except ImportError as exc:
        if engine == "parakeet":
            return (
                "NVIDIA NeMo 未安装。请在 backend 目录执行 "
                "python3 -m pip install -r requirements-parakeet.txt 后重试。"
            )
        return f"faster-whisper 未安装：{exc}"
    return ""


def is_asr_importable() -> bool:
    return not get_asr_import_error()


def _get_whisper_model() -> Any:
    from faster_whisper import WhisperModel

    name = get_asr_model_name()
    device = os.getenv("RT_ASR_DEVICE", _DEFAULT_DEVICE).strip() or _DEFAULT_DEVICE
    compute = os.getenv("RT_ASR_COMPUTE", _DEFAULT_COMPUTE).strip() or _DEFAULT_COMPUTE
    return WhisperModel(name, device=device, compute_type=compute)


def _get_parakeet_model() -> Any:
    import nemo.collections.asr as nemo_asr

    name = get_asr_model_name()
    model = nemo_asr.models.ASRModel.from_pretrained(model_name=name)
    device = os.getenv("RT_ASR_DEVICE", "").strip()
    if device:
        model = model.to(device)
    model.eval()
    return model


def _get_model() -> Any:
    global _LAZY_ENGINE, _LAZY_MODEL
    engine = get_asr_engine()
    with _LAZY_LOCK:
        if _LAZY_MODEL is not None and _LAZY_ENGINE == engine:
            return _LAZY_MODEL
        if engine == "parakeet":
            _LAZY_MODEL = _get_parakeet_model()
        elif engine == "faster_whisper":
            _LAZY_MODEL = _get_whisper_model()
        else:
            raise RuntimeError(f"不支持的 ASR 引擎：{engine}")
        _LAZY_ENGINE = engine
        return _LAZY_MODEL


def reset_asr_model_cache() -> None:
    global _LAZY_ENGINE, _LAZY_MODEL
    with _LAZY_LOCK:
        _LAZY_MODEL = None
        _LAZY_ENGINE = ""


def transcribe_int16_16k_mono(
    pcm_int16: bytes,
    language: Optional[str] = None,
) -> str:
    """
    pcm_int16: little-endian int16 mono PCM, 16 kHz.
    language: BCP-47-ish (en, zh, ...); None or 'auto' = auto-detect.
    """
    if not pcm_int16:
        return ""
    if len(pcm_int16) < 3200:  # ~0.1 s: too short, skip
        return ""
    engine = get_asr_engine()
    if engine == "parakeet":
        return _transcribe_parakeet(pcm_int16)
    if engine == "online_api":
        from app.online_asr_service import transcribe_online_int16_16k_mono

        return transcribe_online_int16_16k_mono(pcm_int16, language=language)
    return _transcribe_faster_whisper(pcm_int16, language=language)


def _transcribe_faster_whisper(
    pcm_int16: bytes,
    language: Optional[str] = None,
) -> str:
    audio = np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32) / 32768.0
    model = _get_model()
    lang: Optional[str] = None
    if language and language not in ("auto", ""):
        lang = language

    use_vad = _vad_filter_enabled()
    # 离麦较远时 VAD/静音判定过严会整段丢弃；略放宽阈值并允许环境变量覆盖。
    vad_parameters: Optional[dict[str, Any]] = None
    if use_vad:
        vad_parameters = {
            "threshold": _env_float("RT_ASR_VAD_THRESHOLD", 0.25),
            "min_speech_duration_ms": _env_int("RT_ASR_MIN_SPEECH_MS", 80),
            "speech_pad_ms": _env_int("RT_ASR_SPEECH_PAD_MS", 520),
        }
    no_speech_threshold = _env_float("RT_ASR_NO_SPEECH_THRESHOLD", 0.65)

    segments, _ = model.transcribe(
        audio,
        language=lang,
        beam_size=1,
        vad_filter=use_vad,
        vad_parameters=vad_parameters,
        without_timestamps=True,
        no_speech_threshold=no_speech_threshold,
    )
    return _join_segments(segments)


def _transcribe_parakeet(pcm_int16: bytes) -> str:
    model = _get_model()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
        with wave.open(f.name, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm_int16)
        try:
            results = model.transcribe([f.name], batch_size=1)
        except TypeError:
            results = model.transcribe(paths2audio_files=[f.name], batch_size=1)
    return _join_text_results(results)


def _join_segments(segments: Iterator[Any]) -> str:
    parts: list[str] = []
    for seg in segments:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def _join_text_results(results: Iterable[Any]) -> str:
    parts: list[str] = []
    for item in results:
        raw = getattr(item, "text", item)
        if isinstance(raw, dict):
            raw = raw.get("text", "")
        if isinstance(raw, (list, tuple)) and raw:
            raw = getattr(raw[0], "text", raw[0])
        t = str(raw or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()
