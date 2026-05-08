export const HISTORY_SESSIONS_KEY = "liqun-translate:history-sessions";

export type HistorySession = {
  id: string;
  createdAt: string;
  endedAt: string;
  updatedAt: string;
  sourceLang: string;
  targetLang: string;
  sourceLabel: string;
  targetLabel: string;
  elapsedMs: number;
  transcript: string;
  translation: string;
};

export function readHistorySessions(): HistorySession[] {
  const stored = window.localStorage.getItem(HISTORY_SESSIONS_KEY);
  if (!stored) return [];
  const parsed = JSON.parse(stored) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is HistorySession =>
    Boolean(
      item
        && typeof item === "object"
        && "id" in item
        && "createdAt" in item
        && "endedAt" in item
        && "transcript" in item
        && "translation" in item,
    )
  );
}

export function writeHistorySessions(sessions: HistorySession[]): void {
  window.localStorage.setItem(HISTORY_SESSIONS_KEY, JSON.stringify(sessions.slice(0, 200)));
}
