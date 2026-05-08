import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { LandingPage } from "./components/LandingPage";
import { LiveSessionPage } from "./components/LiveSessionPage";
import { SettingsPage } from "./components/SettingsPage";
import { FavoritesPage } from "./components/FavoritesPage";
import { HistoryPage } from "./components/HistoryPage";
import { StaleApiBanner } from "./components/StaleApiBanner";

export type MainView = "landing" | "live" | "settings" | "history" | "favorites";
type InitialLiveSessionState = "LIVE" | "PAUSED";

const DEFAULT_SIDEBAR_W = 256;
const MIN_SIDEBAR_W = 184;
const MAX_SIDEBAR_W = 340;
const HIDE_SIDEBAR_W = 88;

export default function App() {
  const [mainView, setMainView] = useState<MainView>("landing");
  const [initialLiveSessionState, setInitialLiveSessionState] = useState<InitialLiveSessionState>("PAUSED");
  const [liveSessionMounted, setLiveSessionMounted] = useState(false);
  const [liveSessionKey, setLiveSessionKey] = useState(0);
  const [liveSessionStartSignal, setLiveSessionStartSignal] = useState(0);
  const [liveSessionStarted, setLiveSessionStarted] = useState(false);
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("zh");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_W);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const lastSidebarWidthRef = useRef(DEFAULT_SIDEBAR_W);

  const handleSwapLangs = useCallback(() => {
    const s = sourceLang;
    setSourceLang(targetLang);
    setTargetLang(s);
  }, [sourceLang, targetLang]);

  const handleSourceChange = useCallback((nextSource: string) => {
    setSourceLang((currentSource) => {
      if (nextSource !== "auto" && nextSource === targetLang) {
        setTargetLang(currentSource);
      }
      return nextSource;
    });
  }, [targetLang]);

  const handleTargetChange = useCallback((nextTarget: string) => {
    setTargetLang((currentTarget) => {
      if (nextTarget === sourceLang) {
        setSourceLang(currentTarget);
      }
      return nextTarget;
    });
  }, [sourceLang]);

  const goHome = useCallback(() => {
    setMainView("landing");
  }, []);

  const startSession = useCallback(() => {
    if (!liveSessionMounted || !liveSessionStarted) {
      setInitialLiveSessionState("LIVE");
    }
    setLiveSessionMounted(true);
    setLiveSessionStartSignal((v) => v + 1);
    setMainView("live");
  }, [liveSessionMounted, liveSessionStarted]);

  const stopSession = useCallback(() => {
    setLiveSessionMounted(false);
    setLiveSessionKey((v) => v + 1);
    setInitialLiveSessionState("PAUSED");
    setLiveSessionStarted(false);
    setMainView("landing");
  }, []);

  const goSettings = useCallback(() => {
    setMainView("settings");
  }, []);

  const goHistory = useCallback(() => {
    setMainView("history");
  }, []);

  const goFavorites = useCallback(() => {
    setMainView("favorites");
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarExpanded((v) => {
      if (!v) {
        setSidebarWidth(lastSidebarWidthRef.current);
      }
      return !v;
    });
  }, []);

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizingSidebar(true);
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (event: PointerEvent) => {
      const nextWidth = event.clientX;
      if (nextWidth <= HIDE_SIDEBAR_W) {
        setSidebarExpanded(false);
        return;
      }
      const clamped = Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, nextWidth));
      lastSidebarWidthRef.current = clamped;
      setSidebarWidth(clamped);
      setSidebarExpanded(true);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.clientX <= HIDE_SIDEBAR_W) {
        setSidebarExpanded(false);
      }
      setIsResizingSidebar(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });

    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [isResizingSidebar]);

  const selectHome = useCallback(() => {
    goHome();
  }, [goHome]);

  const selectLive = useCallback(() => {
    if (mainView === "live") return;
    if (!liveSessionMounted || !liveSessionStarted) {
      setInitialLiveSessionState("PAUSED");
    }
    setLiveSessionMounted(true);
    setMainView("live");
  }, [liveSessionMounted, liveSessionStarted, mainView]);

  const handleLiveSessionStatusChange = useCallback(
    ({ hasStarted }: { state: InitialLiveSessionState; hasStarted: boolean }) => {
      setLiveSessionStarted(hasStarted);
    },
    [],
  );

  return (
    <div className="relative flex h-full min-h-0 bg-slate-100 text-slate-800">
      <div
        className={`relative flex h-full min-h-0 shrink-0 overflow-hidden ${
          isResizingSidebar ? "" : "transition-[width] duration-200 ease-out"
        } ${
          sidebarExpanded ? "" : "pointer-events-none"
        }`}
        style={{ width: sidebarExpanded ? sidebarWidth : 0 }}
        aria-hidden={!sidebarExpanded}
        {...(!sidebarExpanded ? { inert: true } : {})}
      >
        <Sidebar
          mainView={mainView}
          onSelectHome={selectHome}
          onSelectLive={selectLive}
          onSelectHistory={goHistory}
          onSelectFavorites={goFavorites}
          onSelectSettings={goSettings}
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧栏宽度"
          title="拖动调整侧栏宽度，拉到最左隐藏"
          onPointerDown={startSidebarResize}
          className="absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize touch-none bg-transparent after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-transparent hover:after:bg-violet-300"
        />
      </div>

      <button
        type="button"
        onClick={toggleSidebar}
        aria-expanded={sidebarExpanded}
        aria-label={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        title={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        className={`absolute z-40 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-card transition-all duration-200 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-300 ${
          sidebarExpanded
            ? "top-[26px] -translate-x-1/2"
            : "left-3 top-[26px] translate-x-0"
        }`}
        style={sidebarExpanded ? { left: sidebarWidth } : undefined}
      >
        {sidebarExpanded ? (
          <ChevronLeft className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
      </button>

      <main
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${darkMode ? "bg-slate-950" : "bg-[#fafbfc]"}`}
      >
        <StaleApiBanner />
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {liveSessionMounted ? (
            <div className={mainView === "live" ? "h-full min-h-0" : "hidden"}>
              <LiveSessionPage
                key={liveSessionKey}
                sourceLang={sourceLang}
                targetLang={targetLang}
                onSourceChange={handleSourceChange}
                onTargetChange={handleTargetChange}
                onSwapLangs={handleSwapLangs}
                initialSessionState={initialLiveSessionState}
                startSignal={liveSessionStartSignal}
                onSessionStatusChange={handleLiveSessionStatusChange}
                onStop={stopSession}
              />
            </div>
          ) : null}
          {mainView === "settings" ? (
            <SettingsPage onBack={goHome} />
          ) : mainView === "history" ? (
            <HistoryPage onBack={goHome} />
          ) : mainView === "favorites" ? (
            <FavoritesPage onBack={goHome} />
          ) : mainView === "live" ? (
            liveSessionMounted ? null : (
              <LiveSessionPage
                key={liveSessionKey}
                sourceLang={sourceLang}
                targetLang={targetLang}
                onSourceChange={handleSourceChange}
                onTargetChange={handleTargetChange}
                onSwapLangs={handleSwapLangs}
                initialSessionState={initialLiveSessionState}
                startSignal={liveSessionStartSignal}
                onSessionStatusChange={handleLiveSessionStatusChange}
                onStop={stopSession}
              />
            )
          ) : (
            <LandingPage
              sourceLang={sourceLang}
              targetLang={targetLang}
              onSourceChange={handleSourceChange}
              onTargetChange={handleTargetChange}
              onSwapLangs={handleSwapLangs}
              onStart={startSession}
              darkMode={darkMode}
              onToggleDark={() => setDarkMode((d) => !d)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
