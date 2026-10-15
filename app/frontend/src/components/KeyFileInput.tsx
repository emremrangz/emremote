import { useRef, useState } from "react";
import { FileKey2, Upload, X } from "lucide-react";
import clsx from "clsx";
import { Button } from "./ui/Button";

const MAX_BYTES = 32 * 1024;

/** What the first lines of a private key say about it (never shown: only the kind of key). */
export function describeKey(text: string): { kind: string; encrypted: boolean } {
  const m = text.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
  const label = m?.[1] ?? "";
  const kind = label.startsWith("OPENSSH") ? "OpenSSH key" : label.startsWith("RSA") ? "RSA key (PEM)" : label.startsWith("EC") ? "ECDSA key (PEM)" : label.startsWith("DSA") ? "DSA key (PEM)" : label === "PRIVATE KEY" ? "PKCS#8 key" : "Private key";
  let encrypted = /ENCRYPTED/.test(text.slice(0, 400));
  if (!encrypted && label.startsWith("OPENSSH")) {
    try {
      const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").slice(0, 160);
      encrypted = /bcrypt/.test(atob(body));
    } catch {
      /* not decodable: treat as plain */
    }
  }
  return { kind, encrypted };
}

/** The first problem with a candidate key file, found in the browser so the person sees it at once. */
export function keyFileProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "The file is empty.";
  if (t.length > MAX_BYTES) return "That file is too large to be an SSH key (the limit is 32 KB).";
  if (t.includes("PuTTY-User-Key-File")) return "PuTTY .ppk keys are not supported. In PuTTYgen choose Conversions, then Export OpenSSH key, and use that file.";
  if (/^(ssh-|ecdsa-|sk-)/.test(t) || (t.includes("PUBLIC KEY-----") && !t.includes("PRIVATE KEY-----"))) return "That is a public key (usually the .pub file). Choose the private key instead: the same name without .pub.";
  if (!t.startsWith("-----BEGIN ") || !t.includes("PRIVATE KEY-----")) return "This does not look like a private key. It should start with -----BEGIN … PRIVATE KEY-----.";
  return null;
}

/**
 * Chooses an SSH private key: pick or drop a file (.pem, id_rsa, id_ed25519, .key …) or paste the text.
 * The key is sent to the server once and stored encrypted; it is never shown again.
 */
export function KeyFileInput({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const [over, setOver] = useState(false);
  const [pasting, setPasting] = useState(false);

  const accept = (text: string, fileName: string) => {
    const p = keyFileProblem(text);
    if (p) {
      setProblem(p);
      return;
    }
    setProblem("");
    setName(fileName);
    setPasting(false);
    onChange(text.replace(/\r\n/g, "\n").trim() + "\n");
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES * 2) {
      setProblem("That file is too large to be an SSH key (the limit is 32 KB).");
      return;
    }
    accept(await f.text(), f.name);
  };

  if (value.trim()) {
    const d = describeKey(value);
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-sm">
        <FileKey2 className="h-4 w-4 shrink-0 text-success" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name || "Pasted key"}</span>
          <span className="block text-xs text-subtle">
            {d.kind}
            {d.encrypted ? " · protected by a passphrase, enter it below" : ""}
          </span>
        </span>
        <Button size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => { onChange(""); setName(""); }}>
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          readFile(e.dataTransfer.files[0]);
        }}
        className={clsx("flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-3 text-sm transition-colors", over ? "border-accent bg-accent/10" : "border-border-strong")}
      >
        <Upload className="h-4 w-4 text-muted" />
        <span className="min-w-0 flex-1 text-muted">Drop a key file here (.pem, .key, id_rsa, id_ed25519 …)</span>
        <Button size="sm" onClick={() => input.current?.click()}>
          Choose file…
        </Button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label="SSH private key file"
          onChange={(e) => {
            readFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {pasting ? (
        <textarea
          className="input min-h-[96px] font-mono text-2xs"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          spellCheck={false}
          autoFocus
          aria-label="SSH private key text"
          onChange={(e) => {
            const t = e.target.value;
            if (!t.trim()) return;
            const p = keyFileProblem(t);
            if (!p && t.includes("-----END ")) accept(t, "");
            else setProblem(p && t.length > 40 ? p : "");
          }}
        />
      ) : (
        <button type="button" className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => setPasting(true)}>
          or paste the key text instead
        </button>
      )}
      {(problem || error) && <p className="text-xs text-danger">{problem || error}</p>}
    </div>
  );
}
