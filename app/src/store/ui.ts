// Purely presentational state (panels, modals, draft text). Data lives in store/index.ts.
import { create } from "zustand";
import { KEYS, lsGetBool, lsSetBool } from "../lib/storage";

export type SettingsTab = "general" | "chrome" | "model" | "laya" | "agent" | "about";

interface UiState {
  sidebarOpen: boolean;
  /** window narrower than the overlay breakpoint: sidebar behaves as a drawer */
  narrow: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  shortcutsOpen: boolean;
  onboardingOpen: boolean;
  draft: string;
  /** bump to focus the composer (⌘K / new chat) */
  focusNonce: number;

  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setNarrow: (narrow: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setShortcutsOpen: (open: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  setDraft: (text: string) => void;
  focusComposer: () => void;
}

export const useUi = create<UiState>()((set, get) => ({
  sidebarOpen: lsGetBool(KEYS.sidebar, true),
  narrow: false,
  settingsOpen: false,
  settingsTab: "general",
  shortcutsOpen: false,
  onboardingOpen: false,
  draft: "",
  focusNonce: 0,

  setSidebarOpen: (open) => {
    if (!get().narrow) lsSetBool(KEYS.sidebar, open); // the drawer on narrow windows is not a preference
    set({ sidebarOpen: open });
  },
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  // narrow windows use the sidebar as a drawer (closed by default); wide ones restore the saved preference
  setNarrow: (narrow) => set({ narrow, sidebarOpen: narrow ? false : lsGetBool(KEYS.sidebar, true) }),
  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setOnboardingOpen: (open) => set({ onboardingOpen: open }),
  setDraft: (text) => set({ draft: text }),
  focusComposer: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
}));
