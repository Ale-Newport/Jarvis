import { Check, KeyRound, Play, Radar, ShieldAlert, Trash2, Zap, Download } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { LlmCandidate, LlmTestResult } from "../../api/types";
import { PROVIDER_PRESETS, DEFAULT_PULL_MODEL, presetFor } from "../../lib/llm";
import { formatBytes } from "../../lib/format";
import { useApp } from "../../store";
import { Button } from "../ui/Button";
import { CommitInput, Field, Section, Select, TextInput } from "../ui/controls";
import { Chip, ProgressBar, StatusDot } from "../ui/feedback";
import { cx } from "../ui/cx";

/** Prominent, deliberately not dismissable: the user must always know when data leaves the Mac. */
export function RemoteDisclosure({ items, provider }: { items: string[]; provider: string }) {
  return (
    <div role="note" className="mb-5 rounded-xl border-2 border-warn/60 bg-warn-soft p-4" data-testid="remote-disclosure">
      <div className="flex items-start gap-3">
        <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-fg">Your data leaves this Mac</div>
          <p className="mt-0.5 text-[13px] leading-snug text-fg-2">
            The text model is hosted outside your computer ({provider}). While this endpoint is selected, Jarvis sends:
          </p>
          {items.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-snug text-fg">
              {items.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12.5px] text-fg-2">Choose Ollama or LM Studio to keep everything local.</p>
        </div>
      </div>
    </div>
  );
}

export function ModelSettings() {
  const settings = useApp((s) => s.settings!);
  const llm = useApp((s) => s.llm);
  const pull = useApp((s) => s.llmPull);
  const save = useApp((s) => s.saveSettings);
  const saveApiKey = useApp((s) => s.saveApiKey);
  const clearApiKey = useApp((s) => s.clearApiKey);
  const refreshLlm = useApp((s) => s.refreshLlm);
  const notifyError = useApp((s) => s.notifyError);
  const notify = useApp((s) => s.notify);

  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [candidates, setCandidates] = useState<LlmCandidate[] | null>(null);
  const [startingOllama, setStartingOllama] = useState(false);
  const [pullName, setPullName] = useState(settings.llm.model || DEFAULT_PULL_MODEL);
  const [pulling, setPulling] = useState(false);

  const provider = settings.llm.provider;
  const preset = presetFor(provider);
  const remote = llm?.remote === true;
  const models = llm?.models ?? [];
  const pullActive = pulling || (!!pull && !pull.done && !pull.error);

  const selectProvider = (id: typeof provider) => {
    const p = presetFor(id);
    setTestResult(null);
    void save({ llm: { provider: id, ...(p && p.base_url ? { base_url: p.base_url } : {}) } });
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.llmTest());
    } catch (e) {
      setTestResult({ ok: false, latency_ms: 0, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
      void refreshLlm();
    }
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const r = await api.llmDetect();
      setCandidates(r.candidates);
      if (r.candidates.filter((c) => c.reachable).length === 0) notify("info", "No local model server found. Start Ollama or LM Studio and try again.");
    } catch (e) {
      notifyError(e, "Auto-detect failed");
    } finally {
      setDetecting(false);
    }
  };

  const useCandidate = (c: LlmCandidate) => {
    const id = (PROVIDER_PRESETS.find((p) => p.id === c.provider)?.id ?? "custom") as typeof provider;
    void save({ llm: { provider: id, base_url: c.base_url, model: c.models[0] ?? settings.llm.model } });
    setCandidates(null);
  };

  const startOllama = async () => {
    setStartingOllama(true);
    try {
      const r = await api.ollamaStart();
      if (!r.ok) notify("warn", "Couldn't start Ollama. Is it installed?");
      await new Promise((res) => setTimeout(res, 1200));
      await refreshLlm();
    } catch (e) {
      notifyError(e, "Couldn't start Ollama");
    } finally {
      setStartingOllama(false);
    }
  };

  const startPull = async () => {
    if (!pullName.trim()) return;
    setPulling(true);
    useApp.setState({ llmPull: { status: "starting", completed: 0, total: 0, done: false } });
    try {
      await api.llmPull(pullName.trim());
    } catch (e) {
      notifyError(e, "Couldn't pull the model");
      useApp.setState({ llmPull: null });
    } finally {
      setPulling(false);
    }
  };

  const pullPct = pull && pull.total > 0 ? pull.completed / pull.total : undefined;

  return (
    <>
      {remote && <RemoteDisclosure items={llm?.disclosure ?? []} provider={preset?.label ?? llm?.provider ?? "remote provider"} />}

      <Section title="Provider">
        <Field label="Text model provider" help={preset?.hint} stacked>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProvider(p.id)}
                aria-pressed={provider === p.id}
                className={cx(
                  "rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors",
                  provider === p.id ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-fg-2 hover:bg-surface-2 hover:text-fg",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Base URL" help="An OpenAI-compatible endpoint." stacked>
          <CommitInput value={settings.llm.base_url} placeholder="http://127.0.0.1:11434/v1" onCommit={(v) => void save({ llm: { base_url: v.trim(), ...(presetFor(provider)?.base_url !== v.trim() && provider !== "custom" ? { provider: "custom" as const } : {}) } })} className="font-mono text-[12.5px]" />
        </Field>
        <Field label="Model" help="Pick one the endpoint lists, or type any model name." stacked>
          <CommitInput value={settings.llm.model} placeholder="e.g. qwen3:8b" onCommit={(v) => void save({ llm: { model: v.trim() } })} className="font-mono text-[12.5px]" />
          {models.length > 0 && (
            <div className="mt-2 flex max-h-[92px] flex-wrap gap-1.5 overflow-y-auto">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => void save({ llm: { model: m } })}
                  className={cx(
                    "rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] transition-colors",
                    m === settings.llm.model ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-fg-2 hover:bg-surface-2",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field
          label="API key"
          help={
            settings.llm.api_key_set ? (
              <span className="flex items-center gap-1 text-ok">
                <Check size={13} /> Saved in Keychain
              </span>
            ) : preset?.needsKey ? (
              "Required for this provider. Stored in the macOS Keychain, never in a file."
            ) : (
              "Only needed if your endpoint requires one. Stored in the macOS Keychain."
            )
          }
          stacked
        >
          <div className="flex gap-2">
            <TextInput
              type="password"
              value={key}
              placeholder={settings.llm.api_key_set ? "••••••••  (replace key)" : "Paste API key"}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              autoComplete="new-password"
            />
            <Button
              icon={<KeyRound size={14} />}
              disabled={!key.trim()}
              loading={savingKey}
              onClick={async () => {
                setSavingKey(true);
                if (await saveApiKey(key.trim())) setKey("");
                setSavingKey(false);
              }}
            >
              Save
            </Button>
            {settings.llm.api_key_set && (
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void clearApiKey()}>
                Remove
              </Button>
            )}
          </div>
        </Field>
      </Section>

      <Section title="Connection">
        <Field
          label={
            <span className="flex items-center gap-2">
              <StatusDot status={llm ? (llm.reachable ? (llm.model_available ? "ok" : "warn") : "error") : "pending"} />
              {llm ? (llm.reachable ? (llm.model_available ? "Ready" : "Model not found on the server") : "Not reachable") : "Checking…"}
              {llm && (
                <Chip tone={llm.remote ? "warn" : "ok"}>{llm.remote ? "Remote" : "On this Mac"}</Chip>
              )}
            </span>
          }
          help={llm?.error ?? (llm ? `${llm.models.length} model${llm.models.length === 1 ? "" : "s"} available at ${llm.base_url}` : undefined)}
        >
          <div className="flex gap-2">
            <Button icon={<Radar size={14} />} loading={detecting} onClick={() => void detect()}>
              Auto-detect
            </Button>
            <Button variant="primary" icon={<Zap size={14} />} loading={testing} onClick={() => void test()}>
              Test connection
            </Button>
          </div>
        </Field>
        {testResult && (
          <div className={cx("my-3 rounded-lg px-3 py-2 text-[13px]", testResult.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")} role="status">
            {testResult.ok ? `Works: the model answered in ${testResult.latency_ms} ms.` : `Test failed: ${testResult.error ?? "no answer"}`}
          </div>
        )}
        {candidates && (
          <div className="my-3 space-y-1.5">
            {candidates.length === 0 && <div className="text-[13px] text-fg-3">Nothing found.</div>}
            {candidates.map((c) => (
              <button
                key={c.base_url}
                type="button"
                disabled={!c.reachable}
                onClick={() => useCandidate(c)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                <StatusDot status={c.reachable ? "ok" : "error"} />
                <span className="font-medium">{presetFor(c.provider)?.label ?? c.provider}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">{c.base_url}</span>
                <span className="shrink-0 text-fg-3">{c.reachable ? `${c.models.length} model${c.models.length === 1 ? "" : "s"}` : "not running"}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {provider === "ollama" && (
        <Section title="Ollama">
          {llm && !llm.reachable && (
            <Field label="Ollama isn't running" help="Start the installed Ollama app, or install it from ollama.com.">
              <Button variant="primary" icon={<Play size={14} />} loading={startingOllama} onClick={() => void startOllama()}>
                Start Ollama
              </Button>
            </Field>
          )}
          <Field label="Pull a model" help="Download a model into Ollama. Smaller models are faster; 7–8B works well." stacked>
            <div className="flex gap-2">
              <TextInput value={pullName} onChange={(e) => setPullName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder={DEFAULT_PULL_MODEL} className="font-mono text-[12.5px]" />
              <Button icon={<Download size={14} />} loading={pullActive} disabled={!pullName.trim() || (llm ? !llm.reachable : false)} onClick={() => void startPull()}>
                Pull
              </Button>
            </div>
            {pull && (pullActive || pull.error || pull.done) && (
              <div className="mt-3">
                <ProgressBar value={pull.done ? 1 : pullPct} indeterminate={!pull.done && pullPct == null} />
                <div className={cx("mt-1.5 flex justify-between text-[12px] tabular-nums", pull.error ? "text-danger" : "text-fg-3")}>
                  <span className="truncate">{pull.error ?? (pull.done ? "Done" : pull.status)}</span>
                  {pull.total > 0 && !pull.done && <span>{formatBytes(pull.completed)} / {formatBytes(pull.total)}</span>}
                </div>
              </div>
            )}
          </Field>
        </Section>
      )}

      <Section title="Advanced">
        <Field label="Structured output (JSON mode)" help="“Auto” lets Jarvis detect what the model supports.">
          <Select
            className="w-[140px]"
            value={settings.llm.json_mode}
            onChange={(v) => void save({ llm: { json_mode: v } })}
            options={[
              { value: "auto", label: "Auto" },
              { value: "on", label: "Always on" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
        <Field label="Reasoning" help="Turn off “thinking” output for models that support it. Faster, usually fine for browsing.">
          <Select
            className="w-[140px]"
            value={settings.llm.reasoning}
            onChange={(v) => void save({ llm: { reasoning: v } })}
            options={[
              { value: "default", label: "Model default" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
      </Section>
    </>
  );
}
