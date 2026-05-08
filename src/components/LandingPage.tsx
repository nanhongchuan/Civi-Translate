import {
  AudioWaveform,
  Download,
  FileText,
  Languages,
  Mic,
  Moon,
  Sun,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { TopBarLanguages } from "./TopBarLanguages";

type Props = {
  sourceLang: string;
  targetLang: string;
  onSourceChange: (v: string) => void;
  onTargetChange: (v: string) => void;
  onSwapLangs: () => void;
  onStart: () => void;
  darkMode: boolean;
  onToggleDark: () => void;
};

const CAPABILITIES = [
  {
    title: "本机转写",
    desc: "语音先在本机识别",
    icon: AudioWaveform,
    tone: "bg-violet-100 text-violet-600",
  },
  {
    title: "语言方向",
    desc: "顶部随时切换",
    icon: Languages,
    tone: "bg-emerald-100 text-emerald-600",
  },
  {
    title: "会话文本",
    desc: "原文和译文分区显示",
    icon: FileText,
    tone: "bg-amber-100 text-amber-600",
  },
  {
    title: "导出整理",
    desc: "保存为 Markdown",
    icon: Download,
    tone: "bg-sky-100 text-sky-600",
  },
];

export function LandingPage({
  sourceLang,
  targetLang,
  onSourceChange,
  onTargetChange,
  onSwapLangs,
  onStart,
  darkMode,
  onToggleDark,
}: Props) {
  const surface = darkMode ? "bg-slate-950 text-slate-100" : "bg-[#fafbfc] text-slate-900";
  const headerBg = darkMode ? "border-slate-800 bg-slate-900/90" : "border-slate-200/90 bg-white/90";
  const cardBg = darkMode
    ? "border-slate-700/80 bg-slate-900/60 shadow-none"
    : "border-slate-200/80 bg-white shadow-sm";
  const subtext = darkMode ? "text-slate-400" : "text-slate-500";

  return (
    <div className={`relative flex h-full min-h-0 flex-col ${surface}`}>
      <header className={`relative z-10 shrink-0 border-b backdrop-blur-md ${headerBg}`}>
        <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 sm:px-6 md:px-10 lg:grid-cols-[1fr_auto_1fr]">
          <div className="hidden lg:block" aria-hidden />
          <div className="min-w-0 justify-self-center">
            <TopBarLanguages
              variant="toolbar"
              sourceLang={sourceLang}
              targetLang={targetLang}
              onSourceChange={onSourceChange}
              onTargetChange={onTargetChange}
              onSwapLangs={onSwapLangs}
            />
          </div>
          <button
            type="button"
            onClick={onToggleDark}
            className={`relative z-10 shrink-0 justify-self-end rounded-full p-2.5 transition ${
              darkMode
                ? "bg-slate-800 text-amber-300 hover:bg-slate-700"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            aria-label={darkMode ? "切换为浅色" : "切换为深色"}
            title={darkMode ? "浅色" : "深色"}
          >
            {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full max-w-6xl flex-col px-4 pb-6 pt-5 sm:px-6 md:px-10 md:pb-8 md:pt-6">
          <section className="grid shrink-0 items-center gap-6 md:grid-cols-[1fr_0.9fr] md:gap-8 xl:gap-10">
            <div className="order-2 flex flex-col items-center text-center md:order-1 md:items-start md:text-left">
              <h1 className="max-w-[14ch] bg-gradient-to-br from-sky-600 via-violet-600 to-violet-700 bg-clip-text font-display text-[2.35rem] leading-[1.2] text-transparent sm:max-w-none sm:text-5xl md:text-[3.25rem] md:leading-[1.15]">
                实时转写
                <br />
                即刻翻译
              </h1>
              <p className={`mt-3 max-w-md text-[15px] leading-relaxed sm:text-base ${subtext}`}>
                让声音越过语言，抵达彼此
              </p>
              <button
                type="button"
                onClick={onStart}
                className="mt-6 inline-flex h-[3.25rem] min-w-[13rem] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-10 text-base font-semibold text-white shadow-lg shadow-violet-500/30 ring-1 ring-white/20 transition hover:from-violet-500 hover:to-indigo-500 hover:shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 active:scale-[0.99]"
              >
                <Mic className="h-5 w-5 shrink-0" strokeWidth={2} aria-hidden />
                开始会话
              </button>
              <div className={`mt-4 flex items-center gap-2 text-sm ${subtext}`}>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                麦克风将在开始后请求授权
              </div>
            </div>

            <div className="order-1 flex justify-center md:order-2 md:justify-end">
              <div className="relative aspect-square w-full max-w-[min(100%,18rem)] sm:max-w-[17rem] md:max-w-[18.5rem]">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-200/40 via-sky-100/50 to-transparent blur-2xl" />
                <div className="absolute inset-[8%] rounded-full border border-violet-200/30" />
                <div className="absolute inset-[18%] rounded-full border border-sky-200/25" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <BrandLogo size="lg" />
                </div>
              </div>
            </div>
          </section>

          <section className="mt-6 grid shrink-0 gap-3 sm:grid-cols-2 md:mt-8 md:grid-cols-4 md:gap-4">
            {CAPABILITIES.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className={`rounded-2xl border p-4 ${cardBg}`}>
                  <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${item.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className={`mt-4 text-sm font-semibold ${darkMode ? "text-slate-100" : "text-slate-900"}`}>{item.title}</h3>
                  <p className={`mt-1.5 text-xs leading-relaxed ${subtext}`}>{item.desc}</p>
                </article>
              );
            })}
          </section>
        </div>
      </main>
    </div>
  );
}
