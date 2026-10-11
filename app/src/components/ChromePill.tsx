import { AppWindow, ChevronUp, Plug, PlugZap, Settings as SettingsIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ChromeStatus } from "../api/types";
import { useDismiss } from "../hooks/useDismiss";
import { useApp } from "../store";
import { useUi } from "../store/ui";
import { Markdown } from "./Markdown";
import { Button } from "./ui/Button";
import { Segmented } from "./ui/controls";
import { cx } from "./ui/cx";
import { Spinner, StatusDot } from "./ui/feedback";

export const MODE_LABEL = { managed: "Automation profile", existing: "Existing Chrome session" } as const;

export function chromeHeadline(c: ChromeStatus | null): string {
  if (!c) return "Chrome";
  if (!c.installed && c.state !== "connected") return "Chrome not found";
  switch (c.state) {
    case "connected":
      return "Chrome connected";
    case "connecting":
      return "Connecting to Chrome…";
    case "awaiting_permission":
      return "Awaiting permission";
    case "error":
      return "Chrome error";
    default:
      return "Chrome disconnected";
  }
}

export function ChromePill({ compact }: { compact?: boolean }) {
  const chrome = useApp((s) => s.chrome);
  const settingsMode = useApp((s) => s.settings?.chrome.mode);
  const busy = useApp((s) => s.chromeBusy);
  // local state: the sidebar and the top bar each own a pill (only one is visible at a time)
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss([ref, popRef], open, () => setOpen(false));

  const state = chrome?.state ?? "disconnected";
  const mode = chrome?.mode ?? settingsMode ?? "managed";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={chromeHeadline(chrome)}
        className={cx(
          "flex items-center gap-2 rounded-lg text-left transition-colors hover:bg-surface-3/70",
          compact ? "h-7 px-2" : "w-full px-2.5 py-1.5",
          open && "bg-surface-3/70",
        )}
      >
        {busy || state === "connecting" ? <Spinner size={11} className="text-warn" /> : <StatusDot status={state} />}
        {compact ? (
          <span className="text-[12px] font-medium text-fg-2">{chromeHeadline(chrome).replace("Chrome ", "")}</span>
        ) : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] leading-tight font-medium text-fg">{chromeHeadline(chrome)}</span>
            <span className="block truncate text-[11px] leading-tight text-fg-3">{MODE_LABEL[mode]}</span>
          </span>
        )}
        {!compact && <ChevronUp size={14} className={cx("shrink-0 text-fg-3 transition-transform duration-200", !open && "rotate-180")} />}
      </button>
      {open && <ChromePopover anchor={ref} popRef={popRef} compact={compact} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ChromePopover({ anchor, popRef, compact, onClose }: { anchor: React.RefObject<HTMLDivElement | null>; popRef: React.RefObject<HTMLDivElement | null>; compact?: boolean; onClose: () => void }) {
  const chrome = useApp((s) => s.chrome);
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => s.chromeBusy);
  const connect = useApp((s) => s.chromeConnect);
  const disconnect = useApp((s) => s.chromeDisconnect);
  const focus = useApp((s) => s.chromeFocus);
  const setMode = useApp((s) => s.chromeSetMode);
  const openSettings = useUi((s) => s.openSettings);

  const state = chrome?.state ?? "disconnected";
  const mode = chrome?.mode ?? settings?.chrome.mode ?? "managed";
  const connected = state === "connected";
  const working = busy || state === "connecting" || state === "awaiting_permission";
  const showHowTo = mode === "existing" && chrome?.debugging === "off" && !!chrome.how_to_enable;

  // Rendered in a portal (the sidebar clips its children); placed next to the pill that opened it.
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(330, window.innerWidth - 16);
    if (compact) setStyle({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right), width, maxHeight: window.innerHeight - rect.bottom - 16 });
    else setStyle({ bottom: window.innerHeight - rect.top + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight: rect.top - 16 });
  }, [anchor, compact]);

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label="Chrome connection"
      style={style}
      className={cx("anim-pop fixed z-40 overflow-y-auto rounded-2xl bg-surface p-3.5 shadow-lg", compact ? "origin-top-right" : "origin-bottom-left")}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5">{working ? <Spinner size={11} className="text-warn" /> : <StatusDot status={state} />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{chromeHeadline(chrome)}</div>
          <div className="selectable mt-0.5 text-[12px] leading-snug text-fg-3">
            {chrome?.error ? (
              <span className="text-danger">{chrome.error}</span>
            ) : chrome && !chrome.installed ? (
              "Google Chrome wasn't found. Choose it in Settings → Chrome."
            ) : chrome?.version ? (
              `Google Chrome ${chrome.version}${connected ? ` · ${chrome.tabs.length} tab${chrome.tabs.length === 1 ? "" : "s"} opened by Jarvis` : ""}`
            ) : (
              "Jarvis drives your real Google Chrome."
            )}
          </div>
        </div>
      </div>

      {state === "awaiting_permission" && (
        <div className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] leading-snug text-fg">
          Chrome is asking <b>“Allow remote debugging?”</b>. Switch to Chrome and click <b>Allow</b>, then come back here.
        </div>
      )}

      <div className="mt-3.5">
        <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">Mode</div>
        <Segmented
          className="w-full [&>button]:flex-1"
          value={mode}
          disabled={working}
          onChange={(m) => void setMode(m)}
          options={[
            { value: "managed", label: "Automation profile", title: "Jarvis uses its own Chrome profile — your tabs and logins stay untouched." },
            { value: "existing", label: "Existing Chrome", title: "Jarvis drives the Chrome you already use." },
          ]}
        />
        <p className="mt-1.5 text-[12px] leading-snug text-fg-3">
          {mode === "managed"
            ? "Jarvis opens its own Chrome window with a separate profile. Your everyday tabs and sign-ins stay out of reach."
            : "Jarvis connects to the Chrome you're already using, including your sign-ins. Chrome asks for permission once."}
        </p>
      </div>

      {showHowTo && (
        <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <div className="mb-1 text-[12px] font-semibold text-fg-2">Turn on remote debugging</div>
          <Markdown text={chrome!.how_to_enable!} compact />
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap gap-2">
        {connected ? (
          <Button size="sm" icon={<Plug size={13} />} onClick={() => void disconnect()} loading={busy}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<PlugZap size={13} />} onClick={() => void connect(mode)} loading={working}>
            {state === "awaiting_permission" ? "Waiting for Chrome…" : "Connect"}
          </Button>
        )}
        <Button size="sm" icon={<AppWindow size={13} />} disabled={!connected} onClick={() => void focus()}>
          Open current browser tab
        </Button>
      </div>

      <div className="mt-3 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => {
            onClose();
            openSettings("chrome");
          }}
          className="flex items-center gap-1.5 text-[12.5px] text-fg-2 transition-colors hover:text-fg"
        >
          <SettingsIcon size={13} /> Chrome settings…
        </button>
      </div>
    </div>,
    document.body,
  );
}
