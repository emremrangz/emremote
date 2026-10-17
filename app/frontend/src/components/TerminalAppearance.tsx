import { Palette, Minus, Plus, RotateCcw } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadio, MenuSeparator, MenuTrigger } from "./ui/Menu";
import { TERMINAL_FONTS, TERMINAL_THEMES } from "@/lib/constants";
import type { TerminalPrefs } from "@/lib/terminalPrefs";

export interface TerminalAppearanceProps {
  /** What the terminal uses right now (personal choice, else the connection's). */
  current: { color_scheme: string; font_name: string; font_size: number };
  /** True when a personal choice overrides the connection's setting. */
  customized: boolean;
  onChange: (p: Partial<TerminalPrefs>) => void;
  onReset: () => void;
}

function Swatch({ theme }: { theme: (typeof TERMINAL_THEMES)[number] }) {
  return (
    <span className="flex h-5 w-14 shrink-0 items-center gap-0.5 rounded border border-white/15 px-1" style={{ background: theme.bg }} aria-hidden="true">
      <span className="font-mono text-[10px] leading-none" style={{ color: theme.fg }}>
        Aa
      </span>
      {theme.accents.map((c) => (
        <span key={c} className="h-2 w-1.5 rounded-sm" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Toolbar menu for the look of an SSH or Telnet terminal. Changes reconnect the session. */
export function TerminalAppearance({ current, customized, onChange, onReset }: TerminalAppearanceProps) {
  const font = TERMINAL_FONTS.includes(current.font_name) ? current.font_name : TERMINAL_FONTS[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          className="flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-muted hover:bg-white/10 hover:text-fg"
          title="Terminal appearance"
          aria-label="Terminal appearance"
        >
          <Palette className="h-4 w-4" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Color theme (reconnects)</MenuLabel>
        <MenuRadio
          value={current.color_scheme}
          onChange={(v) => onChange({ color_scheme: v })}
          options={TERMINAL_THEMES.map((t) => ({
            value: t.value,
            label: (
              <span className="flex flex-1 items-center justify-between gap-3">
                {t.label}
                <Swatch theme={t} />
              </span>
            ),
          }))}
        />
        <MenuSeparator />
        <MenuLabel>Font</MenuLabel>
        <MenuRadio value={font} onChange={(v) => onChange({ font_name: v })} options={TERMINAL_FONTS.map((f) => ({ value: f, label: f }))} />
        <MenuSeparator />
        <MenuLabel>Text size: {current.font_size} pt</MenuLabel>
        <MenuItem icon={<Plus className="h-4 w-4" />} onSelect={() => onChange({ font_size: Math.min(48, current.font_size + 1) })}>
          Larger
        </MenuItem>
        <MenuItem icon={<Minus className="h-4 w-4" />} onSelect={() => onChange({ font_size: Math.max(6, current.font_size - 1) })}>
          Smaller
        </MenuItem>
        {customized && (
          <>
            <MenuSeparator />
            <MenuItem icon={<RotateCcw className="h-4 w-4" />} onSelect={onReset}>
              Use the connection's look
            </MenuItem>
          </>
        )}
        <p className="max-w-[260px] px-2.5 pb-2 pt-1 text-xs text-muted">Saved in this browser, for every SSH and Telnet session you open.</p>
      </MenuContent>
    </Menu>
  );
}
