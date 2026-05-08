import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock, Download, Trash2 } from "lucide-react";
import { HistorySession, readHistorySessions, writeHistorySessions } from "./historySessions";
import { formatHms } from "./sessionFormatters";

type Props = {
  onBack: () => void;
};

function formatSavedAt(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "未知时间";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildMarkdown(session: HistorySession): string {
  return [
    "# 历史会话",
    "",
    `- 原文：${session.sourceLabel}`,
    `- 译文：${session.targetLabel}`,
    `- 时长：${formatHms(session.elapsedMs)}`,
    `- 开始时间：${formatSavedAt(session.createdAt)}`,
    `- 结束时间：${formatSavedAt(session.endedAt)}`,
    "",
    `## 原文（${session.sourceLabel}）`,
    "",
    session.transcript || "（无原文）",
    "",
    `## 译文（${session.targetLabel}）`,
    "",
    session.translation || "（暂无译文）",
    "",
  ].join("\n");
}

function downloadMarkdown(session: HistorySession): void {
  const blob = new Blob([buildMarkdown(session)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liqun-history-${session.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function HistoryPage({ onBack }: Props) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sessions.find((item) => item.id === selectedId) ?? sessions[0] ?? null;

  const load = useCallback(() => {
    try {
      setSessions(readHistorySessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("storage", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("storage", load);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  useEffect(() => {
    if (!sessions.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !sessions.some((item) => item.id === selectedId)) {
      setSelectedId(sessions[0].id);
    }
  }, [selectedId, sessions]);

  const removeSession = useCallback((id: string) => {
    const next = sessions.filter((item) => item.id !== id);
    writeHistorySessions(next);
    setSessions(next);
  }, [sessions]);

  const countText = useMemo(() => `${sessions.length} 条记录`, [sessions.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fafbfc]">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200/90 bg-white px-5 py-4 md:px-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm transition hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </button>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900">记录</h1>
          <p className="text-xs text-slate-400">{countText}</p>
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
              <Clock className="h-5 w-5" />
            </div>
            <p className="mt-4 text-sm font-medium text-slate-700">还没有会话记录</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              点击会话页“结束”后，会自动收录到这里。
            </p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-5 md:grid-cols-[20rem_minmax(0,1fr)] md:p-8">
          <aside className="min-h-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            {sessions.map((session) => (
              <article
                key={session.id}
                className={`rounded-xl border p-3 transition ${
                  selected?.id === session.id
                    ? "border-violet-200 bg-violet-50/70"
                    : "border-transparent hover:border-slate-200 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedId(session.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-semibold text-slate-800">
                      {session.sourceLabel} → {session.targetLabel}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatSavedAt(session.endedAt)} · {formatHms(session.elapsedMs)}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSession(session.id)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    aria-label="删除记录"
                    title="删除记录"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-500">
                  {session.translation || session.transcript || "无内容"}
                </p>
              </article>
            ))}
          </aside>

          <section className="min-h-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            {selected ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      {selected.sourceLabel} → {selected.targetLabel}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400">
                      结束于 {formatSavedAt(selected.endedAt)} · 时长 {formatHms(selected.elapsedMs)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadMarkdown(selected)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-sky-50 hover:text-sky-700"
                  >
                    <Download className="h-4 w-4 text-sky-500" />
                    下载Markdown
                  </button>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl bg-slate-50/80 p-4 ring-1 ring-slate-100">
                    <h3 className="text-sm font-semibold text-slate-800">原文（{selected.sourceLabel}）</h3>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                      {selected.transcript || "（无原文）"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50/80 p-4 ring-1 ring-slate-100">
                    <h3 className="text-sm font-semibold text-slate-800">译文（{selected.targetLabel}）</h3>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                      {selected.translation || "（暂无译文）"}
                    </p>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
