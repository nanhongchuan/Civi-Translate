import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Star, Trash2 } from "lucide-react";
import { FavoriteSession, readFavoriteSessions, writeFavoriteSessions } from "./favoriteSessions";
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

function buildMarkdown(session: FavoriteSession): string {
  return [
    "# 收藏会话",
    "",
    `- 原文：${session.sourceLabel}`,
    `- 译文：${session.targetLabel}`,
    `- 时长：${formatHms(session.elapsedMs)}`,
    `- 收藏时间：${formatSavedAt(session.createdAt)}`,
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

function downloadMarkdown(session: FavoriteSession): void {
  const blob = new Blob([buildMarkdown(session)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liqun-favorite-${session.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function FavoritesPage({ onBack }: Props) {
  const [sessions, setSessions] = useState<FavoriteSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sessions.find((item) => item.id === selectedId) ?? sessions[0] ?? null;

  const load = useCallback(() => {
    try {
      setSessions(readFavoriteSessions());
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
    writeFavoriteSessions(next);
    setSessions(next);
  }, [sessions]);

  const countText = useMemo(() => `${sessions.length} 条收藏`, [sessions.length]);

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
          <h1 className="text-lg font-semibold text-slate-900">收藏</h1>
          <p className="text-xs text-slate-400">{countText}</p>
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-500">
              <Star className="h-5 w-5" />
            </div>
            <p className="mt-4 text-sm font-medium text-slate-700">还没有收藏的对话</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              在会话页点击“收藏”后，会出现在这里。
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
                      {formatSavedAt(session.updatedAt)} · {formatHms(session.elapsedMs)}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSession(session.id)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    aria-label="删除收藏"
                    title="删除收藏"
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
                      收藏于 {formatSavedAt(selected.createdAt)} · 时长 {formatHms(selected.elapsedMs)}
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
