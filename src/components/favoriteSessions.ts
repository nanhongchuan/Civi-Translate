export const FAVORITE_SESSIONS_KEY = "liqun-translate:favorite-sessions";

export type FavoriteSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceLang: string;
  targetLang: string;
  sourceLabel: string;
  targetLabel: string;
  elapsedMs: number;
  transcript: string;
  translation: string;
};

export function readFavoriteSessions(): FavoriteSession[] {
  const stored = window.localStorage.getItem(FAVORITE_SESSIONS_KEY);
  if (!stored) return [];
  const parsed = JSON.parse(stored) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is FavoriteSession =>
    Boolean(
      item
        && typeof item === "object"
        && "id" in item
        && "transcript" in item
        && "translation" in item,
    )
  );
}

export function writeFavoriteSessions(sessions: FavoriteSession[]): void {
  window.localStorage.setItem(FAVORITE_SESSIONS_KEY, JSON.stringify(sessions.slice(0, 100)));
}
