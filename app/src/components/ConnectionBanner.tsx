import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../store";
import { Button } from "./ui/Button";

/** Shown when the event stream has been down for a moment (the app keeps retrying on its own). */
export function ConnectionBanner() {
  const stream = useApp((s) => s.stream);
  const retry = useApp((s) => s.retryConnection);
  const down = stream !== "open";
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!down) return setVisible(false);
    const t = setTimeout(() => setVisible(true), 1800);
    return () => clearTimeout(t);
  }, [down]);
  if (!visible) return null;
  return (
    <div role="status" className="anim-slide absolute top-[56px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-surface py-1.5 pr-1.5 pl-3.5 text-[12.5px] shadow-lg">
      <WifiOff size={14} className="text-warn" />
      <span>Lost connection to the Jarvis engine — reconnecting…</span>
      <Button size="sm" onClick={retry}>
        Retry now
      </Button>
    </div>
  );
}
