import type { Appearance } from "../api/types";
import { KEYS, lsGet, lsSet } from "./storage";
import { isTauri, setWindowTheme } from "./tauri";

const mql = (): MediaQueryList | null => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null);

export function isDark(appearance: Appearance): boolean {
  return appearance === "dark" || (appearance === "system" && !!mql()?.matches);
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark(appearance));
  root.classList.toggle("native", isTauri);
  lsSet(KEYS.appearance, appearance);
  // keeps the native vibrancy material and traffic lights in sync with the chosen theme
  void setWindowTheme(appearance === "system" ? null : appearance);
}

export function cachedAppearance(): Appearance {
  const v = lsGet(KEYS.appearance);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function watchSystemTheme(cb: () => void): () => void {
  const m = mql();
  if (!m) return () => {};
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
