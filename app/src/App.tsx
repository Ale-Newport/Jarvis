import { useEffect } from "react";
import { BackendError, Splash } from "./components/BackendGate";
import { ChatView } from "./components/ChatView";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Onboarding } from "./components/onboarding/Onboarding";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { SIDEBAR_WIDTH, Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { cx } from "./components/ui/cx";
import { useShortcuts } from "./hooks/useShortcuts";
import { useTheme } from "./hooks/useTheme";
import { isSafeExternalUrl, isTauri, openExternal } from "./lib/tauri";
import { useApp } from "./store";
import { useUi } from "./store/ui";

let booted = false;

const NARROW_QUERY = "(max-width: 719px)";

function Shell() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const narrow = useUi((s) => s.narrow);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  return (
    <div className="relative flex h-full">
      {!narrow && (
        <aside
          inert={!sidebarOpen}
          aria-hidden={!sidebarOpen}
          className={cx("shrink-0 overflow-hidden transition-[width] duration-200 ease-out", isTauri ? "bg-transparent" : "bg-sidebar", sidebarOpen && "border-r border-line")}
          style={{ width: sidebarOpen ? SIDEBAR_WIDTH + 1 : 0 }}
        >
          <Sidebar />
        </aside>
      )}
      <ChatView />
      {narrow && sidebarOpen && (
        <>
          <div className="anim-fade absolute inset-0 z-20" style={{ background: "var(--scrim)" }} onMouseDown={() => setSidebarOpen(false)} />
          <aside className="anim-fade absolute inset-y-0 left-0 z-30 max-w-[88vw] border-r border-line bg-sidebar shadow-lg">
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </aside>
        </>
      )}
      <ConnectionBanner />
    </div>
  );
}

export default function App() {
  useTheme();
  useShortcuts();
  const phase = useApp((s) => s.phase);
  const onboardingOpen = useUi((s) => s.onboardingOpen);
  const setNarrow = useUi((s) => s.setNarrow);

  useEffect(() => {
    if (!booted) {
      booted = true;
      void useApp.getState().boot();
    }
  }, []);

  // responsive: the sidebar becomes a drawer on very narrow windows
  useEffect(() => {
    const m = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [setNarrow]);

  // The webview must never navigate: external links open in the default browser, drops are ignored.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (isSafeExternalUrl(href)) void openExternal(href);
    };
    const stop = (e: Event) => e.preventDefault();
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, .selectable")) return;
      e.preventDefault();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    document.addEventListener("contextmenu", onContext);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
      document.removeEventListener("contextmenu", onContext);
    };
  }, []);

  return (
    <>
      {phase === "booting" && <Splash />}
      {phase === "error" && <BackendError />}
      {phase === "ready" && (onboardingOpen ? <Onboarding /> : <Shell />)}
      {phase === "ready" && <SettingsDialog />}
      <ShortcutsSheet />
      <Toasts />
    </>
  );
}
