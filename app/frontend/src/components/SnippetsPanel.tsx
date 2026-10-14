import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Braces, CornerDownLeft, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./ui/Toast";
import { useSnippets } from "@/hooks/queries";
import { ApiError, del, errorMessage, post, put } from "@/lib/api";
import type { Snippet } from "@/lib/types";

const lines = (s: Snippet) => s.body.split("\n").length;

function SnippetDialog({ open, onOpenChange, snippet }: { open: boolean; onOpenChange: (o: boolean) => void; snippet?: Snippet }) {
  const qc = useQueryClient();
  const [name, setName] = useState(snippet?.name ?? "");
  const [category, setCategory] = useState(snippet?.category ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    try {
      const data = { name: name.trim(), category: category.trim(), body };
      if (snippet) await put(`/api/snippets/${snippet.id}`, data);
      else await post("/api/snippets", data);
      await qc.invalidateQueries({ queryKey: ["snippets"] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={snippet ? "Edit snippet" : "New snippet"}
      description="Text you can type into any terminal session with one click. Only you see your snippets."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="snippet-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="snippet-form" onSubmit={submit} noValidate className="space-y-4" data-no-capture>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Field label="Name" error={errors.name}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Restart nginx" />
          </Field>
          <Field label="Category" optional error={errors.category}>
            <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="web" />
          </Field>
        </div>
        <Field label="Text" error={errors.body} hint={!errors.body ? "Several lines are typed one after another, and each line runs when typed." : undefined}>
          <textarea className="input min-h-[140px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} placeholder="sudo systemctl restart nginx" />
        </Field>
        {formError && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{formError}</p>}
      </form>
    </Dialog>
  );
}

/**
 * Personal command snippets for terminal sessions. Inserting types the text
 * into the session as if the user had typed it; nothing runs on the server.
 */
export function SnippetsPanel({ onInsert, onClose, disabled }: { onInsert: (text: string, run: boolean) => void; onClose: () => void; disabled: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error } = useSnippets();
  const [q, setQ] = useState("");
  const [form, setForm] = useState<{ open: boolean; snippet?: Snippet }>({ open: false });
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [confirm, setConfirm] = useState<{ snippet: Snippet; run: boolean } | null>(null);

  const recent = useMemo(
    () => (data ?? []).filter((s) => s.last_used_at).sort((a, b) => (b.last_used_at! > a.last_used_at! ? 1 : -1)).slice(0, 5),
    [data],
  );
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data ?? []).filter((s) => !n || [s.name, s.body, s.category].some((x) => x.toLowerCase().includes(n)));
  }, [data, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Snippet[]>();
    for (const s of filtered) m.set(s.category || "General", [...(m.get(s.category || "General") ?? []), s]);
    return [...m.entries()];
  }, [filtered]);

  const insert = async (s: Snippet, run: boolean) => {
    onInsert(s.body + (run ? "\n" : ""), run);
    try {
      await post(`/api/snippets/${s.id}/used`);
      qc.invalidateQueries({ queryKey: ["snippets"] });
    } catch {
      /* the text was already sent */
    }
  };
  // Several lines run as they are typed, so ask first.
  const choose = (s: Snippet, run: boolean) => (lines(s) > 1 ? setConfirm({ snippet: s, run }) : insert(s, run));

  const Row = ({ s }: { s: Snippet }) => (
    <li className="group flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{s.name}</p>
        <p className="truncate font-mono text-2xs text-subtle" title={s.body}>
          {s.body.split("\n")[0]}
          {lines(s) > 1 && <span className="ml-1 rounded bg-surface-3 px-1">+{lines(s) - 1} lines</span>}
        </p>
      </div>
      <Button size="icon-sm" variant="ghost" disabled={disabled} onClick={() => choose(s, false)} aria-label={`Type ${s.name}`} title="Type it, without pressing Enter">
        <CornerDownLeft className="h-3.5 w-3.5 rotate-180" />
      </Button>
      <Button size="icon-sm" variant="ghost" disabled={disabled} onClick={() => choose(s, true)} aria-label={`Run ${s.name}`} title="Type it and press Enter">
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${s.name}`}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Pencil className="h-4 w-4" />} onSelect={() => setForm({ open: true, snippet: s })}>
            Edit
          </MenuItem>
          <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={() => setDeleting(s)}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );

  return (
    <aside data-no-capture className="z-10 flex w-80 shrink-0 flex-col border-l border-border bg-surface" aria-label="Snippets">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Braces className="h-4 w-4 text-muted" /> Snippets
        </h2>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="New snippet" onClick={() => setForm({ open: true })}>
            <Plus className="h-4 w-4" />
          </Button>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close snippets">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input className="input pl-8" placeholder="Search snippets…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search snippets" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading && <p className="p-3 text-sm text-subtle">Loading…</p>}
        {error && <p className="p-3 text-sm text-danger">{errorMessage(error)}</p>}
        {data && data.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-muted">
            <p>No snippets yet.</p>
            <p className="mt-1 text-xs text-subtle">Save commands you type often and insert them with one click.</p>
            <Button className="mt-3" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm({ open: true })}>
              New snippet
            </Button>
          </div>
        )}
        {!q && recent.length > 0 && (
          <section aria-label="Recent snippets" className="mb-3">
            <h3 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Recent</h3>
            <ul>
              {recent.map((s) => (
                <Row key={`r-${s.id}`} s={s} />
              ))}
            </ul>
          </section>
        )}
        {groups.map(([cat, list]) => (
          <section key={cat} className="mb-3">
            <h3 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{cat}</h3>
            <ul>
              {list.map((s) => (
                <Row key={s.id} s={s} />
              ))}
            </ul>
          </section>
        ))}
        {data && data.length > 0 && filtered.length === 0 && <p className="p-3 text-sm text-subtle">No snippets match.</p>}
      </div>
      <p className="border-t border-border px-3 py-2 text-2xs text-subtle">Typed into the session as if you had typed it. Only you can see these.</p>

      <SnippetDialog key={form.snippet?.id ?? (form.open ? "new" : "closed")} open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} snippet={form.snippet} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Type ${confirm?.snippet.name ?? ""}?`}
        confirmLabel={confirm?.run ? "Type and run" : "Type it"}
        danger={false}
        onConfirm={async () => {
          await insert(confirm!.snippet, confirm!.run);
        }}
      >
        <p>This snippet has {confirm ? lines(confirm.snippet) : 0} lines. Each line is entered as it is typed, so every command except possibly the last runs right away.</p>
        <pre className="max-h-40 overflow-auto rounded bg-surface-2 p-2 font-mono text-2xs text-fg">{confirm?.snippet.body}</pre>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "snippet"}?`}
        confirmLabel="Delete"
        onConfirm={async () => {
          await del(`/api/snippets/${deleting!.id}`);
          await qc.invalidateQueries({ queryKey: ["snippets"] });
          toast.success("Snippet deleted");
        }}
      >
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </aside>
  );
}
