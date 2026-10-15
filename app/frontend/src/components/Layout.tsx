import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import {
  LayoutDashboard,
  Monitor,
  Star,
  Cable,
  ArrowLeftRight,
  Users,
  BarChart3,
  KeyRound,
  ScrollText,
  Settings,
  LogOut,
  Menu as MenuIcon,
  X,
  Moon,
  Sun,
  Plus,
  Search,
  Radio,
  Heart,
} from "lucide-react";
import { useAccess, useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./ui/Menu";
import { useActiveSessions, useDevices, useGroups, useSystem } from "@/hooks/queries";
import { GroupsDialog } from "./GroupsDialog";
import { CommandPalette } from "./CommandPalette";
import { DonateDialog } from "./DonateDialog";
import { useDonateHidden } from "@/lib/donate";
import { DeviceFormDialog } from "./DeviceForm";
import { QuickConnectDialog } from "./QuickConnect";
import { useUpdateAvailable } from "@/hooks/useUpdateCheck";

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={clsx("flex items-center gap-2", className)}>
      <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="5.5" className="fill-primary" />
        <path d="M6.5 8.5 9.5 12l-3 3.5" fill="none" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 15.5h5.5" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {!compact && <span className="text-[15px] font-semibold tracking-[-0.01em]">emremote</span>}
    </span>
  );
}

function NavItem({
  to,
  icon: Icon,
  label,
  end,
  count,
  onNavigate,
  active,
}: {
  to: string;
  icon?: typeof Monitor;
  label: ReactNode;
  end?: boolean;
  count?: number;
  onNavigate?: () => void;
  active?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
          (active ?? isActive) ? "bg-surface-3/70 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 opacity-80" strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-xs tabular-nums text-subtle">{count}</span>}
    </NavLink>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">{title}</span>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function Sidebar({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const groups = useGroups();
  const devices = useDevices();
  const system = useSystem();
  const { can, isAdmin } = useAccess();
  const loc = useLocation();
  const [groupsOpen, setGroupsOpen] = useState(false);
  const params = new URLSearchParams(loc.search);
  const onDevices = loc.pathname === "/devices";
  const groupParam = onDevices ? params.get("group") : null;
  const all = devices.data ?? [];
  const ungrouped = all.filter((d) => !d.group_id).length;

  return (
    <>
      <nav className="flex-1 overflow-y-auto px-3 pb-4 pt-3" aria-label="Main">
        <button
            onClick={() => {
              onNavigate?.();
              onSearch();
            }}
            className="mb-3 flex h-9 w-full items-center gap-2 rounded-md border border-border bg-surface-2/60 px-2.5 text-left text-[13px] text-subtle transition-colors hover:border-border-strong hover:text-muted"
            aria-label="Search devices, pages and actions"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">Search…</span>
            <kbd className="kbd ml-auto">{mac ? "⌘" : "Ctrl"} K</kbd>
          </button>
        <div className="space-y-px">
          <NavItem to="/" end icon={LayoutDashboard} label="Overview" onNavigate={onNavigate} />
          <NavItem to="/statistics" icon={BarChart3} label="Statistics" onNavigate={onNavigate} />
          <NavItem to="/devices" icon={Monitor} label="All devices" count={all.length || undefined} onNavigate={onNavigate} active={onDevices && !groupParam} />
          <NavItem to="/favorites" icon={Star} label="Favorites" count={all.filter((d) => d.favorite).length || undefined} onNavigate={onNavigate} />
        </div>

        <Section
          title="Groups"
          action={
            can("inventory.manage") && (
              <button
                onClick={() => setGroupsOpen(true)}
                className="flex h-5 w-5 items-center justify-center rounded text-subtle hover:bg-surface-3 hover:text-fg"
                aria-label="Add or manage groups"
                title="Add or manage groups"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )
          }
        >
          {(groups.data ?? []).length === 0 ? (
            !can("inventory.manage") ? null : <button
              onClick={() => setGroupsOpen(true)}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} /> Create a group
            </button>
          ) : (
            <>
              {groups.data!.map((g) => (
                <NavItem
                  key={g.id}
                  to={`/devices?group=${g.id}`}
                  label={
                    <span className="flex items-center gap-2.5">
                      <span className="h-2 w-2 rounded-sm bg-border-strong" />
                      {g.name}
                    </span>
                  }
                  count={g.device_count}
                  onNavigate={onNavigate}
                  active={groupParam === g.id}
                />
              ))}
              {ungrouped > 0 && (
                <NavItem
                  to="/devices?group=none"
                  label={<span className="flex items-center gap-2.5 text-subtle"><span className="h-2 w-2 rounded-sm border border-border-strong" />Ungrouped</span>}
                  count={ungrouped}
                  onNavigate={onNavigate}
                  active={groupParam === "none"}
                />
              )}
            </>
          )}
        </Section>

        <Section title="Access">
          {can("files.use") && <NavItem to="/transfer" icon={ArrowLeftRight} label="SFTP transfer" onNavigate={onNavigate} />}
          <NavItem to="/connections" icon={Cable} label="Connection methods" onNavigate={onNavigate} />
          {can("credentials.manage") && <NavItem to="/credentials" icon={KeyRound} label="Credentials" onNavigate={onNavigate} />}
        </Section>

        <Section title={isAdmin ? "Administration" : "Account"}>
          {isAdmin && <NavItem to="/users" icon={Users} label="Users" onNavigate={onNavigate} />}
          <NavItem to="/activity" icon={ScrollText} label={isAdmin ? "Activity log" : "My activity"} onNavigate={onNavigate} />
          <NavItem to="/settings" icon={Settings} label="Settings" onNavigate={onNavigate} />
        </Section>
      </nav>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3 text-xs text-subtle">
        <span
          title={system.data ? `Gateway ${system.data.gateway === "reachable" ? "online" : "unreachable"}` : undefined}
          className={clsx(
            "h-1.5 w-1.5 rounded-full",
            system.data?.gateway === "reachable" ? "bg-success" : system.data ? "bg-danger" : "bg-subtle",
          )}
        />
        {system.data?.gateway === "unreachable" ? (
          <span className="text-danger">Gateway unreachable</span>
        ) : system.data?.latest_version && system.data.release_url ? (
          <a
            href={system.data.release_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent hover:underline"
            title="Open the release notes. Update with scripts/update.sh"
          >
            Update available: v{system.data.latest_version}
          </a>
        ) : (
          <span>{system.data ? "Up to date" : "…"}</span>
        )}
        <span className="ml-auto font-mono">v{system.data?.version ?? ""}</span>
      </div>
      <GroupsDialog open={groupsOpen} onOpenChange={setGroupsOpen} />
    </>
  );
}

function UserMenu() {
  const { state, logout } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const initial = (user?.username ?? "?").slice(0, 1).toUpperCase();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          className="flex h-8 items-center gap-2 rounded-md pl-1 pr-2 text-[13px] hover:bg-surface-2"
          aria-label="Account menu"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold">{initial}</span>
          <span className="hidden font-medium sm:inline">{user?.username}</span>
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Signed in as {user?.username}</MenuLabel>
        <Link to="/settings">
          <MenuItem icon={<Settings className="h-4 w-4" />}>Account settings</MenuItem>
        </Link>
        <MenuSeparator />
        <MenuItem icon={<LogOut className="h-4 w-4" />} onSelect={() => logout()}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const system = useSystem();
  const [donateHidden, setDonateHidden] = useDonateHidden();
  const showDonate = system.data?.donate !== false && !donateHidden;
  const navigate = useNavigate();
  const active = useActiveSessions();
  const loc = useLocation();
  const live = active.data?.length ?? 0;
  const updateAvailable = useUpdateAvailable();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 lg:px-4">
        <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 lg:hidden" aria-label="Open menu">
          <MenuIcon className="h-5 w-5" />
        </button>
        <Link to="/" className="flex items-center lg:w-[196px]">
          <Logo />
        </Link>
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          {updateAvailable && (
            <button
              onClick={() => window.location.reload()}
              className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 text-xs font-medium text-accent hover:bg-accent/20"
              title="emremote was updated. Reload to use the new version."
            >
              New version · Reload
            </button>
          )}
          {live > 0 && (
            <Link
              to="/settings#active-sessions"
              className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 text-xs font-medium text-success"
              title="Active remote sessions"
            >
              <Radio className="h-3.5 w-3.5" /> {live} live
            </Link>
          )}
          {showDonate && (
            <button
              onClick={() => setDonateOpen(true)}
              className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-fg"
              title="Support emremote"
            >
              <Heart className="h-3.5 w-3.5 text-danger" /> <span className="hidden sm:inline">Donate</span>
            </button>
          )}
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[228px] shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <Sidebar onSearch={() => setPaletteOpen(true)} />
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-surface animate-fade-in">
              <div className="flex h-12 items-center justify-between border-b border-border px-4">
                <Logo />
                <button onClick={() => setMobileOpen(false)} className="text-muted" aria-label="Close menu">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <Sidebar onNavigate={() => setMobileOpen(false)} onSearch={() => setPaletteOpen(true)} />
            </aside>
          </div>
        )}

        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg" key={loc.pathname.split("/")[1]}>
          <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onAddDevice={() => setAddOpen(true)}
        onQuickConnect={() => setQuickOpen(true)}
      />
      <DeviceFormDialog open={addOpen} onOpenChange={setAddOpen} onSaved={(d) => navigate(`/devices/${d.id}`)} />
      <QuickConnectDialog open={quickOpen} onOpenChange={setQuickOpen} />
      <DonateDialog
        open={donateOpen}
        onOpenChange={setDonateOpen}
        onHide={() => {
          setDonateHidden(true);
          setDonateOpen(false);
        }}
      />
    </div>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-[360px]">
        <Logo className="mb-8 justify-center" />
        {children}
        <p className="mt-8 text-center text-xs text-subtle">Self-hosted remote access · keep this server on a trusted network</p>
      </div>
    </div>
  );
}
