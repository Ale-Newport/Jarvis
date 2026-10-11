import { CircleCheck, CircleX, ExternalLink, FolderSearch, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { Check, ChromeMode, LlmCandidate } from "../../api/types";
import { formatBytes } from "../../lib/format";
import { CHROME_DOWNLOAD_URL, OLLAMA_DOWNLOAD_URL } from "../../lib/links";
import { DEFAULT_PULL_MODEL, presetFor } from "../../lib/llm";
import { openExternal, pickChromeApp } from "../../lib/tauri";
import { selectUnsupported, useApp } from "../../store";
import { useUi } from "../../store/ui";
import { Markdown } from "../Markdown";
import { Button } from "../ui/Button";
import { Segmented, TextInput } from "../ui/controls";
import { Spinner, ProgressBar, StatusDot } from "../ui/feedback";
import { UnsupportedScreen } from "./UnsupportedScreen";

type Kind = "download_laya" | "connect" | "text_model" | "chrome" | "settings" | null;

function actionKind(check: Check): Kind {
  const id = check.action?.id ?? "";
  if (id === "download_laya" || id === "load_laya") return "download_laya";
  if (id === "connect_chrome" || id === "chrome_connect" || id === "connect") return "connect";
  if (check.id === "laya_model") return check.action ? "download_laya" : null;
  if (check.id === "chrome_connection") return "connect";
  if (check.id === "text_model") return "text_model";
  if (check.id === "chrome") return "chrome";
  if (id === "open_settings") return "settings";
  return null;
}

function StatusIcon({ status }: { status: Check["status"] }) {
  switch (status) {
    case "ok":
      return <CircleCheck size={20} className="text-ok" />;
    case "warn":
      return <TriangleAlert size={20} className="text-warn" />;
    case "error":
      return <CircleX size={20} className="text-danger" />;
    default:
      return <Spinner size={18} className="text-fg-3" />;
  }
}

function Row({ check, action, children }: { check: Check; action?: ReactNode; children?: ReactNode }) {
  return (
    <li className="px-4 py-3" data-check={check.id} data-status={check.status}>
      <div className="flex items-start gap-3">
        <span className="mt-px flex size-6 shrink-0 items-center justify-center">
          <StatusIcon status={check.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{check.title}</div>
          <div className="selectable mt-0.5 text-[12.5px] leading-snug text-fg-3">{check.detail}</div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3 pl-9">{children}</div>}
    </li>
  );
}

function LayaProgress() {
  const p = useApp((s) => s.layaDownload);
  const laya = useApp((s) => s.laya);
  const active = laya?.state === "downloading" || (!!p && !p.done);
  if (!active) return null;
  const pct = p && p.total > 0 ? p.bytes / p.total : undefined;
  return (
    <div>
      <ProgressBar value={pct} indeterminate={pct == null} />
      <div className="mt-1.5 flex justify-between text-[12px] text-fg-3 tabular-nums">
        <span className="truncate">{p?.file ?? "Preparing…"}</span>
        <span>{p && p.total > 0 ? `${formatBytes(p.bytes)} / ${formatBytes(p.total)} · ${Math.round((p.bytes / p.total) * 100)}%` : ""}</span>
      </div>
    </div>
  );
}

function TextModelSetup({ recheck }: { recheck: () => Promise<unknown> }) {
  const settings = useApp((s) => s.settings);
  const llm = useApp((s) => s.llm);
  const pull = useApp((s) => s.llmPull);
  const save = useApp((s) => s.saveSettings);
  const notify = useApp((s) => s.notify);
  const notifyError = useApp((s) => s.notifyError);
  const refreshLlm = useApp((s) => s.refreshLlm);
  const openSettings = useUi((s) => s.openSettings);
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<LlmCandidate[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState(settings?.llm.model || DEFAULT_PULL_MODEL);
  const [pulling, setPulling] = useState(false);

  const pullActive = pulling || (!!pull && !pull.done && !pull.error);
  const pct = pull && pull.total > 0 ? pull.completed / pull.total : undefined;
  const provider = settings?.llm.provider;

  const detect = async () => {
    setDetecting(true);
    try {
      const r = await api.llmDetect();
      setFound(r.candidates);
      const best = r.candidates.find((c) => c.reachable && c.models.length > 0);
      if (best) {
        await save({ llm: { provider: (presetFor(best.provider)?.id ?? "custom") as never, base_url: best.base_url, model: best.models[0]! } });
        await refreshLlm();
        await recheck();
      } else if (!r.candidates.some((c) => c.reachable)) notify("info", "No local model server is running yet. Start Ollama, or pick another provider.");
    } catch (e) {
      notifyError(e, "Auto-detect failed");
    } finally {
      setDetecting(false);
    }
  };

  const startOllama = async () => {
    setStarting(true);
    try {
      const r = await api.ollamaStart();
      if (!r.ok) notify("warn", "Couldn't start Ollama. Install it first, then try again.");
      await new Promise((res) => setTimeout(res, 1500));
      await refreshLlm();
      await recheck();
    } catch (e) {
      notifyError(e, "Couldn't start Ollama");
    } finally {
      setStarting(false);
    }
  };

  const startPull = async () => {
    setPulling(true);
    useApp.setState({ llmPull: { status: "starting", completed: 0, total: 0, done: false } });
    try {
      await save({ llm: { model: name.trim() } });
      await api.llmPull(name.trim());
    } catch (e) {
      notifyError(e, "Couldn't pull the model");
      useApp.setState({ llmPull: null });
    } finally {
      setPulling(false);
    }
  };

  // finished pull -> re-check
  useEffect(() => {
    if (pull?.done && !pull.error) void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull?.done]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} loading={detecting} onClick={() => void detect()}>
          Detect local models
        </Button>
        {provider === "ollama" && llm && !llm.reachable && (
          <Button size="sm" loading={starting} onClick={() => void startOllama()}>
            Start Ollama
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void openExternal(OLLAMA_DOWNLOAD_URL)}>
          Get Ollama
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openSettings("model")}>
          Use another provider…
        </Button>
      </div>
      {found && found.length > 0 && (
        <div className="space-y-1 text-[12.5px] text-fg-2">
          {found.map((c) => (
            <div key={c.base_url} className="flex items-center gap-2">
              <StatusDot status={c.reachable ? "ok" : "error"} />
              <span className="font-medium">{presetFor(c.provider)?.label ?? c.provider}</span>
              <span className="text-fg-3">{c.reachable ? `${c.models.length} model${c.models.length === 1 ? "" : "s"}` : "not running"}</span>
            </div>
          ))}
        </div>
      )}
      {provider === "ollama" && (
        <div>
          <div className="mb-1.5 text-[12px] text-fg-3">Or download a model with Ollama:</div>
          <div className="flex gap-2">
            <TextInput className="max-w-[240px] font-mono text-[12.5px]" value={name} onChange={(e) => setName(e.target.value)} placeholder={DEFAULT_PULL_MODEL} />
            <Button size="sm" className="h-8" loading={pullActive} disabled={!name.trim() || (llm ? !llm.reachable : false)} onClick={() => void startPull()}>
              Pull model
            </Button>
          </div>
          {pull && (pullActive || pull.error) && (
            <div className="mt-2.5">
              <ProgressBar value={pull.done ? 1 : pct} indeterminate={!pull.done && pct == null} />
              <div className={`mt-1.5 flex justify-between text-[12px] tabular-nums ${pull.error ? "text-danger" : "text-fg-3"}`}>
                <span className="truncate">{pull.error ?? pull.status}</span>
                {pull.total > 0 && <span>{formatBytes(pull.completed)} / {formatBytes(pull.total)}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChromeSetup({ recheck, withConnect }: { recheck: () => Promise<unknown>; withConnect: boolean }) {
  const settings = useApp((s) => s.settings);
  const chrome = useApp((s) => s.chrome);
  const busy = useApp((s) => s.chromeBusy);
  const connect = useApp((s) => s.chromeConnect);
  const setMode = useApp((s) => s.saveSettings);
  const notifyError = useApp((s) => s.notifyError);
  const mode: ChromeMode = settings?.chrome.mode ?? "managed";

  const choose = async () => {
    try {
      const p = await pickChromeApp();
      if (!p) return;
      useApp.setState({ chrome: await api.chromeSetPath(p) });
      await recheck();
    } catch (e) {
      notifyError(e, "That doesn't look like Google Chrome");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<ChromeMode>
          value={mode}
          disabled={busy}
          onChange={(m) => void setMode({ chrome: { mode: m } })}
          options={[
            { value: "managed", label: "Automation profile" },
            { value: "existing", label: "Existing Chrome" },
          ]}
        />
        {withConnect ? (
          <Button
            size="sm"
            variant="primary"
            loading={busy || chrome?.state === "connecting" || chrome?.state === "awaiting_permission"}
            onClick={async () => {
              await connect(mode);
              await recheck();
            }}
          >
            {chrome?.state === "awaiting_permission" ? "Waiting for Chrome…" : "Connect to Chrome"}
          </Button>
        ) : (
          <>
            {chrome && !chrome.installed && (
              <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} onClick={() => void openExternal(CHROME_DOWNLOAD_URL)}>
                Get Google Chrome
              </Button>
            )}
            <Button size="sm" icon={<FolderSearch size={13} />} onClick={() => void choose()}>
              Choose Chrome…
            </Button>
          </>
        )}
      </div>
      <p className="text-[12.5px] leading-snug text-fg-3">
        {mode === "managed"
          ? "Recommended: Jarvis opens a separate Chrome window with its own profile. Your tabs and sign-ins stay private."
          : "Jarvis drives the Chrome you already use, including your sign-ins. Chrome will ask you to allow remote debugging."}
      </p>
      {withConnect && chrome?.state === "awaiting_permission" && (
        <div className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-fg">
          Chrome is asking <b>“Allow remote debugging?”</b>. Switch to Chrome and click <b>Allow</b>.
        </div>
      )}
      {withConnect && mode === "existing" && chrome?.debugging === "off" && chrome.how_to_enable && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <Markdown text={chrome.how_to_enable} compact />
        </div>
      )}
      {withConnect && chrome?.error && <div className="text-[12.5px] text-danger">{chrome.error}</div>}
    </div>
  );
}

export function Onboarding() {
  const result = useApp((s) => s.onboarding);
  const checking = useApp((s) => s.onboardingChecking);
  const unsupported = useApp(selectUnsupported);
  const recheck = useApp((s) => s.runOnboardingCheck);
  const finish = useApp((s) => s.finishOnboarding);
  const notifyError = useApp((s) => s.notifyError);
  const layaDone = useApp((s) => s.layaDownload?.done);
  const laya = useApp((s) => s.laya);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!result && !checking) void recheck();
  }, [result, checking, recheck]);

  // a finished model download changes the picture: look again
  useEffect(() => {
    if (layaDone) void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layaDone]);

  const siliconCheck = result?.checks.find((c) => c.id === "apple_silicon" && c.status === "error");
  const blocked = unsupported ?? (siliconCheck ? siliconCheck.detail : null);
  if (blocked) return <UnsupportedScreen reason={blocked} />;

  const checks = result?.checks ?? [];
  const hasError = checks.some((c) => c.status === "error");
  const ready = !!result?.ready;
  const canContinue = ready || (!!result && !hasError);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  const downloadLaya = () =>
    run("laya", async () => {
      useApp.setState({ laya: await api.layaDownload() });
    });

  return (
    <div className="relative flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-[52px]" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 pt-14 pb-6">
          <div className="anim-fade text-center">
            <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: "linear-gradient(135deg, #8a8ffb, #4b45df)" }}>
              <Sparkles size={22} />
            </span>
            <h1 className="text-[24px] font-semibold tracking-tight">Welcome to Jarvis</h1>
            <p className="mx-auto mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-fg-2">
              Let's make sure everything Jarvis needs is ready on this Mac. It only takes a minute, and everything runs locally.
            </p>
          </div>

          <ul className="anim-slide mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" aria-label="Setup checks">
            {checks.length === 0 && (
              <li className="flex items-center gap-2.5 px-4 py-5 text-[13px] text-fg-3">
                <Spinner size={14} /> Checking your Mac…
              </li>
            )}
            {checks.map((check) => {
              const kind = actionKind(check);
              const needsAction = check.status !== "ok";
              let action: ReactNode = null;
              let extra: ReactNode = null;

              if (needsAction && kind === "download_laya" && check.action) {
                action = (
                  <Button size="sm" variant="primary" loading={busy === "laya" || laya?.state === "downloading"} onClick={() => void downloadLaya()}>
                    {check.action.label}
                  </Button>
                );
                extra = <LayaProgress />;
              } else if (needsAction && kind === "connect") {
                extra = <ChromeSetup recheck={recheck} withConnect />;
              } else if (needsAction && kind === "text_model") {
                extra = <TextModelSetup recheck={recheck} />;
              } else if (needsAction && kind === "chrome") {
                extra = <ChromeSetup recheck={recheck} withConnect={false} />;
              } else if (needsAction && check.action) {
                action = (
                  <Button size="sm" onClick={() => useUi.getState().openSettings()}>
                    {check.action.label}
                  </Button>
                );
              }
              return (
                <Row key={check.id} check={check} action={action}>
                  {extra}
                </Row>
              );
            })}
          </ul>
        </div>
      </div>

      {/* pinned footer: the way forward is always visible, whatever the window height */}
      <div className="shrink-0 border-t border-line bg-bg/90 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[592px] items-center justify-between gap-3">
          <Button icon={<RefreshCw size={14} className={checking ? "anim-spin" : ""} />} disabled={checking} onClick={() => void recheck()}>
            Re-check
          </Button>
          <div className="flex items-center gap-3">
            {!ready && hasError && <span className="text-[12.5px] text-fg-3">Fix the red items to continue.</span>}
            {ready ? (
              <Button variant="primary" className="h-9 px-5" onClick={finish}>
                Open Jarvis
              </Button>
            ) : (
              <Button variant={canContinue ? "secondary" : "primary"} className="h-9 px-5" disabled={!canContinue} onClick={finish}>
                Continue anyway
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
