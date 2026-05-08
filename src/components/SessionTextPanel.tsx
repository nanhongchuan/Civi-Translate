import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";

import { formatHms } from "./sessionFormatters";

type Props = {
  title: string;
  role: "source" | "translation";
  copyValue: string;
  body: string;
  stableText?: string;
  draftText?: string;
  hasContent: boolean;
  /** 占位行：连接/进行中的轻量动效 */
  showPlaceholderBreathe: boolean;
  isLive: boolean;
  footnote: string;
  /** 仅原文区：本机转写等错误 */
  errorText?: string | null;
  /** 与顶栏同源的会话计时（与原文共用） */
  elapsedMs: number;
};

async function copyText(label: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.alert(`无法复制${label}，请检查浏览器权限。`);
  }
}

/**
 * 原文 / 译文 共用：会话计时、转写区、底栏说明、右下角展开/收起（仅在溢出时展开可用）。
 */
export function SessionTextPanel({
  title,
  role,
  copyValue,
  body,
  stableText,
  draftText,
  hasContent,
  showPlaceholderBreathe,
  isLive,
  footnote,
  errorText,
  elapsedMs,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const compactHeight = role === "translation" ? "h-[4.75rem]" : "h-[6.5rem]";

  const onPaneScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const slack = 64;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!expanded) {
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [body, expanded, errorText]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateOverflow = () => {
      if (expanded) {
        setOverflows(true);
        return;
      }
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    updateOverflow();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(updateOverflow);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, expanded, errorText]);

  const onExpandClick = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      stickToBottomRef.current = true;
      return;
    }
    if (!overflows) return;
    stickToBottomRef.current = true;
    setExpanded(true);
  }, [expanded, overflows]);

  const copyLabel = role === "source" ? "原文" : "译文";
  const hasDraftView = role === "translation" && Boolean(draftText?.trim());
  const showLiveIndicator = isLive && !errorText;
  const ariaStream =
    role === "source"
      ? (expanded
        ? "识别原文（已展开，高度随内容增加，至上限可滚动）"
        : "识别原文（紧凑，内容过多可点右下角展开）")
      : (expanded
        ? "译文（已展开，高度随内容增加，至上限可滚动）"
        : "译文（紧凑，内容过多可点右下角展开）");

  return (
    <article className="relative rounded-2xl border border-slate-200/80 bg-white/90 p-5 pb-12 shadow-soft backdrop-blur-sm md:p-6 md:pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-slate-800">{title}</h2>
          {showLiveIndicator ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold ${
                role === "source"
                  ? "bg-violet-50 text-violet-700 ring-1 ring-violet-100"
                  : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
              }`}
              aria-label={role === "source" ? "正在实时转写" : "正在实时翻译"}
              title={role === "source" ? "正在实时转写" : "正在实时翻译"}
            >
              <span className="live-status-dot h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              <span className="flex h-3 items-end gap-0.5" aria-hidden>
                <span className="live-status-bar h-1.5" />
                <span className="live-status-bar h-3 [animation-delay:120ms]" />
                <span className="live-status-bar h-2 [animation-delay:240ms]" />
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
            onClick={() => copyText(copyLabel, copyValue)}
          >
            <Copy className="h-3.5 w-3.5" />
            复制
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <div
          className={`flex min-w-[120px] flex-1 items-center justify-end rounded-xl bg-slate-50/90 px-3 py-2 ring-1 ring-slate-100 ${
            isLive ? "opacity-100" : "opacity-40"
          }`}
        >
          <span className="font-mono tabular-nums text-slate-700">{formatHms(elapsedMs)}</span>
        </div>
      </div>
      {errorText ? (
        <p className="mb-2 whitespace-pre-line rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {errorText}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={onPaneScroll}
        className={`transcript-stream mt-4 rounded-xl bg-slate-50/50 px-2 py-2 ring-1 ring-slate-100 ${
          expanded ? "max-h-[min(80vh,32rem)] min-h-[6.5rem]" : compactHeight
        }`}
        aria-label={ariaStream}
      >
        <div
          className={
            hasContent
              ? "flex min-h-full min-w-0 flex-col items-start justify-start pr-0.5 pl-0.5"
              : "flex min-h-full min-w-0 flex-col items-center justify-center px-1"
          }
        >
          <p
            className={
              hasContent
                ? "min-h-[1.5rem] w-full whitespace-pre-wrap break-words text-left text-lg font-medium leading-relaxed text-slate-900 md:text-xl"
                : `w-full min-h-[1.5rem] max-w-md whitespace-pre-wrap break-words text-center text-lg font-medium leading-relaxed md:text-xl ${
                  showPlaceholderBreathe
                    ? "asr-listening-breathe text-violet-600"
                    : isLive
                      ? "text-slate-400"
                      : "text-amber-700/80"
                }`
            }
          >
            {hasDraftView ? (
              <>
                {stableText?.trim() ? <span>{stableText.trim()}</span> : null}
                {stableText?.trim() && draftText?.trim() ? <span> </span> : null}
                <span className="text-slate-500">{draftText?.trim()}</span>
              </>
            ) : (
              body
            )}
          </p>
        </div>
      </div>
      <p className="mt-2 pr-16 text-sm leading-relaxed text-slate-400 md:pr-20">
        {footnote}
      </p>
      <button
        type="button"
        className={
          expanded
            ? "absolute bottom-4 right-4 z-10 inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200/80 bg-white/95 px-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm transition hover:border-slate-300 hover:bg-white hover:text-slate-800 md:bottom-5 md:right-5"
            : "absolute bottom-4 right-4 z-10 inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200/80 bg-white/95 px-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm transition enabled:hover:border-slate-300 enabled:hover:bg-white enabled:hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40 md:bottom-5 md:right-5"
        }
        aria-expanded={expanded}
        aria-label={expanded ? (role === "source" ? "收起原文区" : "收起译文区") : (role === "source" ? "展开原文区" : "展开译文区")}
        disabled={!expanded && !overflows}
        title={!expanded && !overflows ? "内容未超出显示区域，无需展开" : undefined}
        onClick={onExpandClick}
      >
        {expanded ? (
          <>
            收起
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          </>
        ) : (
          <>
            展开
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </>
        )}
      </button>
    </article>
  );
}
