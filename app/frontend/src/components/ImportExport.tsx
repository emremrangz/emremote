import { useRef, useState } from "react";
import { ArrowDownUp, FileDown, FileUp } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import { Badge } from "./ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./ui/Menu";
import { useToast } from "./ui/Toast";
import { useAccess } from "@/lib/auth";
import { errorMessage, post } from "@/lib/api";
import { useInvalidateInventory } from "@/hooks/queries";

interface PreviewItem {
  name: string;
  address: string;
  group: string;
  connections: string[];
  conflict: boolean;
  problems: string[];
}
interface Preview {
  format: string;
  items: PreviewItem[];
  warnings: string[];
  valid: number;
  conflicts: number;
  invalid: number;
}
interface Result {
  created_devices: number;
  created_connections: number;
  created_groups: number;
  skipped: number;
  renamed: number;
  invalid: number;
  errors: string[];
}

const FORMATS = [
  { value: "auto", label: "Detect automatically" },
  { value: "emremote", label: "emremote export (JSON)" },
  { value: "ssh-config", label: "OpenSSH config (~/.ssh/config)" },
  { value: "csv", label: "CSV table" },
];
const FORMAT_NAMES: Record<string, string> = { emremote: "emremote export", "ssh-config": "OpenSSH config", csv: "CSV" };
const MAX_BYTES = 4 * 1024 * 1024;

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const fileRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState("auto");
  const [onConflict, setOnConflict] = useState<"skip" | "rename">("skip");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setContent("");
    setFileName("");
    setFormat("auto");
    setPreview(null);
    setResult(null);
    setError("");
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setTimeout(reset, 200);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setError("The file is too large (4 MB at most).");
      return;
    }
    setContent(await f.text());
    setFileName(f.name);
    setPreview(null);
    setError("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doPreview = () => run(async () => setPreview(await post<Preview>("/api/import/preview", { format, content })));
  const doImport = () =>
    run(async () => {
      const r = await post<Result>("/api/import", { format, content, on_conflict: onConflict });
      setResult(r);
      await invalidate();
      toast.success(`Imported ${r.created_devices} ${r.created_devices === 1 ? "device" : "devices"}`);
    });

  const importable = preview ? preview.valid + (onConflict === "rename" ? preview.conflicts : 0) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title="Import devices"
      description="Bring in devices from an emremote export, an OpenSSH config or a CSV table. Passwords are never imported; add them afterwards."
      footer={
        result ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            {!preview ? (
              <Button variant="primary" onClick={doPreview} loading={busy} disabled={!content.trim()}>
                Preview
              </Button>
            ) : (
              <Button variant="primary" onClick={doImport} loading={busy} disabled={importable === 0}>
                Import {importable} {importable === 1 ? "device" : "devices"}
              </Button>
            )}
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm" aria-live="polite">
          <p className="font-medium">
            Imported {result.created_devices} {result.created_devices === 1 ? "device" : "devices"} with {result.created_connections} connection methods
            {result.created_groups > 0 && ` and ${result.created_groups} new ${result.created_groups === 1 ? "group" : "groups"}`}.
          </p>
          <ul className="list-inside list-disc text-muted">
            {result.skipped > 0 && <li>{result.skipped} skipped because they already exist.</li>}
            {result.renamed > 0 && <li>{result.renamed} imported under a new name because the name was taken.</li>}
            {result.invalid > 0 && <li>{result.invalid} could not be imported (invalid).</li>}
          </ul>
          {result.errors.length > 0 && (
            <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-danger">
              <p className="font-medium">Some items failed:</p>
              <ul className="mt-1 list-inside list-disc text-xs">
                {result.errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <Field label="File or text" hint={fileName ? `Loaded ${fileName}` : "Choose a file or paste its content below."}>
              <div className="flex gap-2">
                <input ref={fileRef} type="file" className="sr-only" accept=".json,.csv,.txt,.conf,text/*,application/json" onChange={(e) => pick(e.target.files?.[0])} aria-label="Choose a file" />
                <Button icon={<FileUp className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
                  Choose file…
                </Button>
              </div>
            </Field>
            <Field label="Format">
              <Select
                className="input"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setPreview(null);
                }}
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {!preview && (
            <textarea
              className="input min-h-[160px] font-mono text-xs"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setFileName("");
              }}
              spellCheck={false}
              placeholder={"name,address,os,protocol,port,username\nweb-01,10.0.0.5,linux,ssh,22,deploy"}
              aria-label="Content to import"
            />
          )}
          {preview && (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                Read as <b className="font-medium text-fg">{FORMAT_NAMES[preview.format] ?? preview.format}</b>: {preview.valid} new, {preview.conflicts} already exist
                {preview.invalid > 0 && `, ${preview.invalid} invalid`}.
              </p>
              {preview.warnings.map((w) => (
                <p key={w} className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {w}
                </p>
              ))}
              {preview.conflicts > 0 && (
                <Field label="Devices that already exist (same name and address)">
                  <Select className="input" value={onConflict} onChange={(e) => setOnConflict(e.target.value as "skip" | "rename")}>
                    <option value="skip">Skip them</option>
                    <option value="rename">Import them again under a new name</option>
                  </Select>
                </Field>
              )}
              <div className="max-h-64 overflow-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-left text-xs text-subtle">
                    <tr>
                      <th className="py-2 pl-3 pr-3 font-medium">Name</th>
                      <th className="py-2 pr-3 font-medium">Address</th>
                      <th className="py-2 pr-3 font-medium">Methods</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.items.slice(0, 200).map((it, i) => (
                      <tr key={i} className="align-top">
                        <td className="py-1.5 pl-3 pr-3">
                          {it.name || <span className="text-subtle">(no name)</span>}
                          {it.group && <span className="ml-2 text-xs text-subtle">{it.group}</span>}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{it.address}</td>
                        <td className="py-1.5 pr-3 text-xs text-muted">{it.connections.join(", ") || "-"}</td>
                        <td className="py-1.5 pr-3">
                          {it.problems.length > 0 ? (
                            <span title={it.problems.join("\n")}>
                              <Badge tone="danger">Invalid</Badge>
                              <span className="mt-1 block text-2xs text-danger">{it.problems[0]}</span>
                            </span>
                          ) : it.conflict ? (
                            <Badge tone="warning">Exists</Badge>
                          ) : (
                            <Badge tone="success">New</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.items.length > 200 && <p className="border-t border-border px-3 py-2 text-xs text-subtle">Showing the first 200 of {preview.items.length}.</p>}
              </div>
              <button className="text-xs font-medium text-accent hover:underline" onClick={() => setPreview(null)}>
                Change the file or format
              </button>
            </div>
          )}
          {error && (
            <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function download(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "Import / Export" menu for the devices page. */
export function ImportExportMenu() {
  const { can } = useAccess();
  const [importing, setImporting] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button icon={<ArrowDownUp className="h-4 w-4" />}>Import / Export</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Export what you can see</MenuLabel>
          <MenuItem icon={<FileDown className="h-4 w-4" />} onSelect={() => download("/api/export?format=json")}>
            Export as JSON
          </MenuItem>
          <MenuItem icon={<FileDown className="h-4 w-4" />} onSelect={() => download("/api/export?format=csv")}>
            Export as CSV
          </MenuItem>
          {can("inventory.manage") && (
            <MenuItem icon={<FileUp className="h-4 w-4" />} onSelect={() => setImporting(true)}>
              Import devices…
            </MenuItem>
          )}
          <p className="max-w-[240px] px-2.5 pb-2 pt-1 text-xs text-muted">Exports never contain passwords, keys or saved credentials.</p>
        </MenuContent>
      </Menu>
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}
