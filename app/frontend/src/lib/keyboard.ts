// Detects the user's keyboard layout so the RDP server is told the right one
// (guacd converts key presses to scancodes using that layout).

const BY_LANGUAGE: [RegExp, string][] = [
  [/^tr/, "tr-tr-qwerty"],
  [/^de-ch/, "de-ch-qwertz"],
  [/^de/, "de-de-qwertz"],
  [/^fr-ca/, "fr-ca-qwerty"],
  [/^fr-be/, "fr-be-azerty"],
  [/^fr-ch/, "fr-ch-qwertz"],
  [/^fr/, "fr-fr-azerty"],
  [/^es-es$|^es$/, "es-es-qwerty"],
  [/^es-/, "es-latam-qwerty"],
  [/^it/, "it-it-qwerty"],
  [/^pt-br/, "pt-br-qwerty"],
  [/^pt/, "pt-pt-qwerty"],
  [/^sv/, "sv-se-qwerty"],
  [/^da/, "da-dk-qwerty"],
  [/^(nb|nn|no)/, "no-no-qwerty"],
  [/^pl/, "pl-pl-qwerty"],
  [/^cs/, "cs-cz-qwertz"],
  [/^hu/, "hu-hu-qwertz"],
  [/^ro/, "ro-ro-qwerty"],
  [/^ja/, "ja-jp-qwerty"],
  [/^en-gb|^en-ie/, "en-gb-qwerty"],
];

/** Layout from the physical key map (Chromium) — distinguishes e.g. Turkish Q from US. */
async function fromLayoutMap(): Promise<string | null> {
  const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return null;
  try {
    const m = await kb.getLayoutMap();
    const k = (code: string) => (m.get(code) ?? "").toLowerCase();
    if (k("KeyI") === "ı" || k("Quote") === "i") return "tr-tr-qwerty";
    if (k("KeyQ") === "a" && k("KeyA") === "q") return "fr-fr-azerty";
    if (k("KeyZ") === "y" && k("KeyY") === "z") {
      if (k("Minus") === "ß") return "de-de-qwertz";
      if (k("Semicolon") === "é" || k("Semicolon") === "ö") return k("Minus") === "'" ? "de-ch-qwertz" : "de-de-qwertz";
      return null; // other QWERTZ: fall back to the language
    }
    if (k("Semicolon") === "ñ") return null; // Spanish: language decides es/latam
    if (k("Semicolon") === "ò") return "it-it-qwerty";
    if (k("Semicolon") === "æ") return "da-dk-qwerty";
    if (k("Semicolon") === "ø") return "no-no-qwerty";
    if (k("Semicolon") === "ö" && k("Quote") === "ä") return "sv-se-qwerty";
    if (k("Backslash") === "#" && k("Quote") === "'") return "en-gb-qwerty";
    if (k("Semicolon") === ";" && k("Quote") === "'" && k("KeyQ") === "q") return "en-us-qwerty";
    return null;
  } catch {
    return null;
  }
}

export async function detectKeyboardLayout(): Promise<string> {
  const fromMap = await fromLayoutMap();
  if (fromMap) return fromMap;
  for (const lang of navigator.languages ?? [navigator.language]) {
    const l = (lang || "").toLowerCase();
    for (const [re, layout] of BY_LANGUAGE) if (re.test(l)) return layout;
    if (l.startsWith("en")) return "en-us-qwerty";
  }
  return "en-us-qwerty";
}
