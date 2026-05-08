import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Star } from "lucide-react";
import { apiUrl } from "../apiBase";
import { TranscriptSegment, useLiveAsr } from "../hooks/useLiveAsr";
import { FavoriteSession, readFavoriteSessions, writeFavoriteSessions } from "./favoriteSessions";
import { HistorySession, readHistorySessions, writeHistorySessions } from "./historySessions";
import { SessionTextPanel } from "./SessionTextPanel";
import { TopBarLanguages, getLangLabel, getLangLlmName } from "./TopBarLanguages";

type SessionState = "LIVE" | "PAUSED";

type Props = {
  sourceLang: string;
  targetLang: string;
  onSourceChange: (v: string) => void;
  onTargetChange: (v: string) => void;
  onSwapLangs: () => void;
  initialSessionState?: SessionState;
  startSignal?: number;
  onSessionStatusChange?: (status: { state: SessionState; hasStarted: boolean }) => void;
  onStop: () => void;
};

type TranslationSegment = TranscriptSegment & {
  ids?: number[];
};

const EXPORT_NO_TRANSLATION = "（暂无译文）";

const STREAM_DRAFT_FLUSH_MS = 90;

function isEmptyTranslationStreamMessage(msg: string): boolean {
  return /翻译流未返回内容|翻译端点未返回译文|翻译未返回内容/.test(msg);
}

function isAbortLikeTranslationError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return error.name === "AbortError"
      || msg.includes("aborterror")
      || msg.includes("aborted")
      || msg.includes("signal is aborted");
  }
  return String(error).toLowerCase().includes("aborted");
}

/** 对过短、旧版后端留下的「无法连接或超时：」等提示补充自助排查（多行，见 SessionTextPanel pre-line） */
function enrichTranslationErrorDetail(msg: string): string {
  const t = msg.trim();
  if (!t) {
    return msg;
  }
  if (
    t.length < 56
    && /无法连接|或超时[：:]\s*$|等待超时[（(]?[：:]?\s*$|Read timed|Connection|ConnectTimeout|Max retries/i
      .test(
        t,
      )
  ) {
    return `${t}\n\n请确认：① 在运行「npm run api」的终端按 Ctrl+C 结束旧进程后再启动，使新代码生效；② 根目录执行「npm run api:smoke」应出现 ALL PASSED；③ 浏览器打开 http://127.0.0.1:18787/api/health 应含 \"llm_translate\":\"requests\"；④ 仍失败时检查「设置」里语言模型 Base URL 与 Key，需要代理可为 API 进程设置 RT_LLM_HTTPS_PROXY。`;
  }
  return msg;
}

async function readApiError(r: Response): Promise<string> {
  const text = await r.text();
  if (!text.trim()) return "请求失败";
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (parsed.detail != null) return JSON.stringify(parsed.detail).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
  return "请求失败";
}

/** 与 /api/translate 的备用重试为同一套后端流式逻辑，去重同义提示。 */
function mergeStreamAndTranslateFallbackError(
  main: string,
  fallback: string | null | undefined,
): string {
  if (!fallback?.trim()) {
    return main;
  }
  if (fallback === main || main.includes(fallback) || fallback.includes(main)) {
    return main;
  }
  return `${main}（重试：${fallback}）`;
}

function composeIncrementalTranslation(base: string, next: string): string {
  const a = base.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  if (/\s$/.test(base) || /^[,.;:!?，。！？；：、）\])}]/.test(b)) {
    return `${a}${b}`;
  }
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]$/.test(a) || /^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(b)) {
    return `${a}${b}`;
  }
  return `${a} ${b}`;
}

function formatTimestampForFile(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function buildSessionMarkdown({
  sourceLabel,
  targetLabel,
  elapsedMs,
  transcript,
  translation,
}: {
  sourceLabel: string;
  targetLabel: string;
  elapsedMs: number;
  transcript: string;
  translation: string;
}): string {
  const orig = transcript.trim() || "（无原文）";
  const trans = translation.trim() || EXPORT_NO_TRANSLATION;
  return [
    "# 实时翻译会话",
    "",
    `- 原文：${sourceLabel}`,
    `- 译文：${targetLabel}`,
    `- 时长：${Math.floor(elapsedMs / 1000)} 秒`,
    "",
    `## 原文（${sourceLabel}）`,
    "",
    orig,
    "",
    `## 译文（${targetLabel}）`,
    "",
    trans,
    "",
  ].join("\n");
}

/** 读取 /api/translate/stream 的 NDJSON：{c} 多次，{ok:true} 结束，{e} 错误 */
async function consumeTranslateNdjsonStream(
  r: Response,
  onDelta: (full: string) => void,
  isStale: () => boolean,
): Promise<void> {
  if (!r.body) {
    throw new Error("无响应体");
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let accum = "";
  let lastFlushAt = Date.now();
  let sawOk = false;
  const flushDelta = (force = false) => {
    if (!accum) return;
    const now = Date.now();
    if (
      force
      || now - lastFlushAt >= STREAM_DRAFT_FLUSH_MS
      || /[\s,.;:!?，。！？；：、]$/.test(accum)
    ) {
      lastFlushAt = now;
      onDelta(accum);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (isStale()) {
      return;
    }
    if (done) {
      break;
    }
    buffer += dec.decode(value, { stream: true });
    for (;;) {
      const ix = buffer.indexOf("\n");
      if (ix < 0) {
        break;
      }
      const line = buffer.slice(0, ix);
      buffer = buffer.slice(ix + 1);
      if (!line.trim()) {
        continue;
      }
      let o: { c?: string; e?: string; ok?: boolean };
      try {
        o = JSON.parse(line) as { c?: string; e?: string; ok?: boolean };
      } catch {
        throw new Error("翻译流解析失败。");
      }
      if (isStale()) {
        return;
      }
      if (typeof o.e === "string" && o.e) {
        throw new Error(o.e);
      }
      if (typeof o.c === "string") {
        accum += o.c;
        flushDelta(false);
      }
      if (o.ok === true) {
        sawOk = true;
        flushDelta(true);
        return;
      }
    }
  }
  if (buffer.trim() && !sawOk) {
    try {
      const o = JSON.parse(buffer) as { e?: string; ok?: boolean };
      if (o.e) {
        throw new Error(o.e);
      }
      if (o.ok === true) {
        sawOk = true;
        flushDelta(true);
      }
    } catch (e) {
      if (e instanceof Error && e.message !== "翻译流解析失败。") {
        throw e;
      }
    }
  }
  if (isStale()) {
    return;
  }
  if (!sawOk) {
    throw new Error("翻译流意外结束。");
  }
}

export function LiveSessionPage({
  sourceLang,
  targetLang,
  onSourceChange,
  onTargetChange,
  onSwapLangs,
  initialSessionState = "LIVE",
  startSignal = 0,
  onSessionStatusChange,
  onStop,
}: Props) {
  const [sessionState, setSessionState] = useState<SessionState>(() => initialSessionState);
  const [hasStarted, setHasStarted] = useState(() => initialSessionState === "LIVE");
  const [translation, setTranslation] = useState("");
  const [translationDraft, setTranslationDraft] = useState("");
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationPending, setTranslationPending] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [asrRestartKey, setAsrRestartKey] = useState(0);
  const [favoriteSavedFingerprint, setFavoriteSavedFingerprint] = useState<string | null>(null);
  const isLive = sessionState === "LIVE";
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const sessionIdRef = useRef(`session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sessionStartedAtRef = useRef(new Date().toISOString());
  const historySavedRef = useRef(false);
  const pausedAccumulatedRef = useRef(0);
  const liveSegmentStartRef = useRef<number | null>(initialSessionState === "LIVE" ? Date.now() : null);
  const translateInFlightRef = useRef(false);
  const translationRef = useRef("");
  const translationCommittedRef = useRef("");
  const translationDraftRef = useRef("");
  const translatedSourceRef = useRef("");
  const translatedSegmentIdsRef = useRef<Set<number>>(new Set());
  const pendingFinalSegmentsRef = useRef<TranslationSegment[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamGenRef = useRef(0);
  const runTranslateSegmentRef = useRef<(segment: TranslationSegment) => void>(() => {});
  const {
    status: asrStatus,
    errorMessage: asrError,
    transcript,
    latestFinalSegment,
    asrMode,
    clearTranscript,
  } = useLiveAsr({
    enabled: isLive,
    language: sourceLang,
    restartKey: asrRestartKey,
  });

  const transcriptBody =
    transcript
      || (asrStatus === "connecting" || asrStatus === "listening"
        ? (asrStatus === "connecting" ? "正在连接麦克风…" : "正在听写…")
        : isLive
          ? "等待语音输入"
          : "已暂停");

  const hasTranscript = Boolean(transcript.trim());
  const isActivelyCapturing =
    isLive && (asrStatus === "connecting" || asrStatus === "listening");
  const showCaptureHintMotion = isActivelyCapturing && !hasTranscript;

  const visibleTranslation = composeIncrementalTranslation(translation, translationDraft);
  const hasTranslation = Boolean(visibleTranslation.trim());
  const sessionFingerprint = JSON.stringify({
    sourceLang,
    targetLang,
    transcript: transcript.trim(),
    translation: visibleTranslation.trim(),
  });
  const hasSessionText = Boolean(transcript.trim() || visibleTranslation.trim());
  const isFavoriteSaved = favoriteSavedFingerprint === sessionFingerprint;
  const isAsrError = isLive && asrStatus === "error";
  const translationBody =
    visibleTranslation.trim()
      || (isLive
        ? (hasTranscript
          ? (translationPending ? "正在翻译…" : "等待翻译")
          : "原文出现后开始翻译")
        : "已暂停");

  const showTranslationBreathe =
    isLive
    && hasTranscript
    && !hasTranslation
    && (translationPending || asrStatus === "connecting" || asrStatus === "listening");

  useEffect(() => {
    translationRef.current = translation;
  }, [translation]);

  useEffect(() => {
    translationDraftRef.current = translationDraft;
  }, [translationDraft]);

  useEffect(() => {
    streamAbortRef.current?.abort();
    streamGenRef.current += 1;
    setTranslation("");
    setTranslationDraft("");
    setTranslationError(null);
    setTranslationPending(false);
    setFavoriteSavedFingerprint(null);
    translationCommittedRef.current = "";
    translatedSourceRef.current = "";
    translatedSegmentIdsRef.current = new Set();
    pendingFinalSegmentsRef.current = [];
    translateInFlightRef.current = false;
  }, [sourceLang, targetLang]);

  const runTranslateSegment = useCallback(
    async (segment: TranslationSegment) => {
      const sourceText = segment.text.trim();
      if (!sourceText || !isLiveRef.current) return;
      const segmentIds = segment.ids?.length ? segment.ids : [segment.id];
      if (segmentIds.every((id) => translatedSegmentIdsRef.current.has(id))) return;

      if (translateInFlightRef.current) {
        const alreadyQueued = pendingFinalSegmentsRef.current.some((item) =>
          (item.ids?.length ? item.ids : [item.id]).some((id) => segmentIds.includes(id))
        );
        if (!alreadyQueued) {
          pendingFinalSegmentsRef.current.push(segment);
        }
        setTranslationPending(true);
        return;
      }

      const myId = streamGenRef.current;
      const ac = new AbortController();
      streamAbortRef.current = ac;
      translateInFlightRef.current = true;
      setTranslationPending(true);

      const previousSource = translatedSourceRef.current.trim();
      const committedAtRequest = translationCommittedRef.current.trim();
      const previousVisibleTranslation =
        composeIncrementalTranslation(translationRef.current, translationDraftRef.current).trim()
        || committedAtRequest;
      let streamed = "";
      const composeResult = (next: string) =>
        composeIncrementalTranslation(committedAtRequest, next);
      const translatePayload = JSON.stringify({
        text: sourceText,
        source_language: getLangLlmName(sourceLang),
        target_language: getLangLlmName(targetLang),
        source_lang_code: sourceLang,
        target_lang_code: targetLang,
        previous_source_text: previousSource || undefined,
        previous_translation_text: committedAtRequest || undefined,
      });

      const commitTranslation = (next: string) => {
        const trimmed = next.trim();
        if (!trimmed || myId !== streamGenRef.current) return;
        const composed = composeResult(trimmed);
        segmentIds.forEach((id) => translatedSegmentIdsRef.current.add(id));
        translatedSourceRef.current = previousSource
          ? `${previousSource} ${sourceText}`
          : sourceText;
        translationCommittedRef.current = composed;
        setTranslation(composed);
        setTranslationDraft("");
        setTranslationError(null);
      };

      const applyNonStreamResult = async (res: Response) => {
        if (!res.ok) {
          throw new Error(await readApiError(res));
        }
        const data = (await res.json()) as { translation?: string };
        const next = (data.translation || "").trim();
        if (next) {
          commitTranslation(next);
        } else {
          setTranslation(previousVisibleTranslation);
          setTranslationDraft("");
          setTranslationError("翻译端点未返回译文。");
        }
      };

      const tryNonStreamOnly = async (): Promise<void> => {
        const r2 = await fetch(apiUrl("/api/translate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: translatePayload,
          signal: ac.signal,
        });
        await applyNonStreamResult(r2);
      };

      try {
        const r = await fetch(apiUrl("/api/translate/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: translatePayload,
          signal: ac.signal,
        });
        if (r.status === 404 || r.status === 405) {
          void r.body?.cancel();
          await tryNonStreamOnly();
          return;
        }
        if (!r.ok) {
          try {
            await tryNonStreamOnly();
            return;
          } catch {
            throw new Error(await readApiError(r));
          }
        }
        await consumeTranslateNdjsonStream(
          r,
          (full) => {
            if (myId !== streamGenRef.current) return;
            streamed = full;
            if (full.trim()) {
              setTranslationDraft(full.trim());
              setTranslationError(null);
            }
          },
          () => myId !== streamGenRef.current,
        );
        if (myId !== streamGenRef.current) return;
        const done = streamed.trim();
        if (done) {
          commitTranslation(done);
        } else {
          setTranslation(previousVisibleTranslation);
          setTranslationDraft("");
          setTranslationError(null);
        }
      } catch (error) {
        const aborted = ac.signal.aborted || isAbortLikeTranslationError(error);
        if (myId !== streamGenRef.current) {
          return;
        }
        if (aborted) {
          setTranslation(previousVisibleTranslation || composeResult(streamed));
          setTranslationDraft("");
          return;
        }
        const message = error instanceof Error ? error.message : "翻译失败";
        let fallbackMessage: string | null = null;
        try {
          await tryNonStreamOnly();
          return;
        } catch (e2) {
          if (ac.signal.aborted || isAbortLikeTranslationError(e2)) {
            setTranslation(previousVisibleTranslation || composeResult(streamed));
            setTranslationDraft("");
            if (isEmptyTranslationStreamMessage(message)) {
              setTranslationError(null);
            }
            return;
          }
          fallbackMessage = e2 instanceof Error ? e2.message : String(e2);
        }
        setTranslation(previousVisibleTranslation || composeResult(streamed));
        setTranslationDraft("");
        if (isEmptyTranslationStreamMessage(fallbackMessage)) {
          setTranslationError(null);
          return;
        }
        setTranslationError(
          enrichTranslationErrorDetail(
            mergeStreamAndTranslateFallbackError(message, fallbackMessage),
          ),
        );
      } finally {
        if (myId === streamGenRef.current) {
          translateInFlightRef.current = false;
          const pending = pendingFinalSegmentsRef.current.splice(0);
          const untranslated = pending.filter((item) => {
            const ids = item.ids?.length ? item.ids : [item.id];
            return !ids.every((id) => translatedSegmentIdsRef.current.has(id));
          });
          const next = untranslated.length <= 1
            ? untranslated[0]
            : {
              ...untranslated[0],
              id: untranslated[0].id,
              ids: untranslated.flatMap((item) => item.ids?.length ? item.ids : [item.id]),
              text: untranslated.map((item) => item.text.trim()).filter(Boolean).join(" "),
              bgMs: untranslated[0].bgMs,
              edMs: untranslated[untranslated.length - 1].edMs,
            };
          if (next) {
            window.setTimeout(() => runTranslateSegmentRef.current(next), 0);
          } else {
            setTranslationPending(false);
          }
        }
      }
    },
    [sourceLang, targetLang],
  );

  runTranslateSegmentRef.current = (segment: TranscriptSegment) => {
    void runTranslateSegment(segment);
  };

  useEffect(() => {
    onSessionStatusChange?.({ state: sessionState, hasStarted });
  }, [hasStarted, onSessionStatusChange, sessionState]);

  useEffect(() => {
    if (startSignal <= 0) return;
    setHasStarted(true);
    setSessionState((prev) => {
      if (prev === "LIVE") return prev;
      liveSegmentStartRef.current = Date.now();
      return "LIVE";
    });
  }, [startSignal]);

  useEffect(() => {
    if (!isLive) {
      streamAbortRef.current?.abort();
      streamGenRef.current += 1;
      translateInFlightRef.current = false;
      pendingFinalSegmentsRef.current = [];
      setTranslationDraft("");
      setTranslationPending(false);
      return;
    }
    if (latestFinalSegment) {
      runTranslateSegmentRef.current(latestFinalSegment);
    }
  }, [isLive, latestFinalSegment]);

  useEffect(() => {
    liveSegmentStartRef.current = initialSessionState === "LIVE" ? Date.now() : null;
    pausedAccumulatedRef.current = 0;
  }, [initialSessionState]);

  useEffect(() => {
    if (sessionState !== "LIVE") return;
    liveSegmentStartRef.current = Date.now();
    const id = window.setInterval(() => {
      const start = liveSegmentStartRef.current;
      if (start == null) return;
      setElapsedMs(pausedAccumulatedRef.current + (Date.now() - start));
    }, 200);
    return () => clearInterval(id);
  }, [sessionState]);

  const togglePause = useCallback(() => {
    setSessionState((prev) => {
      if (prev === "LIVE") {
        const start = liveSegmentStartRef.current;
        if (start != null) {
          pausedAccumulatedRef.current += Date.now() - start;
        }
        liveSegmentStartRef.current = null;
        setElapsedMs(pausedAccumulatedRef.current);
        return "PAUSED";
      }
      setHasStarted(true);
      liveSegmentStartRef.current = Date.now();
      return "LIVE";
    });
  }, []);

  const retryMicrophone = useCallback(() => {
    setHasStarted(true);
    setSessionState("LIVE");
    setAsrRestartKey((v) => v + 1);
  }, []);

  const exportSession = useCallback(() => {
    const body = buildSessionMarkdown({
      sourceLabel: getLangLabel(sourceLang),
      targetLabel: getLangLabel(targetLang),
      elapsedMs,
      transcript,
      translation: visibleTranslation,
    });
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `liqun-translate-${formatTimestampForFile()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [elapsedMs, sourceLang, targetLang, transcript, visibleTranslation]);

  const favoriteSession = useCallback(() => {
    if (!hasSessionText) return;
    const now = new Date().toISOString();
    const favorite: FavoriteSession = {
      id: sessionIdRef.current,
      createdAt: now,
      updatedAt: now,
      sourceLang,
      targetLang,
      sourceLabel: getLangLabel(sourceLang),
      targetLabel: getLangLabel(targetLang),
      elapsedMs,
      transcript: transcript.trim(),
      translation: visibleTranslation.trim(),
    };

    try {
      const list = readFavoriteSessions();
      const existing = list.find((item) => item?.id === favorite.id);
      const next = existing
        ? list.map((item) =>
          item?.id === favorite.id
            ? { ...favorite, createdAt: item.createdAt || favorite.createdAt }
            : item
        )
        : [favorite, ...list];
      writeFavoriteSessions(next);
      setFavoriteSavedFingerprint(sessionFingerprint);
    } catch {
      window.alert("无法收藏此次对话，请检查浏览器本地存储权限。");
    }
  }, [
    elapsedMs,
    hasSessionText,
    sessionFingerprint,
    sourceLang,
    targetLang,
    transcript,
    visibleTranslation,
  ]);

  const saveHistorySession = useCallback(() => {
    if (historySavedRef.current) return;
    if (!hasStarted && !hasSessionText && elapsedMs <= 0) return;
    const now = new Date().toISOString();
    const historySession: HistorySession = {
      id: sessionIdRef.current,
      createdAt: sessionStartedAtRef.current,
      endedAt: now,
      updatedAt: now,
      sourceLang,
      targetLang,
      sourceLabel: getLangLabel(sourceLang),
      targetLabel: getLangLabel(targetLang),
      elapsedMs,
      transcript: transcript.trim(),
      translation: visibleTranslation.trim(),
    };

    try {
      const list = readHistorySessions();
      const existing = list.find((item) => item.id === historySession.id);
      const next = existing
        ? list.map((item) =>
          item.id === historySession.id
            ? { ...historySession, createdAt: item.createdAt || historySession.createdAt }
            : item
        )
        : [historySession, ...list];
      writeHistorySessions(next);
      historySavedRef.current = true;
    } catch {
      window.alert("无法保存会话记录，请检查浏览器本地存储权限。");
    }
  }, [
    elapsedMs,
    hasSessionText,
    hasStarted,
    sourceLang,
    targetLang,
    transcript,
    visibleTranslation,
  ]);

  const finishSession = useCallback(() => {
    saveHistorySession();
    onStop();
  }, [onStop, saveHistorySession]);

  const clearSession = useCallback(() => {
    streamAbortRef.current?.abort();
    streamGenRef.current += 1;
    translateInFlightRef.current = false;
    pendingFinalSegmentsRef.current = [];
    clearTranscript();
    translationCommittedRef.current = "";
    translationDraftRef.current = "";
    translatedSourceRef.current = "";
    translatedSegmentIdsRef.current = new Set();
    setTranslation("");
    setTranslationDraft("");
    setTranslationError(null);
    setTranslationPending(false);
    setFavoriteSavedFingerprint(null);
  }, [clearTranscript]);

  const sourceName = getLangLabel(sourceLang);
  const targetName = getLangLabel(targetLang);

  const sourceFootnote = isLive
    ? (asrStatus === "listening"
      ? (asrMode === "faster_whisper"
        ? "本机转写"
        : asrMode === "parakeet"
          ? "Parakeet 本机转写"
          : asrMode === "online_api"
          ? "在线 API 转写"
          : asrMode === "browser"
          ? "浏览器识别"
          : "听写中")
      : asrStatus === "connecting"
        ? "请允许麦克风访问"
        : "")
    : "";

  const translationFootnote = isLive
    ? (asrStatus === "listening"
      ? (asrMode === "faster_whisper"
        ? "使用设置中的语言模型生成译文"
        : asrMode === "parakeet"
          ? "使用设置中的语言模型生成译文"
          : asrMode === "online_api"
          ? "使用设置中的语言模型生成译文"
          : asrMode === "browser"
          ? "使用设置中的语言模型生成译文"
          : "随原文更新")
      : asrStatus === "connecting"
        ? "连接中"
        : "")
    : "";
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-gradient-to-br from-sky-50/90 via-violet-50/50 to-white">
      <header className="shrink-0 border-b border-white/60 bg-white/80 shadow-soft backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-3 px-5 py-3.5 md:px-10">

          <div className="flex flex-wrap items-center justify-center gap-2 md:flex-1 md:justify-center">
            <TopBarLanguages
              compact
              sourceLang={sourceLang}
              targetLang={targetLang}
              onSourceChange={onSourceChange}
              onTargetChange={onTargetChange}
              onSwapLangs={onSwapLangs}
            />
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-40 pt-8 md:px-10">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          <SessionTextPanel
            title={`原文（${sourceName}）`}
            role="source"
            copyValue={transcript}
            body={transcriptBody}
            hasContent={hasTranscript}
            showPlaceholderBreathe={showCaptureHintMotion}
            isLive={isLive}
            footnote={sourceFootnote}
            errorText={asrError}
            elapsedMs={elapsedMs}
          />

          <SessionTextPanel
            title={`译文（${targetName}）`}
            role="translation"
            copyValue={visibleTranslation.trim() || translationBody}
            body={translationBody}
            stableText={translation}
            draftText={translationDraft}
            hasContent={hasTranslation}
            showPlaceholderBreathe={showTranslationBreathe}
            isLive={isLive}
            footnote={translationFootnote}
            errorText={translationError}
            elapsedMs={elapsedMs}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-white via-white/95 to-transparent pb-5 pt-16">
        <div className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-5">
          <button
            type="button"
            onClick={isAsrError ? retryMicrophone : togglePause}
            className="inline-flex min-h-11 min-w-[9.75rem] items-center justify-center rounded-2xl bg-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:bg-violet-500"
          >
            {isAsrError ? "重试麦克风" : isLive ? "暂停" : hasStarted ? "继续" : "开始"}
          </button>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="inline-flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
              <button
                type="button"
                onClick={exportSession}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-slate-700 transition hover:bg-sky-50 hover:text-sky-700"
                title="下载此次对话为 Markdown"
              >
                <Download className="h-4 w-4 text-sky-500" aria-hidden />
                下载Markdown
              </button>
              <button
                type="button"
                onClick={favoriteSession}
                disabled={!hasSessionText}
                className={`inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition ${
                  isFavoriteSaved
                    ? "bg-amber-50 text-amber-800"
                    : "text-slate-700 hover:bg-amber-50 hover:text-amber-900"
                } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-slate-700`}
                title={hasSessionText ? "收藏此次对话到本机" : "出现原文或译文后可收藏"}
                aria-pressed={isFavoriteSaved}
              >
                <Star
                  className={`h-4 w-4 ${isFavoriteSaved ? "fill-amber-400 text-amber-500" : "text-amber-500"}`}
                  aria-hidden
                />
                {isFavoriteSaved ? "已收藏" : "收藏"}
              </button>
              <button
                type="button"
                onClick={clearSession}
                className="inline-flex h-9 items-center rounded-xl px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                title="清空当前已录入的原文与译文，不影响暂停/继续与麦克风"
              >
                清空
              </button>
            </div>
            <button
              type="button"
              onClick={finishSession}
              className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-rose-200 bg-rose-50 px-5 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
            >
              结束
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
