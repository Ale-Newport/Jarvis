// Thin bridge to Tauri with graceful fallbacks so the UI also runs in a plain browser (dev only).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BackendInfo } from "../api/types";

export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEV_KEY = "jarvis.dev.backend";

/**
 * Resolve how to reach the backend.
 *  - inside Tauri: `invoke("backend_info")` (resolves after the sidecar printed its ready line)
 *  - plain browser (dev only): `?backend=http://127.0.0.1:PORT&token=...` (remembered for the tab),
 *    or VITE_JARVIS_BACKEND / VITE_JARVIS_TOKEN.
 */
export async function resolveBackendInfo(): Promise<BackendInfo> {
  if (isTauri) {
    try {
      return await tauriInvoke<BackendInfo>("backend_info");
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "The Jarvis engine could not be started.");
    }
  }
  const params = new URLSearchParams(window.location.search);
  let base = params.get("backend");
  let token = params.get("token");
  try {
    if (base && token) sessionStorage.setItem(DEV_KEY, JSON.stringify({ base_url: base, token }));
    else {
      const saved = sessionStorage.getItem(DEV_KEY);
      if (saved) ({ base_url: base, token } = JSON.parse(saved) as BackendInfo);
    }
  } catch {
    /* sessionStorage unavailable */
  }
  base ||= import.meta.env.VITE_JARVIS_BACKEND ?? null;
  token ||= import.meta.env.VITE_JARVIS_TOKEN ?? null;
  if (!base || !token) {
    throw new Error(
      "No backend configured. Running outside Tauri? Open the page with ?backend=http://127.0.0.1:PORT&token=TOKEN (see `make mock`).",
    );
  }
  return { base_url: base, token };
}

export async function restartBackend(): Promise<BackendInfo> {
  if (!isTauri) return resolveBackendInfo();
  try {
    return await tauriInvoke<BackendInfo>("restart_backend");
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "The Jarvis engine could not be restarted.");
  }
}

export type BackendExited = { code: number | null; message: string; lines: string[] };

export async function onBackendExited(cb: (p: BackendExited) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<BackendExited>("backend-exited", (e) => cb(e.payload));
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Open a link in the user's default browser. Never navigates the webview. */
export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) return;
  if (isTauri) {
    try {
      await openUrl(url);
      return;
    } catch (e) {
      console.warn("opener failed", e);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function setWindowTheme(theme: "light" | "dark" | null): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(theme);
  } catch (e) {
    console.warn("setTheme failed", e);
  }
}

export async function closeWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** Native file picker for the Chrome application. Returns null when cancelled. */
export async function pickChromeApp(): Promise<string | null> {
  if (!isTauri) {
    const typed = window.prompt("Path to Google Chrome (e.g. /Applications/Google Chrome.app)");
    return typed?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: "Choose Google Chrome",
    directory: false,
    multiple: false,
    defaultPath: "/Applications",
    filters: [{ name: "Application", extensions: ["app"] }],
  });
  return typeof picked === "string" ? picked : null;
}
