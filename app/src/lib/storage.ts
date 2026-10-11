// localStorage that never throws (private windows, blocked storage, SSR/tests).
export function lsGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function lsGetBool(key: string, fallback: boolean): boolean {
  const v = lsGet(key);
  return v == null ? fallback : v === "1";
}

export function lsSetBool(key: string, value: boolean): void {
  lsSet(key, value ? "1" : "0");
}

export const KEYS = {
  onboarded: "jarvis.onboarded",
  sidebar: "jarvis.sidebar",
  appearance: "jarvis.appearance",
} as const;
