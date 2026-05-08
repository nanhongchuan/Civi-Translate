"""Online ASR adapter for OpenAI-style HTTP transcription APIs."""

from __future__ import annotations

import io
import json
import wave
from typing import Any, Optional

import requests
from requests import exceptions as req_exc

from app import asr_online_settings

_DEFAULT_VENDOR = "openai-audio-compatible"


class OnlineAsrError(RuntimeError):
    """User-facing online ASR failure."""


def get_online_asr_model_name() -> str:
    raw = asr_online_settings.load_raw()
    return (raw.get("model") or "").strip() or "未配置"


def get_online_asr_config_error() -> str:
    raw = asr_online_settings.load_raw()
    base_url = (raw.get("base_url") or "").strip()
    model = (raw.get("model") or "").strip()
    api_key = (raw.get("api_key") or "").strip()
    if not base_url or not model or not api_key:
        return "请先在设置中保存在线转写 API 配置。"
    if not base_url.startswith(("http://", "https://")):
        return "已保存的在线转写 Base URL 无效。"
    return ""


def load_online_asr_config() -> tuple[str, str, str, str, str]:
    raw = asr_online_settings.load_raw()
    vendor = (raw.get("vendor") or _DEFAULT_VENDOR).strip() or _DEFAULT_VENDOR
    base_url = (raw.get("base_url") or "").strip().rstrip("/")
    model = (raw.get("model") or "").strip()
    api_key = (raw.get("api_key") or "").strip()
    language_hint = (raw.get("language_hint") or "").strip()
    err = get_online_asr_config_error()
    if err:
        raise OnlineAsrError(err)
    return vendor, base_url, model, api_key, language_hint


def wav_bytes_from_pcm16_16k_mono(pcm_int16: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm_int16)
    return out.getvalue()


def _parse_transcription_text(parsed: Any) -> str:
    if isinstance(parsed, dict):
        for key in ("text", "transcript", "translation", "content", "result"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        data = parsed.get("data")
        if isinstance(data, dict):
            t = _parse_transcription_text(data)
            if t:
                return t
        if isinstance(data, list):
            parts: list[str] = []
            for item in data:
                t = _parse_transcription_text(item)
                if t:
                    parts.append(t)
            return " ".join(parts).strip()
        segments = parsed.get("segments")
        if isinstance(segments, list):
            parts = []
            for item in segments:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"].strip())
            return " ".join(p for p in parts if p).strip()
    if isinstance(parsed, str):
        return parsed.strip()
    return ""


def _upstream_error_snippet(parsed: Any) -> str:
    if not isinstance(parsed, dict) or "error" not in parsed:
        return ""
    err = parsed["error"]
    if isinstance(err, dict):
        return str(err.get("message", err.get("code", err)))[:300]
    return str(err)[:300]


def _request_timeout() -> tuple[float, float]:
    return (30.0, 180.0)


def transcribe_online_int16_16k_mono(
    pcm_int16: bytes,
    language: Optional[str] = None,
) -> str:
    if not pcm_int16:
        return ""
    _vendor, base_url, model, api_key, language_hint = load_online_asr_config()
    wav = wav_bytes_from_pcm16_16k_mono(pcm_int16)
    data = {"model": model}
    final_language = language if language and language not in ("", "auto") else language_hint
    if final_language and final_language not in ("", "auto"):
        data["language"] = final_language
    files = {
        "file": ("audio.wav", wav, "audio/wav"),
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "realtime-translate/0.1 (online-asr)",
    }
    try:
        r = requests.post(
            f"{base_url}/audio/transcriptions",
            headers=headers,
            data=data,
            files=files,
            timeout=_request_timeout(),
        )
    except req_exc.Timeout as exc:
        raise OnlineAsrError("在线转写请求超时，请检查网络或更换 ASR API。") from exc
    except req_exc.RequestException as exc:
        raise OnlineAsrError(f"在线转写请求失败：{str(exc)[:200]}") from exc

    body_text = (r.text or "")[:2000]
    try:
        parsed: Any = r.json()
    except (json.JSONDecodeError, TypeError, ValueError):
        parsed = None

    err = _upstream_error_snippet(parsed)
    if r.status_code < 200 or r.status_code >= 300 or err:
        detail = err or body_text[:300] or "无响应内容"
        raise OnlineAsrError(f"在线转写端点返回 HTTP {r.status_code}：{detail}"[:500])

    text = _parse_transcription_text(parsed)
    if text:
        return text
    return ""
