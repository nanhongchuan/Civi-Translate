import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_LOCAL_API_ORIGIN, trimApiBase } from "../apiBase";

const TARGET_SR = 16000;
/** 参考实时转写类 API：16k/16bit/mono 约 40ms 一帧（640 samples / 1280 bytes）。 */
const CHUNK_SAMPLES = 640;
const LOWER = -0x8000;
const UPPER = 0x7fff;
/** 略提输入电平，便于离麦稍远时仍达到可用 SNR（硬限幅在 floatToI16）。 */
const MIC_DIGITAL_GAIN = 1.55;

type AsrMessage =
  | { type: "started"; action?: "started"; sid?: string; engine?: AsrMode; model?: string }
  | {
    type: "partial_transcript" | "final_transcript" | "transcript";
    text: string;
    segment_id?: number;
    final?: boolean;
    bg_ms?: number;
    ed_ms?: number;
  }
  | { type: "error"; message: string; detail?: string };

const LOCAL_ASR_SETUP_MESSAGE =
  "本机转写未连接。请在项目根执行「npm run dev:all」同时起 API 与前端，或开两个终端分别跑「npm run api」和「npm run dev」；backend 需已装依赖（cd backend && python3 -m pip install -r requirements.txt）。若 18787 被占用，结束该进程后重试；可设置 VITE_API_BASE 指向你的 API 地址。无需外网。启动后点底栏「重试麦克风」。";

function httpBaseToAsrWsUrl(httpBase: string): string {
  const withScheme = httpBase.includes("://") ? httpBase : `http://${httpBase}`;
  const u = new URL(withScheme);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api/asr/ws";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * 本机 faster-whisper WebSocket 地址（不依赖 /api/health）。
 * - 页面在 `localhost` / `127.0.0.1` 上时**先走同源** `/api/...`（Vite 代理到 18787），避免内嵌预览/部分环境直连跨端口 `127.0.0.1:18787` 失败；再回退直连。
 * - 其它 host（如 LAN IP）时先直连，便于显式用 `VITE_API_BASE` 指到本机服务。
 */
function getLocalAsrWebSocketCandidates(): string[] {
  const envBase = trimApiBase(import.meta.env.VITE_API_BASE);
  if (envBase) {
    return [httpBaseToAsrWsUrl(envBase)];
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sameOrigin = `${proto}//${location.host}/api/asr/ws`;
  const direct = httpBaseToAsrWsUrl(DEFAULT_LOCAL_API_ORIGIN);
  const isLocalPage = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (isLocalPage) {
    return [sameOrigin, direct];
  }
  return [direct, sameOrigin];
}

async function connectAsrWebSocketFirstAvailable(
  candidates: string[],
  timeoutMs: number,
  cancelled: { current: boolean },
): Promise<WebSocket> {
  let last: Error = new Error("无可用本机转写端点");
  for (const url of candidates) {
    if (cancelled.current) {
      throw new Error("cancelled");
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((res, rej) => {
        const t = window.setTimeout(
          () => rej(new Error("WebSocket 连接超时")),
          timeoutMs,
        );
        const done = (fn: () => void) => {
          clearTimeout(t);
          fn();
        };
        ws.addEventListener("open", () => done(() => res()), { once: true });
        ws.addEventListener("error", () => done(() => rej(new Error("无法连接本机转写服务"))), {
          once: true,
        });
      });
      if (ws.readyState === WebSocket.OPEN) {
        return ws;
      }
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

export type AsrMode = "faster_whisper" | "parakeet" | "online_api" | "browser" | "none";

export type TranscriptSegment = {
  id: number;
  text: string;
  bgMs?: number;
  edMs?: number;
};

function floatToI16(f: number): number {
  const s = Math.max(-1, Math.min(1, f * MIC_DIGITAL_GAIN));
  if (s < 0) {
    return Math.max(LOWER, Math.min(0, Math.round(s * 0x8000)));
  }
  return Math.min(UPPER, Math.max(0, Math.round(s * 0x7fff)));
}

function downsampleTo16k(input: Float32Array, inSampleRate: number): Int16Array {
  if (inSampleRate === TARGET_SR) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = floatToI16(input[i] ?? 0);
    }
    return out;
  }
  const ratio = inSampleRate / TARGET_SR;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let k = 0; k < outLen; k += 1) {
    const src = Math.min(input.length - 1, Math.floor(k * ratio));
    out[k] = floatToI16(input[src] ?? 0);
  }
  return out;
}

type Options = {
  enabled: boolean;
  language: string;
  restartKey?: number;
};

type AsrStatus = "idle" | "connecting" | "listening" | "error";

/** Web Speech API BCP-47 与 UI 语言对应 */
function speechRecognitionLang(sourceLang: string): string {
  const map: Record<string, string> = {
    auto: typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : "zh-CN",
    en: "en-US",
    zh: "zh-CN",
    ja: "ja-JP",
    ko: "ko-KR",
  };
  return map[sourceLang] ?? "zh-CN";
}

type RecLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: (() => void) | null;
};

function getSpeechCtor(): (new () => RecLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as Window &
    { SpeechRecognition?: new () => RecLike; webkitSpeechRecognition?: new () => RecLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ENABLE_BROWSER_STT = import.meta.env.VITE_ENABLE_BROWSER_STT === "true";

/**
 * 仅使用本机 faster-whisper（WebSocket，无需外网）。不依赖 /api/health 闸门，直接尝试连接与 `npm run api` 一致的端口。
 * 仅当环境变量 VITE_ENABLE_BROWSER_STT=true 时，本机不可用时才回退到需联网的浏览器识别。
 */
function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "麦克风权限未生效。请确认本页浏览器权限为允许；若 macOS 已允许当前应用，请重启当前应用后再试，或用 Chrome / Safari 打开 http://127.0.0.1:5173。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到可用麦克风。请连接或启用输入设备后重试。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风正被系统或其他应用占用。请关闭占用麦克风的应用后重试。";
  }
  if (name === "SecurityError") {
    return "当前页面环境不允许访问麦克风。请使用 http://127.0.0.1 或 localhost 打开本地页面。";
  }
  if (name === "OverconstrainedError") {
    return "当前麦克风不满足输入要求。请切换系统输入设备后重试。";
  }
  return `无法访问麦克风${message ? `：${message}` : "。请检查浏览器与系统麦克风权限后重试。"}`;
}

export function useLiveAsr({ enabled, language, restartKey = 0 }: Options): {
  status: AsrStatus;
  errorMessage: string | null;
  transcript: string;
  finalSegments: TranscriptSegment[];
  latestFinalSegment: TranscriptSegment | null;
  asrMode: AsrMode;
  clearTranscript: () => void;
} {
  const [status, setStatus] = useState<AsrStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [finalSegments, setFinalSegments] = useState<TranscriptSegment[]>([]);
  const [latestFinalSegment, setLatestFinalSegment] = useState<TranscriptSegment | null>(null);
  const [asrMode, setAsrMode] = useState<AsrMode>("none");

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const pendingRef = useRef<Int16Array[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<RecLike | null>(null);
  /** 浏览器 STT：句末确定结果累加，避免识别会话重启后只保留最后一句。 */
  const browserFinalsRef = useRef("");
  const asrCommittedSegmentsRef = useRef<string[]>([]);
  const asrActiveSegmentRef = useRef<{ id: number; text: string } | null>(null);
  const browserSegmentSeqRef = useRef(-1);
  /** 与 React 中 transcript 同步，便于恢复浏览器识别时接在已有内容后。 */
  const transcriptRef = useRef("");
  transcriptRef.current = transcript;

  const clearTranscript = useCallback(() => {
    setTranscript("");
    setFinalSegments([]);
    setLatestFinalSegment(null);
    browserFinalsRef.current = "";
    asrCommittedSegmentsRef.current = [];
    asrActiveSegmentRef.current = null;
    browserSegmentSeqRef.current = -1;
  }, []);

  const clearChain = useCallback(() => {
    if (recRef.current) {
      try {
        recRef.current.onresult = null;
        recRef.current.onerror = null;
        recRef.current.onend = null;
        recRef.current.abort();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    }
    if (nodeRef.current) {
      try {
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      nodeRef.current = null;
    }
    if (gainRef.current) {
      try {
        gainRef.current.disconnect();
      } catch {
        /* ignore */
      }
      gainRef.current = null;
    }
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ end: true }));
        }
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
    pendingRef.current = [];
  }, []);

  const startBrowserRecognition = useCallback(
    (cancelled: { current: boolean }) => {
      const Ctor = getSpeechCtor();
      if (!Ctor) {
        if (!cancelled.current) {
          setStatus("error");
          setErrorMessage(
            "本机转写未就绪，且当前浏览器不支持网页语音识别。请安装 backend 的 faster-whisper 后运行 npm run api，或换用 Chrome / Edge。",
          );
        }
        return;
      }

      setAsrMode("browser");
      setErrorMessage(null);
      // 同一会话中暂停再继续：从当前已展示的正文接龙，不从空串重来。
      browserFinalsRef.current = (transcriptRef.current || "").trim();
      if (browserFinalsRef.current) {
        browserFinalsRef.current = `${browserFinalsRef.current} `;
      }

      const rec = new Ctor();
      recRef.current = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = speechRecognitionLang(language);

      rec.onresult = (ev: Event) => {
        const e = ev as unknown as {
          resultIndex: number;
          results: {
            length: number;
            [i: number]: { 0: { transcript: string }; isFinal: boolean };
          };
        };
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r != null && r[0] != null && r.isFinal) {
            const finalText = (r[0].transcript || "").trim();
            if (!finalText) continue;
            browserFinalsRef.current = browserFinalsRef.current.trim()
              ? `${browserFinalsRef.current.trim()} ${finalText}`
              : finalText;
            const seg: TranscriptSegment = {
              id: browserSegmentSeqRef.current,
              text: finalText,
            };
            browserSegmentSeqRef.current -= 1;
            setFinalSegments((prev) => [...prev, seg]);
            setLatestFinalSegment(seg);
          }
        }
        let interim = "";
        for (let i = 0; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r != null && r[0] != null && !r.isFinal) {
            interim += r[0].transcript;
          }
        }
        const base = browserFinalsRef.current.trim();
        const next = interim
          ? (base ? `${base} ${interim.trim()}` : interim.trim())
          : base;
        setTranscript(next);
      };

      rec.onerror = (ev: Event) => {
        const err = (ev as unknown as { error?: string }).error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          setErrorMessage("未获得麦克风/语音识别权限，请允许后重试。");
          setStatus("error");
        } else if (err === "network") {
          setErrorMessage(
            "浏览器语音识别需连接云端。若需离线使用，请关闭 VITE_ENABLE_BROWSER_STT 并仅使用本机「npm run api」转写。",
          );
        } else if (err !== "aborted" && err !== "no-speech") {
          setErrorMessage(`语音识别错误：${err ?? "unknown"}`);
        }
      };

      rec.onend = () => {
        if (cancelled.current) return;
        if (recRef.current !== rec) return;
        try {
          rec.start();
        } catch {
          /* 可能已 unmount 或已 stop */
        }
      };

      try {
        rec.start();
        setStatus("listening");
      } catch {
        if (!cancelled.current) {
          setStatus("error");
          setErrorMessage("无法启动浏览器语音识别。");
        }
      }
    },
    [language],
  );

  /** 仅切换源语言时清空；暂停同传/继续同传不清空。 */
  const previousLanguageRef = useRef(language);
  useEffect(() => {
    if (previousLanguageRef.current !== language) {
      previousLanguageRef.current = language;
      setTranscript("");
      setFinalSegments([]);
      setLatestFinalSegment(null);
      browserFinalsRef.current = "";
      asrCommittedSegmentsRef.current = [];
      asrActiveSegmentRef.current = null;
      browserSegmentSeqRef.current = -1;
    }
  }, [language]);

  useEffect(() => {
    if (!enabled) {
      clearChain();
      setStatus("idle");
      setAsrMode("none");
      return undefined;
    }

    setAsrMode("none");
    const cancelled = { current: false };

    void (async () => {
      setStatus("connecting");
      setErrorMessage(null);

      const wsUrlCandidates = getLocalAsrWebSocketCandidates();

      let ws: WebSocket;
      try {
        ws = await connectAsrWebSocketFirstAvailable(wsUrlCandidates, 10000, cancelled);
      } catch (e) {
        if (cancelled.current) return;
        if (e instanceof Error && e.message === "cancelled") return;
        wsRef.current = null;
        setAsrMode("none");
        if (ENABLE_BROWSER_STT) {
          startBrowserRecognition(cancelled);
        } else {
          setStatus("error");
          setErrorMessage(LOCAL_ASR_SETUP_MESSAGE);
        }
        return;
      }

      wsRef.current = ws;
      setAsrMode("faster_whisper");

      if (cancelled.current) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }

      const cfg = { type: "config" as const, language };
      ws.send(JSON.stringify(cfg));
      ws.send(JSON.stringify({ type: "audio_status", status: 0 }));

      ws.onmessage = (ev) => {
        try {
          const data: AsrMessage = JSON.parse(String(ev.data)) as AsrMessage;
          if (data.type === "started") {
            if (
              data.engine === "parakeet"
              || data.engine === "faster_whisper"
              || data.engine === "online_api"
            ) {
              setAsrMode(data.engine);
            }
            return;
          }
          if (
            (data.type === "partial_transcript"
              || data.type === "final_transcript"
              || data.type === "transcript")
            && data.text
          ) {
            const t = data.text.trim();
            if (!t) return;
            const isFinal = data.type === "final_transcript" || data.final === true;
            if (typeof data.segment_id === "number") {
              if (isFinal) {
                const current = asrActiveSegmentRef.current;
                if (!current || current.id !== data.segment_id || current.text !== t) {
                  asrActiveSegmentRef.current = { id: data.segment_id, text: t };
                }
                asrCommittedSegmentsRef.current.push(t);
                asrActiveSegmentRef.current = null;
                const seg: TranscriptSegment = {
                  id: data.segment_id,
                  text: t,
                  bgMs: data.bg_ms,
                  edMs: data.ed_ms,
                };
                setFinalSegments((prev) => {
                  if (prev.some((item) => item.id === seg.id)) {
                    return prev;
                  }
                  return [...prev, seg];
                });
                setLatestFinalSegment(seg);
              } else {
                asrActiveSegmentRef.current = { id: data.segment_id, text: t };
              }
              const parts = [...asrCommittedSegmentsRef.current];
              if (asrActiveSegmentRef.current?.text) {
                parts.push(asrActiveSegmentRef.current.text);
              }
              setTranscript(parts.join(" ").trim());
              return;
            }
            setTranscript((prev) => {
              if (!prev) return t;
              const tail = prev.slice(-Math.min(40, prev.length));
              if (tail.includes(t) || prev.includes(t)) return prev;
              return `${prev} ${t}`;
            });
          } else if (data.type === "error") {
            setErrorMessage(data.detail || data.message);
          }
        } catch {
          /* ignore */
        }
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (error) {
        if (cancelled.current) return;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
        setAsrMode("none");
        if (ENABLE_BROWSER_STT) {
          startBrowserRecognition(cancelled);
        } else {
          setStatus("error");
          setErrorMessage(microphoneErrorMessage(error));
        }
        return;
      }

      if (cancelled.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }

      streamRef.current = stream;
      const ac = new AudioContext();
      ctxRef.current = ac;
      if (ac.state === "suspended") {
        await ac.resume();
      }
      const source = ac.createMediaStreamSource(stream);
      const bufSize = 4096;
      const node = ac.createScriptProcessor(bufSize, 1, 1);
      nodeRef.current = node;
      const gain = ac.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      node.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const chunk = downsampleTo16k(input, ac.sampleRate);
        if (chunk.length > 0) {
          pendingRef.current.push(chunk);
        }
        while (true) {
          const { piece, newQueue } = takeChunk(
            pendingRef.current,
            CHUNK_SAMPLES,
          );
          pendingRef.current = newQueue;
          if (piece.length < CHUNK_SAMPLES) break;
          const buf = piece.buffer.slice(
            piece.byteOffset,
            piece.byteOffset + piece.byteLength,
          ) as ArrayBuffer;
          if (buf.byteLength > 0) {
            try {
              ws.send(buf);
            } catch {
              /* ignore */
            }
          }
        }
      };

      source.connect(node);
      node.connect(gain);
      gain.connect(ac.destination);

      setStatus("listening");
    })().catch(() => {
      if (cancelled.current) return;
      if (ENABLE_BROWSER_STT) {
        startBrowserRecognition(cancelled);
      } else {
        setStatus("error");
        setErrorMessage(LOCAL_ASR_SETUP_MESSAGE);
      }
    });

    return () => {
      cancelled.current = true;
      clearChain();
    };
  }, [enabled, language, restartKey, clearChain, startBrowserRecognition]);

  return {
    status,
    errorMessage,
    transcript,
    finalSegments,
    latestFinalSegment,
    asrMode,
    clearTranscript,
  };
}

function takeChunk(
  queue: Int16Array[],
  n: number,
): { piece: Int16Array; newQueue: Int16Array[] } {
  const total = queue.reduce((a, c) => a + c.length, 0);
  if (total < n) {
    return { piece: new Int16Array(0), newQueue: queue };
  }
  const out = new Int16Array(n);
  let w = 0;
  let i = 0;
  while (w < n) {
    const p = queue[i]!;
    const need = n - w;
    if (p.length <= need) {
      out.set(p, w);
      w += p.length;
      i += 1;
    } else {
      out.set(p.subarray(0, need), w);
      w = n;
      const newQ = [p.subarray(need), ...queue.slice(i + 1)];
      return { piece: out, newQueue: newQ };
    }
  }
  return { piece: out, newQueue: queue.slice(i) };
}
