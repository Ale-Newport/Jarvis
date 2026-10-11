import type { ScreenshotsMode } from "../../api/types";
import { useApp } from "../../store";
import { Field, NumberInput, Section, Segmented, Switch } from "../ui/controls";

export function AgentSettings() {
  const agent = useApp((s) => s.settings!.agent);
  const save = useApp((s) => s.saveSettings);
  return (
    <>
      <Section title="Limits">
        <Field label="Maximum steps" help="Browser actions Jarvis may take for one task before it stops.">
          <NumberInput value={agent.max_steps} min={1} max={500} onCommit={(n) => void save({ agent: { max_steps: n } })} suffix="steps" />
        </Field>
        <Field label="Maximum time" help="Wall-clock limit for one task.">
          <NumberInput value={agent.max_minutes} min={1} max={240} onCommit={(n) => void save({ agent: { max_minutes: n } })} suffix="minutes" />
        </Field>
      </Section>
      <Section title="Safety">
        <Field label="Confirm sensitive actions" help="Ask before purchases, sending messages, account changes and deletions. Payments always ask, whatever you choose here.">
          <Switch checked={agent.confirm_sensitive} onChange={(v) => void save({ agent: { confirm_sensitive: v } })} label="Confirm sensitive actions" />
        </Field>
        <Field label="Allow local addresses" help="Let Jarvis open pages on localhost and your local network (for example a router page or a dev server). Off by default.">
          <Switch checked={agent.allow_local_urls} onChange={(v) => void save({ agent: { allow_local_urls: v } })} label="Allow local addresses" />
        </Field>
      </Section>
      <Section title="Live preview">
        <Field label="Screenshots" help="“On demand” lets you peek at the browser tab from the task panel. “Every step” captures after each action (slower). “Off” disables previews entirely.">
          <Segmented<ScreenshotsMode>
            value={agent.screenshots}
            onChange={(v) => void save({ agent: { screenshots: v } })}
            options={[
              { value: "off", label: "Off" },
              { value: "on_demand", label: "On demand" },
              { value: "per_step", label: "Every step" },
            ]}
          />
        </Field>
      </Section>
    </>
  );
}
