import { useState, type KeyboardEvent } from "react";
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
  const add = (t: string) => {
    const tag = t.trim();
    if (!tag || value.some((v) => v.toLowerCase() === tag.toLowerCase()) || value.length >= 20) return;
    onChange([...value, tag.slice(0, 32)]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
      setDraft("");
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const listId = id ? `${id}-suggestions` : undefined;
  return (
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
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          add(draft);
          setDraft("");
        }}
        placeholder={value.length ? "" : "Add tags (Enter to add)"}
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
      />
      {listId && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  );
}
