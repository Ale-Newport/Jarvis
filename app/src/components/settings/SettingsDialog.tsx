import { Bot, Cpu, Globe, Info, Settings as Cog, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useApp } from "../../store";
import { useUi, type SettingsTab } from "../../store/ui";
import { IconButton } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { cx } from "../ui/cx";
import { Spinner } from "../ui/feedback";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { ChromeSettings } from "./ChromeSettings";
import { GeneralSettings } from "./GeneralSettings";
import { LayaSettings } from "./LayaSettings";
import { ModelSettings } from "./ModelSettings";

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Cog },
  { id: "chrome", label: "Chrome", icon: Globe },
  { id: "model", label: "AI model", icon: Bot },
  { id: "laya", label: "Laya", icon: Cpu },
  { id: "agent", label: "Agent limits", icon: SlidersHorizontal },
  { id: "about", label: "About", icon: Info },
];

const TITLES: Record<SettingsTab, string> = {
  general: "General",
  chrome: "Chrome",
  model: "AI model",
  laya: "Laya",
  agent: "Agent limits",
  about: "About",
};

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  const loaded = useApp((s) => !!s.settings);

  let body: ReactNode = null;
  if (loaded) {
    body = {
      general: <GeneralSettings />,
      chrome: <ChromeSettings />,
      model: <ModelSettings />,
      laya: <LayaSettings />,
      agent: <AgentSettings />,
      about: <AboutSettings />,
    }[tab];
  }

  return (
    <Modal open={open} onClose={close} bare className="h-[640px] w-[880px] max-w-full max-md:h-full">
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <nav className="flex shrink-0 gap-0.5 border-r border-line bg-sidebar/70 p-2.5 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b md:w-[188px] md:flex-col" aria-label="Settings sections">
          <div className="hidden px-2.5 pt-1 pb-2.5 text-[15px] font-semibold md:block">Settings</div>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => openSettings(id)}
              aria-current={tab === id}
              className={cx(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] whitespace-nowrap transition-colors",
                tab === id ? "bg-accent text-accent-fg" : "text-fg-2 hover:bg-surface-3/70 hover:text-fg",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between px-6">
            <h2 className="text-[16px] font-semibold">{TITLES[tab]}</h2>
            <IconButton label="Close settings" onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            {loaded ? body : <Spinner className="mt-8" />}
          </div>
        </div>
      </div>
    </Modal>
  );
}
