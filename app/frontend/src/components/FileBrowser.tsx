import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import clsx from "clsx";
import {
  ArrowUp,
  RefreshCw,
  FolderPlus,
  Upload,
  Download,
  Trash2,
  Pencil,
  Folder,
  File as FileIcon,
  FileSymlink,
  MoreHorizontal,
  Home,
  X,
  CheckCircle2,
  AlertCircle,
  Search,
} from "lucide-react";
import { ApiError, errorMessage, get, getCsrfToken, post } from "@/lib/api";
import { isExpired } from "@/hooks/useSSHAccess";
import type { FileEntry, FileListing } from "@/lib/types";
import { bytes, dateTime } from "@/lib/format";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/Spinner";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu";
import { useToast } from "./ui/Toast";

interface UploadJob {
  id: number;
  name: string;
  size: number;
  loaded: number;
  status: "uploading" | "done" | "error" | "exists";
  error?: string;
  file: File;
  dir: string;
}

const isDir = (e: FileEntry) => e.type === "dir" || e.target === "dir";

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name; // keeps the page in place even if the server answers with an error
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * SFTP file browser. `compact` is the narrow panel shown next to an SSH
 * terminal; otherwise it is the full-width device page view.
 */
export function FileBrowser({
  base,
  onExpired = () => {},
  compact,
  onSelectionChange,
  onPathChange,
  refreshKey,
}: {
  /** Files API base, e.g. /api/ssh-access/{id}/files or /api/devices/{id}/transfer */
  base: string;
  onExpired?: () => void;
  compact?: boolean;
  /** Reports the selected paths (used by the transfer page). */
  onSelectionChange?: (paths: string[]) => void;
  /** Reports the folder being shown. */
  onPathChange?: (path: string) => void;
  /** Changing this reloads the current folder. */
  refreshKey?: number;
}) {
  const toast = useToast();
  const [listing, setListing] = useState<FileListing | null>(null);
  const [path, setPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
    const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "mkdir" } | { kind: "rename"; entry: FileEntry } | { kind: "delete"; entries: FileEntry[] }>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    (e: unknown) => {
      if (isExpired(e)) onExpired();
      else toast.error(errorMessage(e));
    },
    [onExpired, toast],
  );

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError("");
      try {
        const l = await get<FileListing>(`${base}?path=${encodeURIComponent(p)}`);
        setListing(l);
        setPath(l.path);
        setSelected(new Set());
      } catch (e) {
        if (isExpired(e)) onExpired();
        else setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [base, onExpired],
  );

  useEffect(() => {
    load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    if (refreshKey) load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => onSelectionChange?.([...selected]), [selected, onSelectionChange]);
  useEffect(() => {
    if (path) onPathChange?.(path);
  }, [path, onPathChange]);

  const entries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (listing?.entries ?? []).filter((e) => (!f || e.name.toLowerCase().includes(f)));
  }, [listing, filter]);

  const open = (e: FileEntry) => (isDir(e) ? load(e.path) : download([e]));

  const download = (list: FileEntry[]) => {
    list.forEach((e, i) => setTimeout(() => triggerDownload(`${base}/download?path=${encodeURIComponent(e.path)}`, isDir(e) ? `${e.name}.zip` : e.name), i * 400));
  };

  // ---- Upload (XHR for progress) ----
  const runUpload = (job: UploadJob, overwrite = false) =>
    new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      const q = new URLSearchParams({ dir: job.dir, name: job.name, ...(overwrite ? { overwrite: "true" } : {}) });
      xhr.open("POST", `${base}/upload?${q}`);
      xhr.setRequestHeader("X-CSRF-Token", getCsrfToken());
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      const update = (patch: Partial<UploadJob>) => setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, ...patch } : x)));
      xhr.upload.onprogress = (ev) => update({ loaded: ev.loaded });
      xhr.onload = () => {
        if (xhr.status === 201) update({ status: "done", loaded: job.size });
        else {
          let msg = `Upload failed (${xhr.status})`;
          let code = "";
          try {
            const d = JSON.parse(xhr.responseText);
            msg = d.error?.message ?? msg;
            code = d.error?.code ?? "";
          } catch {
            /* ignore */
          }
          if (xhr.status === 410) onExpired();
          update({ status: code === "exists" ? "exists" : "error", error: msg });
        }
        resolve();
      };
      xhr.onerror = () => {
        update({ status: "error", error: "Network error" });
        resolve();
      };
      update({ status: "uploading", loaded: 0, error: undefined });
      xhr.send(job.file);
    });

  const startUploads = async (files: FileList | File[]) => {
    const dir = path;
    const jobs: UploadJob[] = Array.from(files).map((f, i) => ({
      id: Date.now() + i,
      name: f.name,
      size: f.size,
      loaded: 0,
      status: "uploading",
      file: f,
      dir,
    }));
    setUploads((u) => [...u.filter((x) => x.status === "uploading" || x.status === "exists" || x.status === "error"), ...jobs]);
    for (const j of jobs) await runUpload(j);
    load(dir);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
  };

  // ---- Dialog actions ----
  const submitDialog = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === "mkdir") await post(`${base}/mkdir`, { dir: path, name });
      if (dialog.kind === "rename") await post(`${base}/rename`, { path: dialog.entry.path, name });
      if (dialog.kind === "delete") {
        const r = await post<{ removed: number }>(`${base}/delete`, { paths: dialog.entries.map((e) => e.path), recursive: true });
        toast.success(`Deleted ${r.removed} item(s)`);
      }
      setDialog(null);
      load(path);
    } catch (e) {
      if (e instanceof ApiError && e.code === "exists") toast.error(e.message);
      else handle(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const crumbs = path === "/" ? [""] : path.split("/");

  return (
    <div
      className={clsx("relative flex min-h-0 flex-col", compact ? "h-full" : "min-h-[480px]")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
      data-no-capture
    >
      {/* Toolbar */}
      <div className={clsx("flex flex-wrap items-center gap-1.5 border-b border-border", compact ? "px-2 py-2" : "px-3 py-2.5")}>
        <Button variant="ghost" size="icon-sm" onClick={() => load(listing?.parent ?? "/")} disabled={path === "/"} aria-label="Parent folder" title="Parent folder">
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => load("")} aria-label="Home folder" title="Home folder">
          <Home className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => load(path)} aria-label="Refresh" title="Refresh">
          <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
        </Button>
        <div className="min-w-0 flex-1">
          {editingPath ? (
            <form noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setEditingPath(false);
                load(pathDraft);
              }}
            >
              <input
                autoFocus
                className="input h-7 font-mono text-xs"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onBlur={() => setEditingPath(false)}
                aria-label="Path"
              />
            </form>
          ) : (
            <div
              className="flex h-7 cursor-text items-center overflow-x-auto whitespace-nowrap rounded-md border border-transparent px-1 font-mono text-xs hover:border-border"
              onClick={() => {
                setPathDraft(path);
                setEditingPath(true);
              }}
              title="Click to type a path"
            >
              {crumbs.map((c, i) => {
                const target = i === 0 ? "/" : crumbs.slice(0, i + 1).join("/");
                return (
                  <span key={i} className="flex items-center">
                    {i > 1 && <span className="px-0.5 text-subtle">/</span>}
                    <button
                      className="rounded px-1 py-0.5 text-muted hover:bg-surface-2 hover:text-fg"
                      onClick={(e) => {
                        e.stopPropagation();
                        load(target);
                      }}
                    >
                      {i === 0 ? "/" : c}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {!compact && (
          <div className="relative w-44">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input className="input h-7 pl-7 text-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
          </div>
        )}
        <Button size="sm" icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => { setName(""); setDialog({ kind: "mkdir" }); }} title="New folder">
          {!compact && "New folder"}
        </Button>
        <Button size="sm" variant="primary" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()} title="Upload files">
          {!compact && "Upload"}
        </Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && startUploads(e.target.files)} />
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-1.5 text-xs">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download(selectedEntries)}>
            Download
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} className="text-danger hover:text-danger" onClick={() => setDialog({ kind: "delete", entries: selectedEntries })}>
            Delete
          </Button>
          <button className="ml-auto text-subtle hover:text-fg" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="px-4 py-10 text-center text-[13px]">
            <p className="text-danger">{error}</p>
            <Button size="sm" className="mt-3" onClick={() => load(listing?.path ?? "")}>
              Retry
            </Button>
          </div>
        ) : !listing ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-subtle">
            {filter ? (
              "No matching files"
            ) : (
              "This folder is empty. Drop files here to upload."
            )}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            {!compact && (
              <thead className="sticky top-0 z-[1] bg-surface">
                <tr className="border-b border-border text-left text-xs font-medium text-subtle">
                  <th className="w-9 py-2 pl-3" />
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="w-24 py-2 pr-3 text-right font-medium">Size</th>
                  <th className="w-44 py-2 pr-3 font-medium">Modified</th>
                  <th className="w-28 py-2 pr-3 font-medium">Permissions</th>
                  <th className="w-10 py-2 pr-2" />
                </tr>
              </thead>
            )}
            <tbody>
              {entries.map((e) => {
                const dir = isDir(e);
                const Icon = e.type === "link" ? FileSymlink : dir ? Folder : FileIcon;
                return (
                  <tr
                    key={e.path}
                    className={clsx("group border-b border-border/60 hover:bg-surface-2/70", selected.has(e.path) && "bg-surface-2")}
                    onDoubleClick={() => open(e)}
                  >
                    <td className={clsx("py-1.5", compact ? "w-7 pl-2" : "pl-3")}>
                      <input type="checkbox" checked={selected.has(e.path)} onChange={() => toggle(e.path)} className="h-3.5 w-3.5 accent-[rgb(var(--fg))]" aria-label={`Select ${e.name}`} />
                    </td>
                    <td className={clsx("max-w-0 py-1.5 pr-3", compact && "w-full")}>
                      <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => (dir ? load(e.path) : undefined)} title={dir ? "Open folder" : "Double-click to download"}>
                        <Icon className={clsx("h-4 w-4 shrink-0", dir ? "text-accent" : "text-subtle")} strokeWidth={1.75} />
                        <span className={clsx("truncate", dir && "font-medium")}>{e.name}</span>
                      </button>
                      {compact && <span className="ml-6 block truncate whitespace-nowrap text-2xs text-subtle">{dir ? dateTime(e.modified) : `${bytes(e.size)} · ${dateTime(e.modified)}`}</span>}
                    </td>
                    {!compact && (
                      <>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{dir ? "-" : bytes(e.size)}</td>
                        <td className="py-1.5 pr-3 text-muted">{dateTime(e.modified)}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-subtle">{e.mode}</td>
                      </>
                    )}
                    <td className="w-8 py-1 pr-2 text-right">
                      <Menu>
                        <MenuTrigger asChild>
                          <button className="rounded p-1 text-subtle opacity-60 hover:bg-surface-3 hover:text-fg group-hover:opacity-100" aria-label={`Actions for ${e.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </MenuTrigger>
                        <MenuContent>
                          {dir && (
                            <MenuItem icon={<Folder className="h-4 w-4" />} onSelect={() => load(e.path)}>
                              Open
                            </MenuItem>
                          )}
                          <MenuItem icon={<Download className="h-4 w-4" />} onSelect={() => download([e])}>
                            {dir ? "Download as .zip" : "Download"}
                          </MenuItem>
                          <MenuItem icon={<Pencil className="h-4 w-4" />} onSelect={() => { setName(e.name); setDialog({ kind: "rename", entry: e }); }}>
                            Rename
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={() => setDialog({ kind: "delete", entries: [e] })}>
                            Delete
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Upload queue */}
      {uploads.length > 0 && (
        <div className="max-h-44 overflow-y-auto border-t border-border bg-surface px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-medium">Uploads</span>
            <button className="text-subtle hover:text-fg" onClick={() => setUploads((u) => u.filter((x) => x.status === "uploading"))}>
              Clear
            </button>
          </div>
          <ul className="space-y-1.5">
            {uploads.map((u) => (
              <li key={u.id} className="text-xs">
                <div className="flex items-center gap-2">
                  {u.status === "done" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                  ) : u.status === "uploading" ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <span className="tabular-nums text-subtle">
                    {u.status === "uploading" ? `${Math.round((u.loaded / Math.max(1, u.size)) * 100)}%` : bytes(u.size)}
                  </span>
                  {u.status === "exists" && (
                    <button className="font-medium text-accent hover:underline" onClick={() => runUpload(u, true).then(() => load(path))}>
                      Overwrite
                    </button>
                  )}
                </div>
                {u.status === "uploading" && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full bg-fg/70 transition-[width]" style={{ width: `${(u.loaded / Math.max(1, u.size)) * 100}%` }} />
                  </div>
                )}
                {u.error && u.status !== "exists" && <p className="ml-5 text-danger">{u.error}</p>}
                {u.status === "exists" && <p className="ml-5 text-warning">A file with this name already exists.</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-fg/40 bg-bg/80 text-sm font-medium">
          Drop files to upload to {path}
        </div>
      )}

      <Dialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        size="sm"
        title={dialog?.kind === "mkdir" ? "New folder" : dialog?.kind === "rename" ? "Rename" : `Delete ${dialog?.kind === "delete" ? dialog.entries.length : 0} item(s)?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant={dialog?.kind === "delete" ? "danger" : "primary"} loading={busy} onClick={submitDialog} disabled={dialog?.kind !== "delete" && !name.trim()}>
              {dialog?.kind === "mkdir" ? "Create" : dialog?.kind === "rename" ? "Rename" : "Delete"}
            </Button>
          </>
        }
      >
        {dialog?.kind === "delete" ? (
          <div className="space-y-3 text-[13px] text-muted">
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 font-mono text-xs text-fg">
              {dialog.entries.map((e) => (
                <li key={e.path} className="truncate">
                  {e.path}
                  {isDir(e) && "/"}
                </li>
              ))}
            </ul>
            {dialog.entries.some(isDir) && <p className="text-warning">Folders are deleted together with everything inside them.</p>}
            <p>This permanently deletes the items on the remote computer. It cannot be undone.</p>
          </div>
        ) : (
          <form noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submitDialog();
            }}
          >
            <label className="label" htmlFor="fb-name">
              {dialog?.kind === "mkdir" ? `Folder name in ${path}` : "New name"}
            </label>
            <input id="fb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={255} />
          </form>
        )}
      </Dialog>
    </div>
  );
}
