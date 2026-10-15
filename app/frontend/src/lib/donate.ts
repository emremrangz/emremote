import { useCallback, useEffect, useState } from "react";

const KEY = "emremote-hide-donate";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether this browser hid the Donate button (kept in the browser, per person). */
export function useDonateHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setState] = useState(read);
  useEffect(() => {
    const onChange = () => setState(read());
    window.addEventListener("emremote-donate", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("emremote-donate", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  const set = useCallback((v: boolean) => {
    try {
      if (v) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    setState(v);
    window.dispatchEvent(new Event("emremote-donate"));
  }, []);
  return [hidden, set];
}
