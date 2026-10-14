import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select } from "@/components/ui/Select";
import { KeyRound, LogOut, ShieldOff, MoreHorizontal, Pencil, Plus, Shield, Trash2, UserPlus, Users as UsersIcon, UsersRound, Ban, CheckCircle2 } from "lucide-react";
import { PageHeader, EmptyState, ErrorState, Badge } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Switch } from "@/components/ui/Field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { AccessEditor, MODE_OPTIONS, PERMISSIONS, type AccessValue } from "@/components/AccessEditor";
import { keys, useTeams, useUsers, useInvalidateInventory } from "@/hooks/queries";
import { useAccess } from "@/lib/auth";
import { ApiError, del, errorMessage, post, put } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Grants, Team, UserRow } from "@/lib/types";

const none: AccessValue = { mode: "none", deviceIds: [], groupIds: [], permissions: ["sessions.connect", "files.use"] };

function accessOf(x: { inventory_mode: AccessValue["mode"]; permissions: AccessValue["permissions"]; grants: Grants }): AccessValue {
  return { mode: x.inventory_mode, permissions: x.permissions, deviceIds: x.grants.device_ids, groupIds: x.grants.group_ids };
}

/** Short description of what a user or team can reach in the shared inventory. */
function inventoryText(mode: AccessValue["mode"], g: Grants): string {
  if (mode === "all") return "Everything shared";
  if (mode === "selected") return `${g.device_ids.length} devices, ${g.group_ids.length} groups`;
  return "Own inventory only";
}

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function Perms({ list }: { list: string[] }) {
  if (list.length === 0) return <span className="text-xs text-subtle">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((p) => (
        <Badge key={p}>{PERMISSIONS.find((x) => x.value === p)?.label ?? p}</Badge>
      ))}
    </span>
  );
}

// ---- User dialog (create and edit) ----

function UserDialog({ open, onOpenChange, user, teams }: { open: boolean; onOpenChange: (o: boolean) => void; user?: UserRow; teams: Team[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user: me } = useAccess();
  const editing = !!user;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [role, setRole] = useState<"admin" | "member">("member");
  const [teamId, setTeamId] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [access, setAccess] = useState<AccessValue>(none);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError("");
    setShowPw(false);
    setPassword("");
    if (user) {
      setUsername(user.username);
      setRole(user.role);
      setTeamId(user.team_id ?? "");
      setDisabled(user.disabled);
      setAccess(accessOf({ inventory_mode: user.inventory_mode, permissions: user.permissions, grants: user.grants }));
    } else {
      setUsername("");
      setRole("member");
      setTeamId("");
      setDisabled(false);
      setAccess(none);
    }
  }, [open, user]);

  const team = teams.find((t) => t.id === teamId);
  const self = user?.id === me?.id;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    const body = {
      role,
      team_id: role === "member" && teamId ? teamId : null,
      permissions: access.permissions.filter((p) => !(team?.permissions ?? []).includes(p)),
      inventory_mode: access.mode,
      device_ids: access.deviceIds,
      group_ids: access.groupIds,
    };
    try {
      if (editing) await put(`/api/users/${user!.id}`, { ...body, disabled });
      else await post("/api/users", { ...body, username: username.trim(), password });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: keys.teams })]);
      toast.success(editing ? `Saved ${user!.username}` : `Created ${username.trim()}`);
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
      size="lg"
      title={editing ? `Edit ${user!.username}` : "New user"}
      description={editing ? "Changes apply immediately. Their running remote sessions are closed so the new access takes effect." : "Create an account. They sign in with this username and password."}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="user-form" loading={busy}>
            {editing ? "Save changes" : "Create user"}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate className="space-y-5" autoComplete="off">
        {!editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" error={errors.username}>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus spellCheck={false} autoCapitalize="off" />
            </Field>
            <Field label="Password" error={errors.password} hint={!errors.password ? "At least 8 characters. They can change it under Settings." : undefined}>
              <div className="flex gap-1.5">
                <input aria-label="Password" className="input font-mono" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                <Button
                  size="sm"
                  onClick={() => {
                    setPassword(generatePassword());
                    setShowPw(true);
                  }}
                  title="Generate a strong password"
                >
                  Generate
                </Button>
              </div>
            </Field>
          </div>
        )}

        <div>
          <span className="label">Role</span>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface-2 p-1" role="radiogroup" aria-label="Role">
            {(
              [
                ["member", "Member", "Uses what they are given"],
                ["admin", "Administrator", "Everything, including users"],
              ] as const
            ).map(([v, label, hint]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={role === v}
                disabled={self}
                onClick={() => setRole(v)}
                className={`rounded-md px-3 py-1.5 text-left transition-colors disabled:opacity-60 ${role === v ? "bg-surface shadow-sm" : "text-muted hover:text-fg"}`}
              >
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-subtle">{hint}</span>
              </button>
            ))}
          </div>
          {errors.role && <p className="mt-1.5 text-xs text-danger">{errors.role}</p>}
        </div>

        {role === "admin" ? (
          <p className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-muted">
            Administrators can use and manage the whole shared inventory and every user. They have no private inventory of their own: what they add is shared.
          </p>
        ) : (
          <>
            <Field label="Team" optional hint={team ? "The team's permissions and shared devices are added to this user's own." : "A team bundles permissions and access for several users."} error={errors.team_id}>
              <Select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <AccessEditor value={access} onChange={setAccess} inherited={team?.permissions ?? []} inheritedFrom={team?.name} errors={errors} />
          </>
        )}

        {editing && (
          <div className="rounded-lg border border-border px-3 py-1.5">
            <Switch checked={disabled} onChange={setDisabled} disabled={self} label="Account disabled" description="A disabled user cannot sign in and is signed out at once. Nothing is deleted." />
          </div>
        )}
        {formError && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{formError}</p>}
      </form>
    </Dialog>
  );
}

// ---- Team dialog ----

function TeamDialog({ open, onOpenChange, team }: { open: boolean; onOpenChange: (o: boolean) => void; team?: Team }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<AccessValue>(none);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError("");
    setName(team?.name ?? "");
    setDescription(team?.description ?? "");
    setAccess(team ? accessOf({ inventory_mode: team.inventory_mode, permissions: team.permissions, grants: team.grants }) : none);
  }, [open, team]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    const body = { name: name.trim(), description: description.trim(), permissions: access.permissions, inventory_mode: access.mode, device_ids: access.deviceIds, group_ids: access.groupIds };
    try {
      if (team) await put(`/api/teams/${team.id}`, body);
      else await post("/api/teams", body);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.teams }), qc.invalidateQueries({ queryKey: keys.users })]);
      toast.success(team ? `Saved ${name.trim()}` : `Created team ${name.trim()}`);
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
      size="lg"
      title={team ? `Edit team ${team.name}` : "New team"}
      description="A team gives the same permissions and shared devices to everyone in it. Changing it updates all members at once."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="team-form" loading={busy}>
            {team ? "Save changes" : "Create team"}
          </Button>
        </>
      }
    >
      <form id="team-form" onSubmit={submit} noValidate className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Team name" error={errors.name}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Helpdesk" />
          </Field>
          <Field label="Description" optional error={errors.description}>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <AccessEditor value={access} onChange={setAccess} errors={errors} />
        {formError && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{formError}</p>}
      </form>
    </Dialog>
  );
}

// ---- Password reset ----

function PasswordDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPw("");
    setShow(false);
    setError("");
  }, [user]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(`/api/users/${user!.id}/password`, { new_password: pw });
      toast.success(`New password set for ${user!.username}. They were signed out.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Reset password for ${user?.username ?? ""}`}
      description="They are signed out everywhere and use the new password from now on. Their saved connection passwords keep working."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="pw-form" loading={busy}>
            Set password
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} noValidate className="space-y-3">
        <Field label="New password" error={error} hint={!error ? "At least 8 characters. Tell them in person or through a secure channel." : undefined}>
          <div className="flex gap-1.5">
            <input aria-label="New password" className="input font-mono" type={show ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus />
            <Button
              size="sm"
              onClick={() => {
                setPw(generatePassword());
                setShow(true);
              }}
            >
              Generate
            </Button>
          </div>
        </Field>
      </form>
    </Dialog>
  );
}

// ---- Page ----

export default function UsersPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidateInventory = useInvalidateInventory();
  const { user: me } = useAccess();
  const users = useUsers();
  const teams = useTeams();
  const [userForm, setUserForm] = useState<{ open: boolean; user?: UserRow }>({ open: false });
  const [teamForm, setTeamForm] = useState<{ open: boolean; team?: Team }>({ open: false });
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [deletingTeam, setDeletingTeam] = useState<Team | null>(null);
  const [keep, setKeep] = useState(true);

  useEffect(() => setKeep(true), [deleting]);

  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: keys.teams })]);

  if (users.isLoading || teams.isLoading) return <PageLoader />;
  if (users.error || !users.data) return <ErrorState error={users.error} onRetry={users.refetch} />;

  const summary = (u: UserRow): string => {
    if (u.role === "admin") return "Everything shared, manages users";
    const t = u.team_id ? teamById.get(u.team_id) : undefined;
    const modes = [u.inventory_mode, t?.inventory_mode].filter(Boolean);
    const mode = modes.includes("all") ? "all" : modes.includes("selected") ? "selected" : "none";
    const devs = new Set([...u.grants.device_ids, ...(t?.grants.device_ids ?? [])]);
    const grps = new Set([...u.grants.group_ids, ...(t?.grants.group_ids ?? [])]);
    const base = inventoryText(mode, { device_ids: [...devs], group_ids: [...grps] });
    return u.owned_devices > 0 ? `${base} + ${u.owned_devices} own` : base;
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Create accounts, group them into teams and decide who can see and do what. Each person can also keep a private inventory."
        actions={
          <>
            <Button icon={<UsersRound className="h-4 w-4" />} onClick={() => setTeamForm({ open: true })}>
              New team
            </Button>
            <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setUserForm({ open: true })}>
              New user
            </Button>
          </>
        }
      />

      <section className="card overflow-hidden" aria-label="Users">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="py-2.5 pl-4 pr-4 font-medium">User</th>
                <th className="py-2.5 pr-4 font-medium">Team</th>
                <th className="py-2.5 pr-4 font-medium">Shared inventory</th>
                <th className="py-2.5 pr-4 font-medium">Can do</th>
                <th className="py-2.5 pr-4 font-medium">Last sign-in</th>
                <th className="py-2.5 pr-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.data.map((u) => (
                <tr key={u.id} className="align-top hover:bg-surface-2/60">
                  <td className="py-3 pl-4 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold">{u.username.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <p className="flex flex-wrap items-center gap-1.5 font-medium">
                          {u.username}
                          {u.id === me?.id && <Badge>You</Badge>}
                          {u.role === "admin" && (
                            <Badge tone="accent">
                              <Shield className="h-3 w-3" /> Admin
                            </Badge>
                          )}
                          {u.disabled && <Badge tone="danger">Disabled</Badge>}
                          {u.two_factor_enabled && <Badge tone="success" title="Two-factor authentication is on">2FA</Badge>}
                        </p>
                        {u.active_sessions > 0 && <p className="text-xs text-success">{u.active_sessions} signed in</p>}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-muted">{u.team_name ?? <span className="text-subtle">-</span>}</td>
                  <td className="py-3 pr-4 text-muted">{summary(u)}</td>
                  <td className="py-3 pr-4">{u.role === "admin" ? <span className="text-xs text-muted">Everything</span> : <Perms list={u.effective_permissions} />}</td>
                  <td className="py-3 pr-4 text-xs text-muted">{u.last_login_at ? relativeTime(u.last_login_at) : "Never"}</td>
                  <td className="py-3 pr-3 text-right">
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.username}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem icon={<Pencil className="h-4 w-4" />} onSelect={() => setUserForm({ open: true, user: u })}>
                          Edit access
                        </MenuItem>
                        {u.id !== me?.id && (
                          <>
                            <MenuItem icon={<KeyRound className="h-4 w-4" />} onSelect={() => setResetting(u)}>
                              Reset password
                            </MenuItem>
                            {u.two_factor_enabled && (
                              <MenuItem
                                icon={<ShieldOff className="h-4 w-4" />}
                                onSelect={async () => {
                                  try {
                                    await post(`/api/users/${u.id}/2fa/reset`);
                                    toast.success(`Two-factor authentication was turned off for ${u.username}`);
                                    refresh();
                                  } catch (e) {
                                    toast.error(errorMessage(e));
                                  }
                                }}
                              >
                                Reset two-factor
                              </MenuItem>
                            )}
                            <MenuItem
                              icon={<LogOut className="h-4 w-4" />}
                              disabled={u.active_sessions === 0}
                              onSelect={async () => {
                                try {
                                  await post(`/api/users/${u.id}/sign-out`);
                                  toast.success(`${u.username} was signed out`);
                                  refresh();
                                } catch (e) {
                                  toast.error(errorMessage(e));
                                }
                              }}
                            >
                              Sign out everywhere
                            </MenuItem>
                            <MenuItem
                              icon={u.disabled ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                              onSelect={async () => {
                                try {
                                  await put(`/api/users/${u.id}`, {
                                    role: u.role,
                                    team_id: u.team_id,
                                    permissions: u.permissions,
                                    inventory_mode: u.inventory_mode,
                                    device_ids: u.grants.device_ids,
                                    group_ids: u.grants.group_ids,
                                    disabled: !u.disabled,
                                  });
                                  toast.success(u.disabled ? `${u.username} can sign in again` : `${u.username} was disabled`);
                                  refresh();
                                } catch (e) {
                                  toast.error(errorMessage(e));
                                }
                              }}
                            >
                              {u.disabled ? "Enable account" : "Disable account"}
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={() => setDeleting(u)}>
                              Delete user
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8" aria-label="Teams">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Teams</h2>
            <p className="text-xs text-subtle">Give the same permissions and shared devices to a group of people at once.</p>
          </div>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setTeamForm({ open: true })}>
            New team
          </Button>
        </div>
        {(teams.data ?? []).length === 0 ? (
          <div className="card">
            <EmptyState icon={<UsersIcon className="h-5 w-5" />} title="No teams yet">
              Create a team such as "Helpdesk" or "Network", choose what it may do and which shared devices it can reach, then add users to it.
            </EmptyState>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {teams.data!.map((t) => (
              <article key={t.id} className="card flex flex-col gap-3 p-4">
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{t.name}</h3>
                    <p className="truncate text-xs text-subtle">{t.description || `${t.member_count} ${t.member_count === 1 ? "member" : "members"}`}</p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit team ${t.name}`} onClick={() => setTeamForm({ open: true, team: t })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete team ${t.name}`} onClick={() => setDeletingTeam(t)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </header>
                <p className="text-xs text-muted">
                  <span className="text-subtle">Shared inventory: </span>
                  {MODE_OPTIONS.find((m) => m.value === t.inventory_mode) && inventoryText(t.inventory_mode, t.grants)}
                </p>
                <Perms list={t.permissions} />
                <p className="mt-auto text-xs text-subtle">
                  {t.member_count} {t.member_count === 1 ? "member" : "members"}
                  {t.member_count > 0 && ": " + users.data.filter((u) => u.team_id === t.id).map((u) => u.username).join(", ")}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <UserDialog open={userForm.open} onOpenChange={(o) => setUserForm((s) => ({ ...s, open: o }))} user={userForm.user} teams={teams.data ?? []} />
      <TeamDialog open={teamForm.open} onOpenChange={(o) => setTeamForm((s) => ({ ...s, open: o }))} team={teamForm.team} />
      <PasswordDialog user={resetting} onClose={() => setResetting(null)} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.username ?? "user"}?`}
        confirmLabel="Delete user"
        onConfirm={async () => {
          await del(`/api/users/${deleting!.id}?keep_inventory=${keep}`);
          toast.success(`Deleted ${deleting!.username}`);
          await Promise.all([refresh(), invalidateInventory()]);
        }}
      >
        <p>They are signed out and their account is removed. This cannot be undone.</p>
        {!!deleting && deleting.owned_devices > 0 && (
          <label className="flex items-start gap-2.5 rounded-md border border-border p-2.5">
            <input type="checkbox" className="mt-1 h-3.5 w-3.5 accent-[rgb(var(--fg))]" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>
              <span className="block text-fg">Keep their {deleting.owned_devices} devices</span>
              <span className="block text-xs text-subtle">
                {keep ? "Their devices, groups and saved credentials move to the shared inventory." : "Their devices, groups and saved credentials are deleted with them."}
              </span>
            </span>
          </label>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deletingTeam}
        onOpenChange={(o) => !o && setDeletingTeam(null)}
        title={`Delete team ${deletingTeam?.name ?? ""}?`}
        confirmLabel="Delete team"
        onConfirm={async () => {
          await del(`/api/teams/${deletingTeam!.id}`);
          toast.success(`Deleted team ${deletingTeam!.name}`);
          await refresh();
        }}
      >
        <p>
          {deletingTeam?.member_count
            ? `${deletingTeam.member_count} member(s) lose the permissions and shared devices this team gave them. Their own settings stay.`
            : "The team has no members."}
        </p>
      </ConfirmDialog>
    </>
  );
}
