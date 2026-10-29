import { KeyFileInput } from "./KeyFileInput";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, Dices, Eye, EyeOff, KeyRound } from "lucide-react";
import clsx from "clsx";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field, Segmented, Switch } from "./ui/Field";
import { Select } from "./ui/Select";
import { TagInput } from "./TagInput";
import { ApiError, errorMessage, post, put } from "@/lib/api";
import type { AccessPolicy, Credential, SecretInput, VaultKind } from "@/lib/types";
import { useConnections, useInvalidateInventory, useVault, useVaultPolicy } from "@/hooks/queries";
import { useAccess } from "@/lib/auth";
import { durationLabel, fieldLabels, generatePassword, kindLabels } from "@/lib/vault";

const CHECKOUT_CHOICES = [15, 30, 60, 120, 240, 480, 1440];
const ROTATION_CHOICES: [number, string][] = [
  [0, "Never"],
  [7, "Every week"],
  [30, "Every 30 days"],
  [60, "Every 60 days"],
  [90, "Every 90 days"],
  [180, "Every 180 days"],
  [365, "Every year"],
];

function PasswordInput({
  value,
  onChange,
  onGenerate,
  id,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onGenerate?: () => void;
  id?: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input
          id={id}
          className="input pr-9 font-mono"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-subtle hover:text-fg"
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      {onGenerate && (
        <Button
          icon={<Dices className="h-3.5 w-3.5" />}
          onClick={() => {
            onGenerate();
            setShow(true);
          }}
          title="Generate a strong password"
        >
          Generate
        </Button>
      )}
    </div>
  );
}

/** A section that starts closed and shows a one-line summary of what is inside. */
function Section({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left">
        <span className="text-sm font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-subtle">{summary}</span>
        <ChevronDown className={clsx("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>}
    </section>
  );
}

export function CredentialFormDialog({
  open,
  onOpenChange,
  credential,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  credential?: Credential;
}) {
  const { isAdmin, user } = useAccess();
  const policy = useVaultPolicy();
  const vault = useVault();
  const connections = useConnections();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<VaultKind>("login");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [totp, setTotp] = useState("");
  const [revealAllowed, setRevealAllowed] = useState(true);
  const [access, setAccess] = useState<AccessPolicy>("open");
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [breakGlass, setBreakGlass] = useState(true);
  const [rotationConn, setRotationConn] = useState("");
  const [rotateAfter, setRotateAfter] = useState(false);
  const [interval, setInterval] = useState(0);
  const [replace, setReplace] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateInventory();

  // Shared entries are the administrators'; members' entries are their own.
  const isShared = credential ? credential.owner_id === null : isAdmin;

  useEffect(() => {
    if (!open) return;
    setName(credential?.name ?? "");
    setKind(credential?.kind ?? "login");
    setUsername(credential?.username ?? "");
    setDomain(credential?.domain ?? "");
    setFolder(credential?.folder ?? "");
    setTags(credential?.tags ?? []);
    setUrl(credential?.url ?? "");
    setDescription(credential?.description ?? "");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setToken("");
    setNote("");
    setTotp("");
    setRevealAllowed((credential?.reveal_policy ?? "allowed") === "allowed");
    setAccess(credential?.access_policy ?? "open");
    setMaxMinutes(credential?.max_checkout_minutes ?? 60);
    setBreakGlass(credential?.break_glass ?? true);
    setRotationConn(credential?.rotation_connection_id ?? "");
    setRotateAfter(credential?.rotate_after_checkin ?? false);
    setInterval(credential?.rotation_interval_days ?? 0);
    setReplace(!credential);
    setErrors({});
    setFormError("");
  }, [open, credential]);

  const folders = useMemo(() => [...new Set((vault.data ?? []).map((e) => e.folder).filter(Boolean))].sort(), [vault.data]);
  const tagSuggestions = useMemo(() => [...new Set((vault.data ?? []).flatMap((e) => e.tags))].sort(), [vault.data]);
  // Rotation runs over an SSH connection of the same owner without a jump host.
  const sshConnections = useMemo(
    () =>
      (connections.data ?? []).filter(
        (c) =>
          c.protocol === "ssh" &&
          (c.device_owner_id ?? null) === (isShared ? null : (credential?.owner_id ?? user?.id ?? null)) &&
          !(c.settings as { jump_connection_id?: string } | undefined)?.jump_connection_id,
      ),
    [connections.data, isShared, credential, user],
  );

  const generate = () => setPassword(generatePassword(policy.data));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    const fields = { password, private_key: privateKey, passphrase, token, note, totp };
    // Editing: only typed fields change ("merge"); a new entry stores what was typed.
    const secret: SecretInput = !replace ? { mode: "keep" } : credential ? { mode: "merge", ...fields } : { mode: "set", ...fields };
    const body = {
      name,
      username,
      domain,
      secret,
      kind,
      folder,
      tags,
      url,
      description,
      reveal_policy: revealAllowed ? "allowed" : "never",
      access_policy: isShared ? access : "open",
      max_checkout_minutes: maxMinutes,
      break_glass: breakGlass,
      rotation_connection_id: kind === "login" ? rotationConn : "",
      rotate_after_checkin: kind === "login" && !!rotationConn && rotateAfter,
      rotation_interval_days: interval,
    };
    try {
      if (credential) await put(`/api/credentials/${credential.id}`, body);
      else await post("/api/credentials", body);
      await invalidate();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        // Open the closed sections that hold a field with an error.
        const has = (...names: string[]) => Object.keys(err.fields).some((f) => names.some((n) => f === n || f.startsWith(n)));
        if (has("domain", "url", "tags", "description")) setOpenDetails(true);
        if (has("secret.private_key", "secret.passphrase", "secret.note", "secret.totp")) setOpenSecrets(true);
        if (has("reveal_policy", "access_policy", "max_checkout_minutes")) setOpenAccess(true);
        if (has("rotation_connection_id", "rotation_interval_days", "rotate_after_checkin")) setOpenChanges(true);
      }
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const editing = !!credential;
  const keepHint = editing ? "Leave empty to keep the stored value" : undefined;
  const isLogin = kind === "login";
  const rotating = isLogin && !!rotationConn;
  const accessSummary = [
    revealAllowed ? "Can be shown" : "Connect only",
    isShared ? { open: "open to everyone given access", exclusive: `check-out, up to ${durationLabel(maxMinutes)}`, approval: "needs approval" }[access] : "private",
  ].join(" · ");
  const changeSummary = rotating
    ? `Automatic${interval ? `, every ${interval} days` : ", on request"}${rotateAfter ? ", after check-in" : ""}`
    : interval
      ? `Reminder every ${interval} days`
      : "Off";
  const filled = [domain && "domain", url && "web address", tags.length && "tags", description && "description"].filter(Boolean).join(", ");
  const extraSummary = (filled && filled[0].toUpperCase() + filled.slice(1)) || (kind === "login" ? "Domain, web address, tags, description" : "Web address, tags, description");
  const moreSecretsSummary = "SSH key, secret note, one-time code";

  // Sections open by themselves when they hold something that is not the default.
  const [openDetails, setOpenDetails] = useState(false);
  const [openSecrets, setOpenSecrets] = useState(false);
  const [openAccess, setOpenAccess] = useState(false);
  const [openChanges, setOpenChanges] = useState(false);
  useEffect(() => {
    if (!open) return;
    const c = credential;
    setOpenDetails(!!(c && (c.domain || c.url || c.tags.length || c.description)));
    setOpenSecrets(false);
    setOpenAccess(!!(c && (c.reveal_policy !== "allowed" || c.access_policy !== "open")));
    setOpenChanges(!!(c && (c.rotation_connection_id || c.rotation_interval_days)));
  }, [open, credential]);

  const primarySecret =
    kind === "api_token" ? (
      <Field label="Token" error={errors["secret.token"]}>
        <textarea className="input min-h-[64px] font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} placeholder={keepHint ?? "Paste the token"} />
      </Field>
    ) : kind === "note" ? (
      <Field label="Note" error={errors["secret.note"]}>
        <textarea className="input min-h-[96px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder={keepHint ?? "Recovery codes, a PIN, a licence key…"} />
      </Field>
    ) : kind === "ssh_key" ? (
      <>
        <Field label="Private key">
          <KeyFileInput value={privateKey} onChange={setPrivateKey} error={errors["secret.private_key"]} />
        </Field>
        <Field label="Key passphrase" optional error={errors["secret.passphrase"]}>
          <PasswordInput value={passphrase} onChange={setPassphrase} placeholder={keepHint ?? "Only if the key has one"} />
        </Field>
      </>
    ) : (
      <Field label="Password" error={errors["secret.password"]}>
        <PasswordInput value={password} onChange={setPassword} onGenerate={generate} placeholder={keepHint ?? "Type one or press Generate"} />
      </Field>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={credential ? `Edit ${credential.name}` : "New vault entry"}
      description={isShared ? "Shared: administrators manage it and choose who may use it." : "Private: only you can see and use it."}
      footer={
        <>
          {formError && <p className="mr-auto text-sm text-danger">{formError}</p>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="credential-form" loading={busy}>
            {credential ? "Save" : "Create entry"}
          </Button>
        </>
      }
    >
      <form noValidate id="credential-form" onSubmit={submit} className="space-y-4">
        <Segmented
          ariaLabel="Kind"
          value={kind}
          onChange={setKind}
          options={(Object.keys(kindLabels) as VaultKind[]).map((k) => ({ value: k, label: kindLabels[k] }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Core switch admin" required autoFocus />
          </Field>
          <Field label="Folder" optional error={errors.folder}>
            <input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} list="vault-folders" autoComplete="off" placeholder="e.g. Network/Core" />
          </Field>
          <datalist id="vault-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {kind !== "note" && kind !== "api_token" && (
            <Field label="Username" optional={kind === "ssh_key"} error={errors.username} className="sm:col-span-2">
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="e.g. root, admin or svc_backup"
              />
            </Field>
          )}
        </div>

        {editing && !replace ? (
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2/50 px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-muted">
              <KeyRound className="h-4 w-4 text-success" />
              {credential!.secret_fields.length ? `Stored: ${credential!.secret_fields.map((f) => fieldLabels[f] ?? f).join(", ")}` : "No secret stored"}
            </span>
            <Button size="sm" onClick={() => setReplace(true)}>
              Change secret
            </Button>
          </div>
        ) : (
          <>
            {primarySecret}
            {kind !== "note" && (
              <Section title="More secrets" summary={moreSecretsSummary} open={openSecrets} onToggle={() => setOpenSecrets((o) => !o)}>
                {isLogin && (
                  <>
                    <Field label="SSH private key" optional hint="For SSH connections that sign in with a key.">
                      <KeyFileInput value={privateKey} onChange={setPrivateKey} error={errors["secret.private_key"]} />
                    </Field>
                    <Field label="Key passphrase" optional error={errors["secret.passphrase"]}>
                      <PasswordInput value={passphrase} onChange={setPassphrase} placeholder={keepHint ?? "Only if the key has one"} />
                    </Field>
                  </>
                )}
                <Field label="Secret note" optional error={errors["secret.note"]}>
                  <textarea className="input min-h-[56px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder={keepHint ?? "Recovery codes, a PIN, security answers…"} />
                </Field>
                <Field label="One-time code secret" optional error={errors["secret.totp"]} hint="The vault then shows the current 6-digit code.">
                  <input
                    className="input font-mono"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={keepHint ?? "JBSW Y3DP EHPK 3PXP or otpauth://…"}
                  />
                </Field>
              </Section>
            )}
          </>
        )}

        <Section title="More details" summary={extraSummary} open={openDetails} onToggle={() => setOpenDetails((o) => !o)}>
          <div className="grid gap-4 sm:grid-cols-2">
            {isLogin && (
              <Field label="Domain" optional hint="Windows sign-ins only" error={errors.domain}>
                <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" spellCheck={false} placeholder="e.g. CORP" />
              </Field>
            )}
            <Field label="Web address" optional error={errors.url}>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="https://switch01.example.lan" />
            </Field>
            <Field label="Tags" optional error={errors.tags} className="sm:col-span-2">
              <TagInput value={tags} onChange={setTags} suggestions={tagSuggestions} />
            </Field>
          </div>
          <Field label="Description" optional error={errors.description} hint="Not secret: everyone who sees the entry reads it.">
            <textarea
              className="input min-h-[56px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Local admin of the core switches, for when RADIUS is down"
            />
          </Field>
        </Section>

        <Section title="Access" summary={accessSummary} open={openAccess} onToggle={() => setOpenAccess((o) => !o)}>
          <Switch checked={revealAllowed} onChange={setRevealAllowed} label="Allow showing and copying" description="Off: connect only, nobody sees the secret." />
          {isShared && (
            <>
              <Segmented
                ariaLabel="Access policy"
                value={access}
                onChange={setAccess}
                options={[
                  { value: "open", label: "Open", title: "Use and show at any time" },
                  { value: "exclusive", label: "Check-out", title: "One person at a time, for a limited time" },
                  { value: "approval", label: "Approval", title: "Members need an approved request" },
                ]}
              />
              <p className="text-xs text-subtle">
                {access === "open" && "Everyone given access uses it at any time."}
                {access === "exclusive" && "One person at a time checks it out with a reason. Connecting needs the check-out too."}
                {access === "approval" && "Members request it and an administrator approves. Administrators check out directly."}
              </p>
              {access !== "open" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Longest check-out" error={errors.max_checkout_minutes}>
                    <Select className="input" value={String(maxMinutes)} onChange={(e) => setMaxMinutes(Number(e.target.value))}>
                      {[...new Set([...CHECKOUT_CHOICES, maxMinutes])]
                        .sort((a, b) => a - b)
                        .map((m) => (
                          <option key={m} value={m}>
                            {durationLabel(m)}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  {access === "approval" && (
                    <div className="pt-5">
                      <Switch checked={breakGlass} onChange={setBreakGlass} label="Allow break-glass" description="Emergency use without approval, flagged in the log." />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Section>

        {kind !== "note" && (
          <Section title="Password changes" summary={changeSummary} open={openChanges} onToggle={() => setOpenChanges((o) => !o)}>
            {isLogin && (
              <Field label="Change it automatically on" optional error={errors.rotation_connection_id} hint="An SSH connection to the Linux or Unix computer that has this account.">
                <Select className="input" value={rotationConn} onChange={(e) => setRotationConn(e.target.value)}>
                  <option value="">Do not change it automatically</option>
                  {sshConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.device_name} / {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={rotating ? "How often" : "Reminder to change it"} error={errors.rotation_interval_days}>
                <Select className="input" value={String(interval)} onChange={(e) => setInterval(Number(e.target.value))}>
                  {[...ROTATION_CHOICES, ...(ROTATION_CHOICES.some(([d]) => d === interval) ? [] : [[interval, `Every ${interval} days`] as [number, string]])].map(([d, l]) => (
                    <option key={d} value={d}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              {rotating && isShared && access !== "open" && (
                <div className="pt-5">
                  <Switch checked={rotateAfter} onChange={setRotateAfter} label="Also after every check-in" description="What someone saw stops working." />
                </div>
              )}
            </div>
            {errors.rotate_after_checkin && <p className="text-xs text-danger">{errors.rotate_after_checkin}</p>}
          </Section>
        )}
      </form>
    </Dialog>
  );
}
