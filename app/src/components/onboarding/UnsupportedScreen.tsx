import { Cpu, ExternalLink, RefreshCw } from "lucide-react";
import { README_URL } from "../../lib/links";
import { closeWindow, isTauri, openExternal } from "../../lib/tauri";
import { useApp } from "../../store";
import { Button } from "../ui/Button";

/** Laya runs on Apple's MLX, which needs Apple Silicon. Explain it kindly; never fall back silently. */
export function UnsupportedScreen({ reason }: { reason: string }) {
  const status = useApp((s) => s.status);
  const recheck = useApp((s) => s.runOnboardingCheck);
  const checking = useApp((s) => s.onboardingChecking);
  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto bg-bg px-6 py-10">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[52px]" />
      <div className="anim-pop w-full max-w-[520px] text-center">
        <span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-warn-soft text-warn">
          <Cpu size={26} />
        </span>
        <h1 className="text-[24px] font-semibold tracking-tight">Jarvis needs an Apple Silicon Mac</h1>
        <p className="mx-auto mt-3 max-w-[460px] text-[14px] leading-relaxed text-fg-2">
          Jarvis makes its browsing decisions with <b>Laya</b>, a small model that runs entirely on your Mac using Apple's MLX framework. MLX only runs on Apple Silicon (M1 or newer), so Jarvis can't work on this computer. We'd rather tell you now than quietly give you a worse experience.
        </p>
        <div className="mx-auto mt-5 max-w-[420px] rounded-xl border border-line bg-surface px-4 py-3 text-left text-[13px] shadow-sm">
          <div className="text-fg-3">What we found</div>
          <div className="mt-0.5 font-medium">{reason}</div>
          {status && (
            <div className="selectable mt-1 text-[12px] text-fg-3">
              {status.arch} · macOS {status.macos} · MLX {status.mlx_supported ? "available" : "unavailable"}
            </div>
          )}
        </div>
        <p className="mt-4 text-[13px] text-fg-3">Nothing was installed or changed. If you think this is a mistake, check again or read the requirements.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button icon={<RefreshCw size={14} />} loading={checking} onClick={() => void recheck()}>
            Check again
          </Button>
          <Button icon={<ExternalLink size={14} />} onClick={() => void openExternal(README_URL)}>
            Requirements
          </Button>
          {isTauri && (
            <Button variant="primary" onClick={() => void closeWindow()}>
              Quit Jarvis
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
