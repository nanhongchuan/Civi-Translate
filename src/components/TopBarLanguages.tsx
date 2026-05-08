import * as Select from "@radix-ui/react-select";
import { ArrowLeftRight, ChevronDown } from "lucide-react";

const selectTriggerClass =
  "inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition hover:border-slate-300 hover:bg-slate-50/80 focus-visible:ring-2 focus-visible:ring-violet-400/50 data-[state=open]:border-violet-300 data-[state=open]:ring-1 data-[state=open]:ring-violet-200";

const selectContentClass =
  "z-50 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 text-sm text-slate-800 shadow-card";

type Props = {
  sourceLang: string;
  targetLang: string;
  onSourceChange: (v: string) => void;
  onTargetChange: (v: string) => void;
  compact?: boolean;
  /** 工具栏：居中、无「语言」前缀，中间为交换按钮 */
  variant?: "default" | "toolbar";
  onSwapLangs?: () => void;
};

const LANGS = [
  { value: "auto", label: "自动检测" },
  { value: "en", label: "英语" },
  { value: "zh", label: "中文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
] as const;

const TARGET_LANGS = LANGS.filter((l) => l.value !== "auto");

export function getLangLabel(value: string): string {
  const row = LANGS.find((l) => l.value === value);
  return row?.label ?? value;
}

/** 供翻译 API 使用的无歧义英文目标语名称，避免多语 UI 标签导致模型跟错目标语 */
export function getLangLlmName(value: string): string {
  const map: Record<string, string> = {
    auto: "auto-detect",
    en: "English",
    zh: "Simplified Chinese",
    ja: "Japanese",
    ko: "Korean",
  };
  return map[value] ?? getLangLabel(value);
}

function LangSelect({
  value,
  onChange,
  ariaLabel,
  options = LANGS,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  options?: readonly { value: string; label: string }[];
}) {
  const current = options.find((l) => l.value === value)?.label ?? getLangLabel(value);
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className={selectTriggerClass} aria-label={ariaLabel}>
        <Select.Value>{current}</Select.Value>
        <Select.Icon>
          <ChevronDown className="h-4 w-4 text-slate-400" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={selectContentClass} position="popper" sideOffset={6}>
          <Select.Viewport className="p-0.5">
            {options.map((l) => (
              <Select.Item
                key={l.value}
                value={l.value}
                className="relative flex cursor-pointer select-none items-center rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-violet-50 data-[state=checked]:font-semibold data-[state=checked]:text-violet-900"
              >
                <Select.ItemText>{l.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function TopBarLanguages({
  sourceLang,
  targetLang,
  onSourceChange,
  onTargetChange,
  compact,
  variant = "default",
  onSwapLangs,
}: Props) {
  const isToolbar = variant === "toolbar";

  return (
    <div
      className={`min-w-0 ${isToolbar ? "w-full max-w-[min(100%,28rem)]" : ""} ${compact ? "" : isToolbar ? "" : "md:gap-4"}`}
    >
      {!compact && !isToolbar && (
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">语言</span>
      )}
      <div
        className={`grid min-w-0 grid-cols-[minmax(5.75rem,1fr)_auto_minmax(5.75rem,1fr)] items-center gap-1.5 rounded-2xl border border-slate-200/90 bg-white/90 p-1.5 shadow-sm ${isToolbar ? "ring-1 ring-slate-100 max-[560px]:grid-cols-[minmax(0,1fr)_auto] max-[560px]:[&>*:last-child]:col-span-2" : "bg-slate-50/90 shadow-soft"}`}
      >
        <LangSelect value={sourceLang} onChange={onSourceChange} ariaLabel="源语言" />
        {onSwapLangs ? (
          <button
            type="button"
            onClick={onSwapLangs}
            className="rounded-lg p-2 text-slate-500 transition hover:bg-violet-50 hover:text-violet-700"
            aria-label="交换源语言与目标语言"
          >
            <ArrowLeftRight className="h-4 w-4" />
          </button>
        ) : (
          <span className="select-none px-0.5 text-sm text-slate-400">→</span>
        )}
        <LangSelect
          value={targetLang}
          onChange={onTargetChange}
          ariaLabel="目标语言"
          options={TARGET_LANGS}
        />
      </div>
    </div>
  );
}
