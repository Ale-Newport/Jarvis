import { useEffect } from "react";
import { applyAppearance, cachedAppearance, watchSystemTheme } from "../lib/theme";
import { useApp } from "../store";

export function useTheme(): void {
  const appearance = useApp((s) => s.settings?.appearance);
  useEffect(() => {
    const a = appearance ?? cachedAppearance();
    applyAppearance(a);
    if (a !== "system") return;
    return watchSystemTheme(() => applyAppearance("system"));
  }, [appearance]);
}
