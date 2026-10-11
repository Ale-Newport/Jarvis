import { Keyboard, Laptop, Moon, RefreshCw, Sun } from "lucide-react";
import type { Appearance } from "../../api/types";
import { useApp } from "../../store";
import { useUi } from "../../store/ui";
import { Button } from "../ui/Button";
import { Field, Section, Segmented } from "../ui/controls";

export function GeneralSettings() {
  const appearance = useApp((s) => s.settings!.appearance);
  const save = useApp((s) => s.saveSettings);
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const setOnboardingOpen = useUi((s) => s.setOnboardingOpen);
  const closeSettings = useUi((s) => s.closeSettings);
  const runCheck = useApp((s) => s.runOnboardingCheck);

  return (
    <>
      <Section title="Appearance">
        <Field label="Theme" help="Follow the system, or pick light or dark.">
          <Segmented<Appearance>
            value={appearance}
            onChange={(v) => void save({ appearance: v })}
            options={[
              { value: "system", label: <span className="flex items-center gap-1.5"><Laptop size={13} />System</span> },
              { value: "light", label: <span className="flex items-center gap-1.5"><Sun size={13} />Light</span> },
              { value: "dark", label: <span className="flex items-center gap-1.5"><Moon size={13} />Dark</span> },
            ]}
          />
        </Field>
      </Section>
      <Section title="Help">
        <Field label="Keyboard shortcuts" help="Everything you can do without leaving the keyboard.">
          <Button icon={<Keyboard size={14} />} onClick={() => setShortcutsOpen(true)}>
            Show shortcuts
          </Button>
        </Field>
        <Field label="Setup assistant" help="Re-run the first-run checks (Laya model, text model, Chrome).">
          <Button
            icon={<RefreshCw size={14} />}
            onClick={() => {
              closeSettings();
              setOnboardingOpen(true);
              void runCheck();
            }}
          >
            Run setup again
          </Button>
        </Field>
      </Section>
    </>
  );
}
