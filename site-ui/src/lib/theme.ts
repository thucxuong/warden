// Theme: data-theme on <html>, the pick stored in localStorage "warden-theme" (same as the website).
// public/theme-init.js sets the first value before paint.

import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "warden-theme";
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function apply(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  for (const l of listeners) l();
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private mode: the pick lasts for this page only
  }
  apply(t);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The resolved theme; follows the OS while the user has not picked one. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  useEffect(() => {
    const m = media();
    const onChange = () => {
      if (stored() === null) apply(m.matches ? "dark" : "light");
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);
  return [theme, setTheme];
}
