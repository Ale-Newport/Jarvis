import { Download, Zap } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { LayaState } from "../../api/types";
import { formatBytes, formatDuration } from "../../lib/format";
import { useApp } from "../../store";
import { Button } from "../ui/Button";
import { CommitInput, Field, Section } from "../ui/controls";
import { Chip, ProgressBar } from "../ui/feedback";

const STATE_LABEL: Record<LayaState, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  missing: { label: "Not downloaded", tone: "warn" },
  downloading: { label: "Downloading…", tone: "warn" },
  loading: { label: "Loading…", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
  unsupported: { label: "Unsupported on this Mac", tone: "danger" },
  error: { label: "Error", tone: "danger" },
};

export function LayaSettings() {
  const settings = useApp((s) => s.settings!);
  const laya = useApp((s) => s.laya);
  const progress = useApp((s) => s.layaDownload);
  const save = useApp((s) => s.saveSettings);
  const notifyError = useApp((s) => s.notifyError);
  const [loadingModel, setLoadingModel] = useState(false);

  const state = laya?.state ?? "missing";
  const st = STATE_LABEL[state];
  const downloading = state === "downloading" || (!!progress && !progress.done && state !== "ready");
  const pct = progress && progress.total > 0 ? progress.bytes / progress.total : undefined;

  const download = async () => {
    try {
      useApp.setState({ laya: await api.layaDownload() });
    } catch (e) {
      notifyError(e, "Couldn't start the download");
    }
  };
  const load = async () => {
    setLoadingModel(true);
    try {
      useApp.setState({ laya: await api.layaLoad() });
    } catch (e) {
      notifyError(e, "Couldn't load Laya");
      void useApp.getState().refreshStatus();
    } finally {
      setLoadingModel(false);
    }
  };

  return (
    <>
      <p className="mb-4 text-[13px] leading-relaxed text-fg-2">
        Laya is the small decision model that runs entirely on your Mac (Apple Silicon, MLX). It chooses each browser action; a separate text model plans and writes the answer.
      </p>
      <Section title="Model">
        <Field label="Laya model" help="Hugging Face repository of the MLX checkpoint.">
          <CommitInput className="w-[300px] font-mono text-[12.5px]" value={settings.laya.model} onCommit={(v) => void save({ laya: { model: v.trim() } })} />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-2">
              Status <Chip tone={st.tone}>{st.label}</Chip>
            </span>
          }
          help={
            laya?.error ? (
              <span className="text-danger">{laya.error}</span>
            ) : (
              [laya?.size_bytes ? formatBytes(laya.size_bytes) : null, laya?.load_ms ? `loaded in ${formatDuration(laya.load_ms)}` : null, laya?.warm_ms ? `warm-up ${formatDuration(laya.warm_ms)}` : null]
                .filter(Boolean)
                .join(" · ") || undefined
            )
          }
        >
          {!laya?.downloaded && state !== "unsupported" ? (
            <Button variant="primary" icon={<Download size={14} />} loading={downloading} onClick={() => void download()}>
              Download
            </Button>
          ) : (
            state !== "ready" &&
            state !== "unsupported" && (
              <Button variant="primary" icon={<Zap size={14} />} loading={state === "loading" || loadingModel} onClick={() => void load()}>
                Load
              </Button>
            )
          )}
        </Field>
        {downloading && (
          <div className="py-3">
            <ProgressBar value={pct} indeterminate={pct == null} />
            <div className="mt-1.5 flex justify-between text-[12px] text-fg-3 tabular-nums">
              <span className="truncate">{progress?.file ?? "Preparing…"}</span>
              <span>{progress && progress.total > 0 ? `${formatBytes(progress.bytes)} / ${formatBytes(progress.total)}` : ""}</span>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}
