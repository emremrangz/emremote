// Password generator for vault forms. It mirrors internal/vault on the server
// (same character sets), so generated and rotated passwords look alike.

import type { VaultKind, VaultPolicy } from "./types";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!#$%&()*+,-./;<=>?@[]^_{|}~";
const AMBIGUOUS = "0Oo1lI|";

const defaultPolicy: VaultPolicy = {
  length: 24,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  no_ambiguous: true,
  request_valid_hours: 8,
};

function randomIndex(n: number): number {
  // Rejection sampling keeps the choice uniform.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function generatePassword(p: VaultPolicy = defaultPolicy): string {
  const strip = (s: string) => (p.no_ambiguous ? [...s].filter((c) => !AMBIGUOUS.includes(c)).join("") : s);
  const sets = [p.lower && LOWER, p.upper && UPPER, p.digits && DIGITS, p.symbols && SYMBOLS].filter(Boolean).map((s) => strip(s as string));
  if (sets.length === 0 || p.length < 12) return generatePassword(defaultPolicy);
  const all = sets.join("");
  const out = Array.from({ length: p.length }, () => all[randomIndex(all.length)]);
  // One character of each chosen kind at distinct positions.
  const pos = [...out.keys()];
  for (let i = pos.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [pos[i], pos[j]] = [pos[j], pos[i]];
  }
  sets.forEach((set, i) => (out[pos[i]] = set[randomIndex(set.length)]));
  return out.join("");
}

export const kindLabels: Record<VaultKind, string> = {
  login: "Sign-in",
  ssh_key: "SSH key",
  api_token: "API token",
  note: "Secure note",
};

export const strengthLabels = ["Very weak", "Weak", "Fair", "Good", "Strong"];

export const fieldLabels: Record<string, string> = {
  password: "Password",
  private_key: "Private key",
  passphrase: "Key passphrase",
  token: "Token",
  note: "Note",
  totp: "One-time code",
};

/** Minutes as "45 min" or "2 h 30 min". */
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function timeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  return durationLabel(Math.max(1, Math.round(ms / 60000))) + " left";
}
