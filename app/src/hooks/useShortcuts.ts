import { useEffect } from "react";
import { copyText } from "../lib/clipboard";
import { useOrderedConversations } from "../components/Sidebar";
import { findBusyTaskId } from "../store/reducer";
import { useApp } from "../store";
import { useUi } from "../store/ui";

/** Global keyboard shortcuts (macOS ⌘ based). */
export function useShortcuts(): void {
  const ordered = useOrderedConversations();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      const app = useApp.getState();
      const key = e.key;

      if (key === "/") {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
        return;
      }
      if (key === ",") {
        e.preventDefault();
        if (ui.onboardingOpen) return;
        if (ui.settingsOpen) ui.closeSettings();
        else ui.openSettings();
        return;
      }
      // everything else only applies to the main window (not over onboarding/settings)
      if (ui.onboardingOpen || ui.settingsOpen || app.phase !== "ready") return;

      if (!e.shiftKey && (key === "n" || key === "N")) {
        e.preventDefault();
        app.newChat();
      } else if (!e.shiftKey && (key === "k" || key === "K")) {
        e.preventDefault();
        if (ui.narrow) ui.setSidebarOpen(false);
        ui.focusComposer();
      } else if (!e.shiftKey && (key === "b" || key === "B")) {
        e.preventDefault();
        ui.toggleSidebar();
      } else if (!e.shiftKey && key === ".") {
        const id = findBusyTaskId(app.tasks);
        if (id) {
          e.preventDefault();
          void app.cancelTask(id);
        }
      } else if (e.shiftKey && (key === "c" || key === "C")) {
        if (window.getSelection()?.toString()) return; // let the normal copy of a selection win
        const list = app.activeId ? app.messages[app.activeId] : undefined;
        const last = [...(list ?? [])].reverse().find((m) => m.role === "assistant" && m.text.trim());
        if (last) {
          e.preventDefault();
          void copyText(last.text).then((ok) => ok && app.notify("info", "Copied the last answer."));
        }
      } else if (!e.shiftKey && /^[1-9]$/.test(key)) {
        const conv = ordered[Number(key) - 1];
        if (conv) {
          e.preventDefault();
          void app.openConversation(conv.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered]);
}
