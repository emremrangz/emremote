import { useMemo, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

export function TagInput({
  value,
  onChange,
  suggestions = [],
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  id?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()) && (!q || s.toLowerCase().includes(q))).slice(0, 50);
  }, [suggestions, value, draft]);
  const showList = open && options.length > 0;
  const add = (t: string) => {
    const tag = t.trim();
    if (!tag || value.some((v) => v.toLowerCase() === tag.toLowerCase()) || value.length >= 20) return;
    onChange([...value, tag.slice(0, 32)]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const n = options.length;
      if (n) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === "Escape" && showList) {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(showList && active >= 0 && e.key === "Enter" ? options[active] : draft);
      setDraft("");
      setActive(-1);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const listId = id ? `${id}-suggestions` : undefined;
  return (
    <div className="relative">
      <div className="input flex h-auto min-h-9 flex-wrap items-center gap-1.5 py-1.5">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-xs">
            {t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`} className="text-subtle hover:text-fg">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          onBlur={() => {
            add(draft);
            setDraft("");
            setOpen(false);
            setActive(-1);
          }}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={value.length ? "" : "Add tags (Enter to add)"}
          className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
        />
      </div>
      {showList && (
        <ul id={listId} role="listbox" aria-label="Existing tags" className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-surface p-1 text-[13px] shadow-pop">
          {options.map((s, i) => (
            <li key={s} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                className={"flex w-full rounded px-2.5 py-1.5 text-left hover:bg-surface-2 " + (i === active ? "bg-surface-2" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(s);
                  setDraft("");
                  setActive(-1);
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
