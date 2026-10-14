import { useEffect, useState } from "react";

export type ThemePref = "dark" | "light" | "system";
const KEY = "emremote-theme";

function apply(pref: ThemePref) {
  const dark =
    pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem(KEY) as ThemePref) || "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* storage unavailable */
    }
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
  return [pref, setPref];
}
