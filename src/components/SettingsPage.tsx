import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Brain, CheckCircle2, ChevronDown, Cloud, Download, Eye, EyeOff, Mic, Pencil, Trash2 } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Label from "@radix-ui/react-label";

import { apiUrl } from "../apiBase";

const LLM_VENDORS = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "claudecode-compatible", label: "Claudecode 兼容" },
] as const;

type LlmGetResponse = {
  vendor: string;
  base_url: string;
  model: string;
  api_key_configured: boolean;
  api_key_tail: string | null;
};

type AsrOnlineGetResponse = {
  base_url: string;
  model: string;
  api_key_configured: boolean;
  api_key_tail: string | null;
  language_hint?: string | null;
};

type PromptGetResponse = {
  system_prompt: string;
  default_system_prompt: string;
};

const LLM_SETTINGS_PATH = "/api/settings/llm";
const LLM_TEST_PATH = "/api/settings/llm/test";
const PROMPT_SETTINGS_PATH = "/api/settings/prompt";
const ASR_MODELS_PATH = "/api/asr/models";
const ASR_ONLINE_SETTINGS_PATH = "/api/settings/asr-online";
const ASR_ONLINE_TEST_PATH = "/api/settings/asr-online/test";
const PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v2";
const WHISPER_MODEL_ID = "faster-whisper-medium";
const ONLINE_ASR_MODEL_ID = "online-asr-api";
const ASR_CURRENT_ENGINE_KEY = "rt_asr_current_engine_v1";

/** 本地 session 草稿：断网、保存失败或刷新后尽量保留已填内容（单用户本机场景）。 */
const LLM_DRAFT_KEY = "rt_llm_settings_draft_v1";
const DRAFT_FRESH_MS = 3 * 60 * 1000;

type LlmDraftStored = {
  v: 1;
  vendor: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: number;
};

function readLlmDraft(): LlmDraftStored | null {
  try {
    const raw = sessionStorage.getItem(LLM_DRAFT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<LlmDraftStored>;
    if (o.v !== 1 || typeof o.updatedAt !== "number") return null;
    return {
      v: 1,
      vendor: typeof o.vendor === "string" ? o.vendor : "openai-compatible",
      baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
      model: typeof o.model === "string" ? o.model : "",
      apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
      updatedAt: o.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeLlmDraft(p: { vendor: string; baseUrl: string; model: string; apiKey: string }): void {
  try {
    const payload: LlmDraftStored = {
      v: 1,
      vendor: p.vendor,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: p.apiKey,
      updatedAt: Date.now(),
    };
    sessionStorage.setItem(LLM_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式或配额
  }
}

function clearLlmDraft(): void {
  try {
    sessionStorage.removeItem(LLM_DRAFT_KEY);
  } catch {
    // ignore
  }
}

function readCachedAsrEngine(): string | null {
  try {
    const raw = localStorage.getItem(ASR_CURRENT_ENGINE_KEY);
    return raw === "parakeet" || raw === "faster_whisper" || raw === "online_api" ? raw : null;
  } catch {
    return null;
  }
}

function writeCachedAsrEngine(engine: string | null | undefined): void {
  try {
    if (engine) {
      localStorage.setItem(ASR_CURRENT_ENGINE_KEY, engine);
    } else {
      localStorage.removeItem(ASR_CURRENT_ENGINE_KEY);
    }
  } catch {
    // ignore
  }
}

function engineForAsrModelId(modelId: string): string | null {
  if (modelId === PARAKEET_MODEL_ID) return "parakeet";
  if (modelId === WHISPER_MODEL_ID) return "faster_whisper";
  if (modelId === ONLINE_ASR_MODEL_ID) return "online_api";
  return null;
}

function formatApiErrorDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          return String((item as { msg?: string }).msg ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("；");
  }
  if (detail != null && typeof detail === "object") {
    try {
      return JSON.stringify(detail).slice(0, 300);
    } catch {
      return "操作失败";
    }
  }
  return "操作失败";
}

type LlmActionBody = { ok?: boolean; message?: string; detail?: unknown };

type AsrModelStatus = {
  id: string;
  engine: string;
  name: string;
  model: string;
  installed: boolean;
  installing: boolean;
  status: string;
  message?: string;
  error?: string;
};

/** 解析 FastAPI JSON 或非 JSON（代理 HTML 等），避免误显示「操作失败」。 */
async function readLlmActionBody(r: Response): Promise<LlmActionBody> {
  const text = await r.text();
  const t = text.trim();
  if (!t) return {};
  try {
    return JSON.parse(text) as LlmActionBody;
  } catch {
    return { detail: t.length > 400 ? `${t.slice(0, 400)}…` : t };
  }
}

function messageForLlmApiFailure(status: number, detail: unknown): string {
  if (status === 404 || detail === "Not Found") {
    return "本机未提供该 LLM 接口，或 18787 上仍是未包含「测试连接」等路由的旧版 API。请结束占端口的旧 uvicorn 后，在项目根目录执行 npm run api（与 npm run dev 同时运行）再重试。若用生产包预览，请配置 VITE_API_BASE 或反代 /api。";
  }
  return formatApiErrorDetail(detail);
}

/** 本机 18787 有进程但为旧版 API（无 LLM 设置路由）时给出明确提示。 */
async function messageIfStaleLlmProcess(): Promise<string | null> {
  try {
    const h = await fetch(apiUrl("/api/health"), {
      cache: "no-store",
    });
    if (!h.ok) return null;
    const j = (await h.json()) as {
      ok?: boolean;
      service?: string;
      llm_settings?: boolean;
    };
    if (j.ok === true && j.service === "realtime-translate-api" && j.llm_settings !== true) {
      return "本机 18787 上仍是旧版 API 进程，没有 LLM 设置接口。请结束占用该端口的旧 uvicorn 后，在本项目根目录重新执行 npm run api。";
    }
  } catch {
    // 不可达
  }
  return null;
}

/** 「测试连接」POST 返回 404：多为 18787 上旧版 uvicorn 无该路由。 */
async function messageForLlmTestRoute404(): Promise<string> {
  const stale = await messageIfStaleLlmProcess();
  if (stale) return stale;
  try {
    const h = await fetch(apiUrl("/api/health"), { cache: "no-store" });
    if (!h.ok) {
      return messageForLlmApiFailure(404, "Not Found");
    }
    const j = (await h.json()) as { llm_test?: boolean };
    if (j.llm_test !== true) {
      return "本机 18787 上的 API 仍是旧版，没有「测试连接」路由。请在运行它的终端按 Ctrl+C 结束进程，在项目根目录重新执行 npm run api；再执行 npm run api:verify 应输出 OK，然后刷新本页后重试。";
    }
  } catch {
    // ignore
  }
  return messageForLlmApiFailure(404, "Not Found");
}

function LlmSettingsSection() {
  const [vendor, setVendor] = useState("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  /** 为 false 且本机已存 Key 时显示占位条；为 true 时显示真实输入框。 */
  const [apiKeyEditing, setApiKeyEditing] = useState(false);
  /** 编辑模式下：眼睛切换明文 / 密文。 */
  const [showKeyPlaintext, setShowKeyPlaintext] = useState(false);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const [apiKeyTail, setApiKeyTail] = useState<string | null>(null);
  /** 未连上本机 API 时的说明（非“报错”，不阻断填表与后续保存） */
  const [loadInfo, setLoadInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadInfo(null);
      const applyDraftIfAny = () => {
        const draft = readLlmDraft();
        if (!draft) return;
        setVendor(
          LLM_VENDORS.some((v) => v.value === draft.vendor)
            ? draft.vendor
            : "openai-compatible",
        );
        setBaseUrl(draft.baseUrl);
        setModel(draft.model);
        setApiKey(draft.apiKey);
        setApiKeyEditing(!!draft.apiKey.trim());
        setShowKeyPlaintext(false);
      };
      /**
       * 保存成功后 debounce 会在 session 里写入「与当前表单一致 + 空 Key」的草稿；若刷新时仍新鲜，
       * 不得用该草稿盖掉服务端已持久化的 Base URL / 模型（否则测试/再保存会用到空或旧值）。
       */
      const applyFreshDraftOverServer = (server: LlmGetResponse) => {
        const draft = readLlmDraft();
        if (!draft || Date.now() - draft.updatedAt >= DRAFT_FRESH_MS) return;
        const sameAsServer =
          draft.baseUrl.trim() === (server.base_url ?? "").trim() &&
          draft.model.trim() === (server.model ?? "").trim() &&
          draft.vendor === server.vendor;
        if (server.api_key_configured && !draft.apiKey.trim() && sameAsServer) {
          return;
        }
        setVendor(
          LLM_VENDORS.some((v) => v.value === draft.vendor)
            ? draft.vendor
            : "openai-compatible",
        );
        setBaseUrl(draft.baseUrl);
        setModel(draft.model);
        if (!server.api_key_configured) {
          setApiKey(draft.apiKey);
          setApiKeyEditing(true);
          setShowKeyPlaintext(false);
        } else if (draft.apiKey.trim()) {
          setApiKey(draft.apiKey);
          setApiKeyEditing(true);
          setShowKeyPlaintext(false);
        }
      };
      try {
        const r = await fetch(apiUrl(LLM_SETTINGS_PATH));
        if (!r.ok) {
          if (!cancelled) {
            const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
            setLoadInfo(
              stale ??
                "当前未连上本机服务，因此暂时读不到已保存的 LLM 配置。请在项目根目录另开终端执行 npm run api，与 npm run dev 同时保持运行，然后刷新本页。",
            );
            applyDraftIfAny();
          }
          return;
        }
        const d = (await r.json()) as LlmGetResponse;
        if (cancelled) return;
        setVendor(
          LLM_VENDORS.some((v) => v.value === d.vendor) ? d.vendor : "openai-compatible",
        );
        setBaseUrl(d.base_url ?? "");
        setModel(d.model ?? "");
        setHasStoredKey(!!d.api_key_configured);
        setApiKeyTail(d.api_key_tail);
        setLoadInfo(null);
        applyFreshDraftOverServer(d);
        if (d.api_key_configured) {
          const draft = readLlmDraft();
          const fresh = draft && Date.now() - draft.updatedAt < DRAFT_FRESH_MS;
          const draftHasKey = Boolean(fresh && draft.apiKey.trim());
          if (!draftHasKey) {
            setApiKey("");
            setApiKeyEditing(false);
          } else {
            setApiKeyEditing(true);
          }
          setShowKeyPlaintext(false);
        } else {
          setApiKeyEditing(true);
        }
      } catch {
        if (!cancelled) {
          setLoadInfo(
            "网络未通或本机 API 未启动，暂时读不到已保存项。在根目录执行 npm run api 并保持运行，再刷新本页即可。",
          );
          applyDraftIfAny();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const t = window.setTimeout(() => {
      writeLlmDraft({ vendor, baseUrl, model, apiKey });
    }, 400);
    return () => window.clearTimeout(t);
  }, [vendor, baseUrl, model, apiKey, loading]);

  const save = useCallback(async () => {
    setSaveOk(null);
    setSaveError(null);
    setSaving(true);
    try {
      const r = await fetch(apiUrl(LLM_SETTINGS_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor,
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key: apiKey,
        }),
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
        setSaveError(
          stale ?? messageForLlmApiFailure(r.status, j.detail),
        );
        return;
      }
      if (j.ok) {
        clearLlmDraft();
        setSaveOk("已保存到本机。");
        setApiKey("");
        setApiKeyEditing(false);
        setShowKeyPlaintext(false);
        setHasStoredKey(true);
        setLoadInfo(null);
        const r2 = await fetch(apiUrl(LLM_SETTINGS_PATH));
        if (r2.ok) {
          const d = (await r2.json()) as LlmGetResponse;
          setApiKeyTail(d.api_key_tail);
        }
        window.setTimeout(() => setSaveOk(null), 5000);
      } else {
        setSaveError("保存返回异常，请重试或查看本机 API 终端输出。");
      }
    } catch {
      setSaveError("网络错误，请重试。");
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, model, vendor]);

  const testConnection = useCallback(async () => {
    setTestOk(null);
    setTestError(null);
    setTesting(true);
    try {
      const r = await fetch(apiUrl(LLM_TEST_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor,
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key: apiKey,
        }),
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        if (r.status === 404) {
          setTestError(await messageForLlmTestRoute404());
        } else {
          setTestError(messageForLlmApiFailure(r.status, j.detail));
        }
        return;
      }
      if (j.ok) {
        setTestOk(
          typeof j.message === "string" && j.message
            ? j.message
            : "连接成功。",
        );
        return;
      }
      setTestError("测试返回异常，请重试。");
    } catch {
      setTestError("网络错误。请确认已执行 npm run api，且与 npm run dev 同时运行。");
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, model, vendor]);

  const showStoredKeyBar = hasStoredKey && !apiKey.trim() && !apiKeyEditing;

  return (
    <section className="box-border w-full min-w-0 max-w-full rounded-2xl border border-slate-200/90 bg-white p-6 shadow-soft md:p-8">
      <p className="text-sm leading-relaxed text-slate-500">
        用于生成会话译文；API Key 仅保存在本机。
      </p>
      {loadInfo && (
        <p className="mt-2 rounded-lg border border-slate-200/90 bg-slate-100/90 px-3 py-2 text-sm leading-relaxed text-slate-600">
          {loadInfo}
        </p>
      )}
      {saveError && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {saveError}
        </p>
      )}
      {saveOk && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {saveOk}
        </p>
      )}
      {testError && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {testError}
        </p>
      )}
      {testOk && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {testOk}
        </p>
      )}
      <div className="mt-6 grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-[minmax(0,132px)_minmax(0,1fr)] sm:items-start">
        <div className="min-w-0">
          <Label.Root className="text-xs font-medium text-slate-600">兼容模式</Label.Root>
          <div className="relative mt-1.5">
            <select
              className="mt-0 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-3 pr-10 text-sm text-slate-800 outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              disabled={loading}
              aria-label="兼容模式"
            >
              {LLM_VENDORS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <Label.Root className="text-xs font-medium text-slate-600">
              API Key <span className="text-rose-500">*</span>
            </Label.Root>
            {showStoredKeyBar ? (
              <div className="relative mt-1.5 w-full min-w-0">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setApiKeyEditing(true);
                    setApiKey("");
                    setShowKeyPlaintext(false);
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    });
                  }}
                  className="flex w-full min-w-0 items-center rounded-xl border border-slate-200 bg-slate-50/90 py-2.5 pl-3 pr-12 text-left text-sm outline-none transition hover:border-slate-300 hover:bg-slate-50 focus-visible:border-violet-300 focus-visible:ring-2 focus-visible:ring-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div
                    role="presentation"
                    aria-hidden
                    className="pointer-events-none min-h-[18px] min-w-0 flex-1 self-stretch rounded-sm"
                    style={{
                      backgroundImage:
                        "radial-gradient(circle at center, rgb(148 163 184) 1.15px, transparent 1.35px)",
                      backgroundSize: "11px 100%",
                      backgroundRepeat: "repeat-x",
                      backgroundPosition: "left center",
                    }}
                  />
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setApiKeyEditing(true);
                    setApiKey("");
                    setShowKeyPlaintext(false);
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    });
                  }}
                  className="absolute inset-y-0 right-1 z-10 flex w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none hover:bg-white/90 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-50"
                  aria-label={
                    apiKeyTail ? `更换已保存密钥，当前尾号 ${apiKeyTail}` : "更换已保存密钥"
                  }
                  title={apiKeyTail ? `更换密钥，当前尾号 ${apiKeyTail}` : "更换密钥"}
                >
                  <Pencil className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                </button>
              </div>
            ) : (
              <div className="relative mt-1.5 w-full min-w-0">
                <input
                  ref={apiKeyInputRef}
                  id="llm-api-key"
                  type={showKeyPlaintext ? "text" : "password"}
                  placeholder={hasStoredKey ? "留空沿用已存密钥；更换请粘贴新 Key" : "sk-..."}
                  className={`box-border w-full min-w-0 rounded-xl border border-slate-200 bg-white py-2.5 pl-3 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50 ${
                    apiKey.trim() ? "pr-12" : "pr-3"
                  }`}
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                  }}
                  onBlur={() => {
                    if (hasStoredKey && !apiKey.trim()) {
                      setApiKeyEditing(false);
                      setShowKeyPlaintext(false);
                    }
                  }}
                  disabled={loading}
                />
                {apiKey.trim() ? (
                  <button
                    type="button"
                    disabled={loading}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setShowKeyPlaintext((v) => !v);
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    }}
                    className="absolute inset-y-0 right-1 z-10 flex w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-50"
                    aria-label={showKeyPlaintext ? "隐藏新 Key" : "显示新 Key"}
                    title={showKeyPlaintext ? "隐藏新 Key" : "显示新 Key"}
                  >
                    {showKeyPlaintext ? <EyeOff className="h-[1.125rem] w-[1.125rem]" /> : <Eye className="h-[1.125rem] w-[1.125rem]" />}
                  </button>
                ) : null}
              </div>
            )}
            {hasStoredKey && apiKeyEditing && !apiKey.trim() ? (
              <p className="mt-1 text-xs text-slate-500">留空并保存将沿用本机已存的完整密钥。</p>
            ) : null}
          </div>
          <div className="min-w-0">
            <Label.Root className="text-xs font-medium text-slate-600" htmlFor="llm-base-url">
              Base URL <span className="text-rose-500">*</span>
            </Label.Root>
            <input
              id="llm-base-url"
              type="url"
              placeholder="https://api.openai.com/v1"
              className="mt-1.5 box-border w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="min-w-0">
            <Label.Root className="text-xs font-medium text-slate-600" htmlFor="llm-model">
              模型 <span className="text-rose-500">*</span>
            </Label.Root>
            <input
              id="llm-model"
              type="text"
              placeholder="gpt-4o-mini"
              className="mt-1.5 box-border w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={save}
          disabled={loading || saving}
          className="rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="rounded-xl border border-slate-200 bg-white px-6 py-2.5 text-sm font-semibold text-slate-700 shadow-soft transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={testConnection}
          disabled={loading || testing || saving}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>
    </section>
  );
}

function AsrOnlineSettingsPanel({
  expanded,
  onExpandedChange,
  onSaved,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSaved?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [languageHint, setLanguageHint] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [apiKeyEditing, setApiKeyEditing] = useState(false);
  const [showKeyPlaintext, setShowKeyPlaintext] = useState(false);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const [apiKeyTail, setApiKeyTail] = useState<string | null>(null);
  const [loadInfo, setLoadInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadInfo(null);
    try {
      const r = await fetch(apiUrl(ASR_ONLINE_SETTINGS_PATH), { cache: "no-store" });
      const j = (await readLlmActionBody(r)) as AsrOnlineGetResponse & LlmActionBody;
      if (!r.ok) {
        const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
        setLoadInfo(
          stale ??
            "当前未连上本机服务，因此暂时读不到已保存的在线转写配置。请先运行 npm run api。",
        );
        return;
      }
      onExpandedChange(Boolean(j.base_url || j.model || j.api_key_configured));
      setBaseUrl(j.base_url ?? "");
      setModel(j.model ?? "");
      setLanguageHint(j.language_hint ?? "");
      setHasStoredKey(!!j.api_key_configured);
      setApiKeyTail(j.api_key_tail);
      setApiKey("");
      setApiKeyEditing(!j.api_key_configured);
      setShowKeyPlaintext(false);
    } catch {
      setLoadInfo(
        "网络未通或本机 API 未启动，暂时读不到已保存项。在根目录执行 npm run api 并保持运行，再刷新本页即可。",
      );
    } finally {
      setLoading(false);
    }
  }, [onExpandedChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaveOk(null);
    setSaveError(null);
    setSaving(true);
    try {
      const r = await fetch(apiUrl(ASR_ONLINE_SETTINGS_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key: apiKey,
          language_hint: languageHint.trim() || undefined,
        }),
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
        setSaveError(stale ?? messageForLlmApiFailure(r.status, j.detail));
        return;
      }
      if (j.ok) {
        setSaveOk("已保存到本机。");
        setApiKey("");
        setApiKeyEditing(false);
        setShowKeyPlaintext(false);
        setHasStoredKey(true);
        setLoadInfo(null);
        await load();
        onSaved?.();
        window.setTimeout(() => setSaveOk(null), 5000);
      } else {
        setSaveError("保存返回异常，请重试或查看本机 API 终端输出。");
      }
    } catch {
      setSaveError("网络错误，请重试。");
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, languageHint, load, model, onSaved]);

  const testConnection = useCallback(async () => {
    setTestOk(null);
    setTestError(null);
    setTesting(true);
    try {
      const r = await fetch(apiUrl(ASR_ONLINE_TEST_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key: apiKey,
          language_hint: languageHint.trim() || undefined,
        }),
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        if (r.status === 404) {
          setTestError(await messageForLlmTestRoute404());
        } else {
          setTestError(messageForLlmApiFailure(r.status, j.detail));
        }
        return;
      }
      if (j.ok) {
        setTestOk(typeof j.message === "string" && j.message ? j.message : "连接成功。");
        return;
      }
      setTestError("测试返回异常，请重试。");
    } catch {
      setTestError("网络错误。请确认已执行 npm run api，且与 npm run dev 同时运行。");
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, languageHint, model]);

  const showStoredKeyBar = hasStoredKey && !apiKey.trim() && !apiKeyEditing;

  if (!expanded) return null;

  return (
    <div className="w-full border-t border-slate-100 bg-slate-50/60 px-4 py-4">
      <p className="text-sm leading-relaxed text-slate-500">
        麦克风音频会由本机后端分段发送到你配置的在线 ASR API；API Key 仅保存在本机。
      </p>
      {loadInfo && (
        <p className="mt-2 rounded-lg border border-slate-200/90 bg-slate-100/90 px-3 py-2 text-sm leading-relaxed text-slate-600">
          {loadInfo}
        </p>
      )}
      {saveError && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {saveError}
        </p>
      )}
      {saveOk && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {saveOk}
        </p>
      )}
      {testError && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {testError}
        </p>
      )}
      {testOk && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {testOk}
        </p>
      )}
      <div className="mt-5 min-w-0 space-y-4">
          <div className="min-w-0">
            <Label.Root className="text-xs font-medium text-slate-600">
              API Key <span className="text-rose-500">*</span>
            </Label.Root>
            {showStoredKeyBar ? (
              <div className="relative mt-1.5 w-full min-w-0">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setApiKeyEditing(true);
                    setApiKey("");
                    setShowKeyPlaintext(false);
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    });
                  }}
                  className="flex w-full min-w-0 items-center rounded-xl border border-slate-200 bg-slate-50/90 py-2.5 pl-3 pr-12 text-left text-sm outline-none transition hover:border-slate-300 hover:bg-slate-50 focus-visible:border-violet-300 focus-visible:ring-2 focus-visible:ring-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div
                    role="presentation"
                    aria-hidden
                    className="pointer-events-none min-h-[18px] min-w-0 flex-1 self-stretch rounded-sm"
                    style={{
                      backgroundImage:
                        "radial-gradient(circle at center, rgb(148 163 184) 1.15px, transparent 1.35px)",
                      backgroundSize: "11px 100%",
                      backgroundRepeat: "repeat-x",
                      backgroundPosition: "left center",
                    }}
                  />
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setApiKeyEditing(true);
                    setApiKey("");
                    setShowKeyPlaintext(false);
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    });
                  }}
                  className="absolute inset-y-0 right-1 z-10 flex w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none hover:bg-white/90 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-50"
                  aria-label={
                    apiKeyTail ? `更换已保存密钥，当前尾号 ${apiKeyTail}` : "更换已保存密钥"
                  }
                  title={apiKeyTail ? `更换密钥，当前尾号 ${apiKeyTail}` : "更换密钥"}
                >
                  <Pencil className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                </button>
              </div>
            ) : (
              <div className="relative mt-1.5 w-full min-w-0">
                <input
                  ref={apiKeyInputRef}
                  type={showKeyPlaintext ? "text" : "password"}
                  placeholder={hasStoredKey ? "留空沿用已存密钥；更换请粘贴新 Key" : "sk-..."}
                  className={`box-border w-full min-w-0 rounded-xl border border-slate-200 bg-white py-2.5 pl-3 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50 ${
                    apiKey.trim() ? "pr-12" : "pr-3"
                  }`}
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => {
                    if (hasStoredKey && !apiKey.trim()) {
                      setApiKeyEditing(false);
                      setShowKeyPlaintext(false);
                    }
                  }}
                  disabled={loading}
                />
                {apiKey.trim() ? (
                  <button
                    type="button"
                    disabled={loading}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setShowKeyPlaintext((v) => !v);
                      requestAnimationFrame(() => apiKeyInputRef.current?.focus());
                    }}
                    className="absolute inset-y-0 right-1 z-10 flex w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-50"
                    aria-label={showKeyPlaintext ? "隐藏新 Key" : "显示新 Key"}
                    title={showKeyPlaintext ? "隐藏新 Key" : "显示新 Key"}
                  >
                    {showKeyPlaintext ? <EyeOff className="h-[1.125rem] w-[1.125rem]" /> : <Eye className="h-[1.125rem] w-[1.125rem]" />}
                  </button>
                ) : null}
              </div>
            )}
            {hasStoredKey && apiKeyEditing && !apiKey.trim() ? (
              <p className="mt-1 text-xs text-slate-500">留空并保存将沿用本机已存的完整密钥。</p>
            ) : null}
          </div>
          <div className="min-w-0">
            <Label.Root className="text-xs font-medium text-slate-600">
              Base URL <span className="text-rose-500">*</span>
            </Label.Root>
            <input
              type="url"
              placeholder="https://api.openai.com/v1"
              className="mt-1.5 box-border w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,132px)]">
            <div className="min-w-0">
              <Label.Root className="text-xs font-medium text-slate-600">
                模型 <span className="text-rose-500">*</span>
              </Label.Root>
              <input
                type="text"
                placeholder="whisper-1"
                className="mt-1.5 box-border w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="min-w-0">
              <Label.Root className="text-xs font-medium text-slate-600">语言提示</Label.Root>
              <input
                type="text"
                placeholder="auto / en / zh"
                className="mt-1.5 box-border w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
                value={languageHint}
                onChange={(e) => setLanguageHint(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            采样率固定由本机后端转换为 16kHz / 16-bit / mono，再发送到在线转写端点。
          </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={save}
          disabled={loading || saving}
          className="rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="rounded-xl border border-slate-200 bg-white px-6 py-2.5 text-sm font-semibold text-slate-700 shadow-soft transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={testConnection}
          disabled={loading || testing || saving}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>
    </div>
  );
}

function AsrSettingsSection() {
  const [models, setModels] = useState<AsrModelStatus[]>([]);
  const [currentEngine, setCurrentEngine] = useState<string | null>(() => readCachedAsrEngine());
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [onlineSettingsExpanded, setOnlineSettingsExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    const r = await fetch(apiUrl(ASR_MODELS_PATH), { cache: "no-store" });
    const j = (await readLlmActionBody(r)) as {
      ok?: boolean;
      current?: { engine?: string };
      models?: AsrModelStatus[];
      detail?: unknown;
    };
    if (!r.ok || !Array.isArray(j.models)) {
      throw new Error(messageForLlmApiFailure(r.status, j.detail));
    }
    const nextEngine = j.current?.engine ?? null;
    setCurrentEngine(nextEngine);
    writeCachedAsrEngine(nextEngine);
    setModels(j.models);
    const running = j.models.find((m) => m.installing);
    setInstallingId(running?.id ?? null);
    const parakeet = j.models.find((m) => m.id === PARAKEET_MODEL_ID);
    if (parakeet?.status === "succeeded" || parakeet?.installed) {
      setMessage(null);
      setError(null);
    } else if (parakeet?.status === "failed") {
      setError(parakeet.error || parakeet.message || "Parakeet 安装失败。");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadModels();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "读取 ASR 状态失败。");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  useEffect(() => {
    if (!installingId) return undefined;
    const id = window.setInterval(() => {
      void loadModels().catch((e) => {
        setError(e instanceof Error ? e.message : "刷新安装状态失败。");
      });
    }, 2500);
    return () => window.clearInterval(id);
  }, [installingId, loadModels]);

  const installModel = useCallback(async (modelId: string) => {
    setError(null);
    setMessage(null);
    setInstallingId(modelId);
    try {
      const r = await fetch(apiUrl(`${ASR_MODELS_PATH}/${modelId}/install`), {
        method: "POST",
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        setInstallingId(null);
        setError(messageForLlmApiFailure(r.status, j.detail));
        return;
      }
      await loadModels();
    } catch (e) {
      setInstallingId(null);
      setError(e instanceof Error ? e.message : "安装请求失败。请确认本机 API 已启动。");
    }
  }, [loadModels]);

  const uninstallModel = useCallback(async (modelId: string) => {
    setError(null);
    setMessage(null);
    setUninstallingId(modelId);
    try {
      const r = await fetch(apiUrl(`${ASR_MODELS_PATH}/${modelId}/uninstall`), {
        method: "POST",
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        setError(messageForLlmApiFailure(r.status, j.detail));
        return;
      }
      await loadModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : "卸载失败。请确认本机 API 正在运行。");
    } finally {
      setUninstallingId(null);
    }
  }, [loadModels]);

  const activateModel = useCallback(async (modelId: string) => {
    setError(null);
    setMessage(null);
    setActivatingId(modelId);
    try {
      const r = await fetch(apiUrl(`${ASR_MODELS_PATH}/${modelId}/activate`), {
        method: "POST",
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        setError(messageForLlmApiFailure(r.status, j.detail));
        return;
      }
      const nextEngine = engineForAsrModelId(modelId);
      setCurrentEngine(nextEngine);
      writeCachedAsrEngine(nextEngine);
      await loadModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : "启用失败。请确认本机 API 正在运行。");
    } finally {
      setActivatingId(null);
    }
  }, [loadModels]);

  const parakeet = models.find((m) => m.id === PARAKEET_MODEL_ID);
  const whisper = models.find((m) => m.id === WHISPER_MODEL_ID);
  const onlineAsr = models.find((m) => m.id === ONLINE_ASR_MODEL_ID);
  const parakeetInstalled = Boolean(parakeet?.installed);
  const whisperInstalled = Boolean(whisper?.installed);
  const onlineConfigured = Boolean(onlineAsr?.installed);
  const parakeetActive = currentEngine === "parakeet";
  const whisperActive = currentEngine === "faster_whisper";
  const onlineActive = currentEngine === "online_api";
  const parakeetInstalling = installingId === PARAKEET_MODEL_ID || Boolean(parakeet?.installing);
  const parakeetUninstalling = uninstallingId === PARAKEET_MODEL_ID;
  const whisperInstalling = installingId === WHISPER_MODEL_ID || Boolean(whisper?.installing);
  const whisperUninstalling = uninstallingId === WHISPER_MODEL_ID;
  const activeButtonClass =
    "inline-flex h-9 w-[104px] items-center justify-center rounded-xl bg-violet-600 px-3 text-xs font-semibold text-white shadow-soft disabled:cursor-default";
  const inactiveButtonClass =
    "inline-flex h-9 w-[104px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-soft transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 disabled:cursor-not-allowed disabled:opacity-50";
  const modelRowClass = "bg-white px-4 py-4";
  const modelInfoRowClass = "grid items-center gap-3 sm:grid-cols-[44px_minmax(0,1fr)_44px_104px]";
  const modelIconClass = "flex h-11 w-11 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-500";
  const modelIconButtonClass = "inline-flex h-9 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-soft transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200/90 bg-white p-6 shadow-soft md:p-8">
        <p className="text-sm text-slate-500">ASR 集成用于语音转文字；本地模型离线运行，在线 API 由本机后端代理请求。</p>
        {error && (
          <p className="mt-3 whitespace-pre-line rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
            {error}
          </p>
        )}
        {message && (
          <p className="mt-3 whitespace-pre-line rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
            {message}
          </p>
        )}
        <ul className="mt-6 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100 bg-slate-50/50">
        <li className={modelRowClass}>
          <div className={modelInfoRowClass}>
            <div className={modelIconClass}>
              <Mic className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">NVIDIA Parakeet · TDT 0.6B v2</p>
              <p className="text-xs text-slate-500">
                英文会议转写优先，低延迟端到端语音识别模型
              </p>
            </div>
            <button
              type="button"
              onClick={() => void (parakeetInstalled ? uninstallModel(PARAKEET_MODEL_ID) : installModel(PARAKEET_MODEL_ID))}
              disabled={loading || parakeetInstalling || parakeetUninstalling}
              className={modelIconButtonClass}
              aria-label={parakeetInstalled ? "卸载 Parakeet" : "安装 Parakeet"}
              title={parakeetUninstalling ? "卸载中" : parakeetInstalling ? "安装中" : parakeetInstalled ? "卸载" : "安装"}
            >
              {parakeetInstalled ? <Trash2 className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => void activateModel(PARAKEET_MODEL_ID)}
              disabled={loading || parakeetActive || activatingId === PARAKEET_MODEL_ID || !parakeetInstalled}
              className={parakeetActive ? activeButtonClass : inactiveButtonClass}
            >
              {parakeetActive ? "已启用" : activatingId === PARAKEET_MODEL_ID ? "启用中…" : "未启用"}
            </button>
          </div>
        </li>
        <li className={modelRowClass}>
          <div className={modelInfoRowClass}>
            <div className={modelIconClass}>
              <Brain className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">faster-whisper · medium</p>
              <p className="text-xs text-slate-500">
                中英混合与离线兼容性更稳
              </p>
            </div>
            <button
              type="button"
              onClick={() => void (whisperInstalled ? uninstallModel(WHISPER_MODEL_ID) : installModel(WHISPER_MODEL_ID))}
              disabled={loading || whisperInstalling || whisperUninstalling}
              className={modelIconButtonClass}
              aria-label={whisperInstalled ? "卸载 faster-whisper" : "安装 faster-whisper"}
              title={whisperUninstalling ? "卸载中" : whisperInstalling ? "安装中" : whisperInstalled ? "卸载" : "安装"}
            >
              {whisperInstalled ? <Trash2 className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => void activateModel(WHISPER_MODEL_ID)}
              disabled={loading || whisperActive || activatingId === WHISPER_MODEL_ID || !whisperInstalled}
              className={whisperActive ? activeButtonClass : inactiveButtonClass}
            >
              {whisperActive ? "已启用" : activatingId === WHISPER_MODEL_ID ? "启用中…" : "未启用"}
            </button>
          </div>
        </li>
        <li className={modelRowClass}>
          <div className={modelInfoRowClass}>
            <div className={modelIconClass}>
              <Cloud className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">在线转写 API</p>
              <p className="text-xs text-slate-500">
                {onlineConfigured
                  ? `已配置 ${onlineAsr?.model || "在线模型"}`
                  : "配置 Base URL / Key / 模型后可启用"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOnlineSettingsExpanded((v) => !v)}
              className={modelIconButtonClass}
              aria-expanded={onlineSettingsExpanded}
              aria-label={onlineSettingsExpanded ? "收起在线转写配置" : "展开在线转写配置"}
              title={onlineSettingsExpanded ? "收起配置" : "展开配置"}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${onlineSettingsExpanded ? "rotate-180" : ""}`} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void activateModel(ONLINE_ASR_MODEL_ID)}
              disabled={loading || onlineActive || activatingId === ONLINE_ASR_MODEL_ID || !onlineConfigured}
              className={onlineActive ? activeButtonClass : inactiveButtonClass}
              title={onlineConfigured ? "启用在线转写 API" : "请先保存在线转写 API 配置"}
            >
              {onlineActive ? "已启用" : activatingId === ONLINE_ASR_MODEL_ID ? "启用中…" : "未启用"}
            </button>
          </div>
          <AsrOnlineSettingsPanel
            expanded={onlineSettingsExpanded}
            onExpandedChange={setOnlineSettingsExpanded}
            onSaved={() => void loadModels()}
          />
        </li>
      </ul>
      </section>
    </div>
  );
}

function PromptSettingsSection() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setMessage(null);
      try {
        const r = await fetch(apiUrl(PROMPT_SETTINGS_PATH), { cache: "no-store" });
        const j = (await readLlmActionBody(r)) as PromptGetResponse & LlmActionBody;
        if (!r.ok) {
          const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
          throw new Error(stale ?? messageForLlmApiFailure(r.status, j.detail));
        }
        if (cancelled) return;
        setSystemPrompt(j.system_prompt ?? "");
        setDefaultSystemPrompt(j.default_system_prompt ?? "");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "读取提示词失败。");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePrompt = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch(apiUrl(PROMPT_SETTINGS_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: systemPrompt.trim() }),
      });
      const j = await readLlmActionBody(r);
      if (!r.ok) {
        const stale = r.status === 404 ? await messageIfStaleLlmProcess() : null;
        setError(stale ?? messageForLlmApiFailure(r.status, j.detail));
        return;
      }
      setMessage("已保存。后续翻译会把它作为系统提示词发送给翻译模型。");
      window.setTimeout(() => setMessage(null), 5000);
    } catch {
      setError("网络错误，请确认本机 API 正在运行。");
    } finally {
      setSaving(false);
    }
  }, [systemPrompt]);

  const resetPrompt = useCallback(() => {
    setSystemPrompt(defaultSystemPrompt);
    setMessage(null);
    setError(null);
  }, [defaultSystemPrompt]);

  return (
    <section className="rounded-2xl border border-slate-200/90 bg-white p-6 shadow-soft md:p-8">
      <p className="text-sm leading-relaxed text-slate-500">
        这里保存的内容会作为翻译请求的系统提示词发送给翻译模型，用于约束输出语言、格式和风格。
      </p>
      {error && (
        <p className="mt-3 whitespace-pre-line rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {error}
        </p>
      )}
      {message && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {message}
        </p>
      )}
      <div className="mt-6 space-y-4">
        <div>
          <Label.Root className="text-xs font-medium text-slate-600" htmlFor="prompt-system">
            系统提示词
          </Label.Root>
          <textarea
            id="prompt-system"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            disabled={loading || saving}
            rows={10}
            className="mt-1.5 box-border w-full min-w-0 resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-700 outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-200 disabled:opacity-50"
          />
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={savePrompt}
          disabled={loading || saving || !systemPrompt.trim()}
          className="rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={resetPrompt}
          disabled={loading || saving || !defaultSystemPrompt}
          className="rounded-xl border border-slate-200 bg-white px-6 py-2.5 text-sm font-semibold text-slate-700 shadow-soft transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          恢复默认
        </button>
      </div>
    </section>
  );
}

type Props = {
  onBack: () => void;
};

export function SettingsPage({ onBack }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-200/90 bg-white shadow-soft">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-5 py-4 md:px-10">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-xl border border-transparent px-2 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">设置</h1>
        </div>
      </header>

      <Tabs.Root defaultValue="asr" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-slate-200/90 bg-white">
          <div className="mx-auto max-w-5xl px-5 py-3 md:px-10">
            <Tabs.List className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-slate-100/90 p-1 ring-1 ring-slate-200/60">
              {[
                { id: "asr", label: "转写模型" },
                { id: "llm", label: "翻译模型" },
                { id: "prompt", label: "提示词" },
                { id: "about", label: "关于" },
              ].map((t) => (
                <Tabs.Trigger
                  key={t.id}
                  value={t.id}
                  className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-slate-600 outline-none transition data-[state=active]:bg-white data-[state=active]:font-semibold data-[state=active]:text-violet-800 data-[state=active]:shadow-soft hover:text-slate-900"
                >
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-50/80">
          <div className="mx-auto box-border w-full min-w-0 max-w-5xl px-5 py-8 md:px-10">
            <Tabs.Content value="asr" className="mx-auto max-w-2xl outline-none">
              <AsrSettingsSection />
            </Tabs.Content>

            <Tabs.Content value="llm" className="mx-auto w-full min-w-0 max-w-2xl space-y-6 outline-none">
              <LlmSettingsSection />
            </Tabs.Content>

            <Tabs.Content value="prompt" className="mx-auto max-w-2xl outline-none">
              <PromptSettingsSection />
            </Tabs.Content>

            <Tabs.Content value="about" className="mx-auto max-w-2xl outline-none">
              <section className="rounded-2xl border border-slate-200/90 bg-white p-6 shadow-soft md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">数据说明</p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-500">
                      版本 UI 原型 0.0.1。本地 ASR 模式下麦克风音频不出网；启用在线转写 API 后，音频会发送到您配置的 ASR 端点。译文文本会发送到您配置的 LLM 端点。
                    </p>
                  </div>
                </div>
              </section>
            </Tabs.Content>
          </div>
        </div>
      </Tabs.Root>
    </div>
  );
}
