import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { IconButton } from "./Button";
import { cx } from "./cx";

export function CopyButton({ text, label = "Copy", className, size = 14 }: { text: string | (() => string); label?: string; className?: string; size?: number }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <IconButton
      label={done ? "Copied" : label}
      className={cx(done && "text-ok hover:text-ok", className)}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(typeof text === "function" ? text() : text);
        if (!ok) return;
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={size} /> : <Copy size={size} />}
    </IconButton>
  );
}
