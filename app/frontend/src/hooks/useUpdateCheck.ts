import { useEffect, useState } from "react";

/** The entry script this tab was loaded with, e.g. /assets/index-AbC123.js. */
function currentEntry(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src).pathname : null;
}

/**
 * Detects that emremote was updated while this tab stayed open (the served
 * index.html references a different entry bundle), so the user can reload
 * instead of running stale code.
 */
export function useUpdateAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const mine = currentEntry();
    if (!mine) return; // development server
    let stopped = false;
    const check = async () => {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const m = html.match(/\/assets\/index-[\w-]+\.js/);
        if (!stopped && m && m[0] !== mine) setAvailable(true);
      } catch {
        /* offline; try later */
      }
    };
    const t = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, []);
  return available;
}
