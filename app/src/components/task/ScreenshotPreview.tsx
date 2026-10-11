import { ImageOff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { IconButton } from "../ui/Button";
import { Spinner } from "../ui/feedback";

const POLL_MS = 2000;

/**
 * Live preview of the agent's tab. Fetches once when mounted (toggle switched on), then at most every
 * 2 s while `poll` is true and the window is visible. Never runs when unmounted (toggle off).
 */
export function ScreenshotPreview({ taskId, poll }: { taskId: string; poll: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);
  const urlRef = useRef<string | null>(null);

  const capture = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const blob = await api.screenshot(taskId);
      const url = URL.createObjectURL(blob);
      const old = urlRef.current;
      urlRef.current = url;
      setSrc(url);
      setError(null);
      if (old) URL.revokeObjectURL(old);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview unavailable");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void capture();
    if (!poll) return;
    const id = setInterval(() => {
      if (!document.hidden) void capture();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [capture, poll]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <div className="relative mt-2.5 aspect-[16/9] w-full overflow-hidden rounded-lg border border-line bg-surface-2">
      {src && <img src={src} alt="Live view of the browser tab" className="size-full object-contain" draggable={false} />}
      {!src && (
        <div className="flex size-full flex-col items-center justify-center gap-1.5 text-[12.5px] text-fg-3">
          {error ? (
            <>
              <ImageOff size={18} />
              <span className="max-w-[80%] text-center">{error}</span>
            </>
          ) : (
            <Spinner size={18} />
          )}
        </div>
      )}
      {src && error && <div className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-[11.5px] text-white">Preview paused: {error}</div>}
      <div className="absolute top-1.5 right-1.5">
        <IconButton label="Refresh preview" onClick={() => void capture()} className="bg-black/45 text-white hover:bg-black/65 hover:text-white">
          <RefreshCw size={13} className={loading ? "anim-spin" : ""} />
        </IconButton>
      </div>
    </div>
  );
}
