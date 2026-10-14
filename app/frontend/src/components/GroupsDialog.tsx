import { useState, type FormEvent } from "react";
import { Pencil, Trash2, Check, X } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { useGroups, useInvalidateInventory } from "@/hooks/queries";
import { del, errorMessage, post, put } from "@/lib/api";
import type { Group } from "@/lib/types";

export function GroupsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups = useGroups();
  const invalidate = useInvalidateInventory();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Group | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await invalidate();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      await post("/api/groups", { name, description: "" });
      setName("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Groups" description="Organize devices by location, purpose or owner. Groups appear in the sidebar; assign devices to them when adding or editing a device." size="sm">
      <form noValidate onSubmit={create} className="flex gap-2">
        <input className="input" placeholder="New group name, e.g. Office" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} aria-label="New group name" autoFocus />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Create group
        </Button>
      </form>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <ul className="mt-4 divide-y divide-border rounded-md border border-border">
        {(groups.data ?? []).length === 0 && <li className="px-3 py-6 text-center text-sm text-subtle">No groups yet.</li>}
        {(groups.data ?? []).map((g) => (
          <li key={g.id} className="flex items-center gap-2 px-3 py-2">
            {editing?.id === g.id ? (
              <>
                <input className="input h-8" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus aria-label="Group name" />
                <Button size="icon-sm" variant="ghost" aria-label="Save" onClick={() => run(async () => { await put(`/api/groups/${g.id}`, { name: editName, description: g.description }); setEditing(null); })}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditing(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </>
            ) : confirmDelete === g.id ? (
              <>
                <span className="flex-1 text-sm">
                  Delete <b>{g.name}</b>? {g.device_count > 0 && `${g.device_count} device(s) become ungrouped.`}
                </span>
                <Button size="sm" variant="danger" onClick={() => run(async () => { await del(`/api/groups/${g.id}`); setConfirmDelete(null); })}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 truncate text-sm">{g.name}</span>
                <span className="text-xs text-subtle">{g.device_count}</span>
                <Button size="icon-sm" variant="ghost" aria-label={`Rename ${g.name}`} onClick={() => { setEditing(g); setEditName(g.name); }}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${g.name}`} onClick={() => setConfirmDelete(g.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
