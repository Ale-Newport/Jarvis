import { FolderSearch, Plug, PlugZap, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { ChromeMode } from "../../api/types";
import { useApp } from "../../store";
import { Button } from "../ui/Button";
import { Field, NumberInput, Section, Segmented } from "../ui/controls";
import { Switch } from "../ui/controls";
import { Modal } from "../ui/Modal";
import { StatusDot } from "../ui/feedback";
import { pickChromeApp } from "../../lib/tauri";
import { chromeHeadline } from "../ChromePill";

export function ChromeSettings() {
  const settings = useApp((s) => s.settings!);
  const chrome = useApp((s) => s.chrome);
  const busy = useApp((s) => s.chromeBusy);
  const save = useApp((s) => s.saveSettings);
  const connect = useApp((s) => s.chromeConnect);
  const disconnect = useApp((s) => s.chromeDisconnect);
  const setMode = useApp((s) => s.chromeSetMode);
  const notifyError = useApp((s) => s.notifyError);
  const notify = useApp((s) => s.notify);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [picking, setPicking] = useState(false);

  const mode = settings.chrome.mode;
  const connected = chrome?.state === "connected";
  const working = busy || chrome?.state === "connecting" || chrome?.state === "awaiting_permission";

  const choosePath = async () => {
    setPicking(true);
    try {
      const picked = await pickChromeApp();
      if (!picked) return;
      const status = await api.chromeSetPath(picked);
      useApp.setState({ chrome: status });
      useApp.setState((s) => (s.settings ? { settings: { ...s.settings, chrome: { ...s.settings.chrome, path: picked } } } : s));
      notify("info", "Chrome location updated.");
    } catch (e) {
      notifyError(e, "That doesn't look like Google Chrome");
    } finally {
      setPicking(false);
    }
  };

  const resetProfile = async () => {
    setResetting(true);
    try {
      const status = await api.chromeResetProfile();
      useApp.setState({ chrome: status });
      notify("info", "The automation profile was reset.");
      setConfirmReset(false);
    } catch (e) {
      notifyError(e, "Couldn't reset the profile");
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Section title="Connection">
        <Field
          label={
            <span className="flex items-center gap-2">
              <StatusDot status={chrome?.state ?? "disconnected"} /> {chromeHeadline(chrome)}
            </span>
          }
          help={chrome?.error ?? (chrome?.version ? `Google Chrome ${chrome.version}` : "Not connected yet.")}
        >
          {connected ? (
            <Button icon={<Plug size={14} />} loading={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" icon={<PlugZap size={14} />} loading={working} onClick={() => void connect(mode)}>
              Connect
            </Button>
          )}
        </Field>
        <Field
          label="Mode"
          help={
            mode === "managed"
              ? "Jarvis uses its own automation profile: separate from your everyday tabs and sign-ins."
              : "Jarvis drives the Chrome you already use (including your sign-ins). Chrome asks permission once."
          }
        >
          <Segmented<ChromeMode>
            value={mode}
            disabled={working}
            onChange={(m) => void setMode(m)}
            options={[
              { value: "managed", label: "Automation profile" },
              { value: "existing", label: "Existing session" },
            ]}
          />
        </Field>
        {mode === "existing" && (
          <Field label="Debugging port" help="Optional hint if Chrome's remote debugging runs on a known port (for example 9222). Leave 0 to auto-detect.">
            <NumberInput value={settings.chrome.existing_debug_port ?? 0} min={0} max={65535} onCommit={(n) => void save({ chrome: { existing_debug_port: n === 0 ? null : n } })} />
          </Field>
        )}
      </Section>

      <Section title="Application">
        <Field
          label="Chrome location"
          help={
            <span className="selectable break-all">
              {settings.chrome.path ?? chrome?.path ?? "Not found"} {settings.chrome.path ? "" : chrome?.path ? "(auto-detected)" : ""}
            </span>
          }
        >
          <div className="flex gap-2">
            {settings.chrome.path && (
              <Button variant="ghost" onClick={() => void save({ chrome: { path: null } })}>
                Auto-detect
              </Button>
            )}
            <Button icon={<FolderSearch size={14} />} loading={picking} onClick={() => void choosePath()}>
              Choose…
            </Button>
          </div>
        </Field>
        {mode === "managed" && (
          <Field label="Keep Chrome open when Jarvis quits" help="Leave the automation window running after you quit the app.">
            <Switch checked={settings.chrome.keep_open_on_quit} onChange={(v) => void save({ chrome: { keep_open_on_quit: v } })} label="Keep Chrome open when Jarvis quits" />
          </Field>
        )}
      </Section>

      <Section title="Danger zone">
        <Field
          label="Reset automation profile"
          help={chrome?.profile_dir ? <span className="selectable break-all">Deletes {chrome.profile_dir}: cookies, sign-ins and history inside Jarvis's own Chrome profile.</span> : "Deletes Jarvis's own Chrome profile: cookies, sign-ins and history inside it. Your everyday Chrome is untouched."}
        >
          <Button variant="danger-soft" icon={<Trash2 size={14} />} onClick={() => setConfirmReset(true)}>
            Reset…
          </Button>
        </Field>
      </Section>

      <Modal open={confirmReset} onClose={() => !resetting && setConfirmReset(false)} title="Reset the automation profile?" className="w-[440px] max-w-full">
        <div className="px-5 py-4 text-[13.5px] leading-relaxed text-fg-2">
          This permanently deletes the Chrome profile Jarvis uses in <b>Automation profile</b> mode, including any sites you signed in to there. Your normal Chrome profile is not touched. You can't undo this.
          <div className="mt-5 flex justify-end gap-2">
            <Button disabled={resetting} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={resetting} onClick={() => void resetProfile()}>
              Delete profile
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
