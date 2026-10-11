import { RefreshCw, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { useApp } from "../store";
import { isTauri } from "../lib/tauri";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/feedback";

export function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[52px]" />
      <span className="flex size-14 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: "linear-gradient(135deg, #8a8ffb, #4b45df)" }}>
        <Sparkles size={26} />
      </span>
      <div className="flex items-center gap-2 text-[13px] text-fg-2">
        <Spinner size={14} /> Starting Jarvis…
      </div>
      <p className="max-w-xs text-center text-[12px] text-fg-3">The first start can take a little longer while the local models load.</p>
    </div>
  );
}

export function BackendError() {
  const message = useApp((s) => s.bootError);
  const exited = useApp((s) => s.backendExited);
  const boot = useApp((s) => s.boot);
  const restart = useApp((s) => s.restartEngine);
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[52px]" />
      <div className="anim-pop w-full max-w-[520px] rounded-2xl border border-line bg-surface p-6 shadow-md">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-danger-soft text-danger">
            <TriangleAlert size={18} />
          </span>
          <div>
            <h1 className="text-[16px] font-semibold">{exited ? "The Jarvis engine stopped" : "Can't reach the Jarvis engine"}</h1>
            <p className="text-[12.5px] text-fg-3">Jarvis needs its local engine (a small background process) to work.</p>
          </div>
        </div>
        {message && (
          <pre className="selectable mt-4 max-h-56 overflow-auto rounded-lg border border-line bg-code px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">
            {message}
          </pre>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button icon={<RefreshCw size={13} />} onClick={() => void boot()}>
            Try again
          </Button>
          {isTauri && (
            <Button variant="primary" icon={<RotateCcw size={13} />} onClick={() => void restart()}>
              Restart engine
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
