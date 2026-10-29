import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, put } from "@/lib/api";
import type {
  AuditEvent,
  Connection,
  Credential,
  Dashboard,
  Device,
  Group,
  LoginSession,
  SystemInfo,
  ActiveSession,
  Team,
  UserRow,
  Snippet,
  Statistics,
  VaultEntry,
  VaultPolicy,
  VaultRequest,
} from "@/lib/types";

export const keys = {
  devices: ["devices"] as const,
  device: (id: string) => ["devices", id] as const,
  groups: ["groups"] as const,
  connections: ["connections"] as const,
  connection: (id: string) => ["connections", id] as const,
  credentials: ["credentials"] as const,
  vault: ["vault"] as const,
  vaultRequests: ["vault", "requests"] as const,
  dashboard: ["dashboard"] as const,
  audit: (params: string) => ["audit", params] as const,
  system: ["system"] as const,
  loginSessions: ["login-sessions"] as const,
  activeSessions: ["active-sessions"] as const,
  users: ["users"] as const,
  teams: ["teams"] as const,
};

export const useDevices = () =>
  useQuery({ queryKey: keys.devices, queryFn: () => get<Device[]>("/api/devices"), refetchInterval: 30_000 });
export const useDevice = (id: string) =>
  useQuery({ queryKey: keys.device(id), queryFn: () => get<Device>(`/api/devices/${id}`), refetchInterval: 30_000 });
export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: () => get<Group[]>("/api/groups") });
export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: () => get<Connection[]>("/api/connections") });
export const useDeviceConnections = (deviceId: string) =>
  useQuery({
    queryKey: [...keys.device(deviceId), "connections"],
    queryFn: () => get<Connection[]>(`/api/devices/${deviceId}/connections`),
  });
/** Quick connections (ids starting with "q_") live only in server memory. */
export const isQuickConnection = (id: string) => id.startsWith("q_");
export const connectionBase = (id: string) => (isQuickConnection(id) ? `/api/quick-connections/${id}` : `/api/connections/${id}`);
export const useConnection = (id: string) =>
  useQuery({ queryKey: keys.connection(id), queryFn: () => get<Connection>(connectionBase(id)), retry: isQuickConnection(id) ? false : 3 });
export const useCredentials = () =>
  useQuery({ queryKey: keys.credentials, queryFn: () => get<Credential[]>("/api/credentials") });
export const useVault = () =>
  useQuery({ queryKey: keys.vault, queryFn: () => get<VaultEntry[]>("/api/vault"), refetchInterval: 30_000 });
export const useVaultRequests = () =>
  useQuery({ queryKey: keys.vaultRequests, queryFn: () => get<VaultRequest[]>("/api/vault/requests"), refetchInterval: 30_000 });
export const useVaultPolicy = () =>
  useQuery({ queryKey: ["vault-policy"], queryFn: () => get<VaultPolicy>("/api/vault/policy"), staleTime: 60_000 });
export const useDashboard = () =>
  useQuery({ queryKey: keys.dashboard, queryFn: () => get<Dashboard>("/api/dashboard"), refetchInterval: 15_000 });
export const useStatistics = (days: number) =>
  useQuery({
    queryKey: ["statistics", days],
    queryFn: () => get<Statistics>(`/api/statistics?days=${days}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`),
    refetchInterval: 60_000,
  });
export const useSystem = () => useQuery({ queryKey: keys.system, queryFn: () => get<SystemInfo>("/api/system") });
export const useLoginSessions = () =>
  useQuery({ queryKey: keys.loginSessions, queryFn: () => get<LoginSession[]>("/api/auth/sessions") });
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => get<UserRow[]>("/api/users") });
export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => get<Team[]>("/api/teams") });
export const useSnippets = () => useQuery({ queryKey: ["snippets"], queryFn: () => get<Snippet[]>("/api/snippets") });
export const useActiveSessions = () =>
  useQuery({
    queryKey: keys.activeSessions,
    queryFn: () => get<ActiveSession[]>("/api/active-sessions"),
    refetchInterval: 10_000,
  });

interface AuditPage {
  events: AuditEvent[];
  next_cursor: number;
}
export const fetchAudit = (params: URLSearchParams) => get<AuditPage>(`/api/audit?${params.toString()}`);

/** Invalidate everything inventory-related after a mutation. */
export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.devices }),
      qc.invalidateQueries({ queryKey: keys.groups }),
      qc.invalidateQueries({ queryKey: keys.connections }),
      qc.invalidateQueries({ queryKey: keys.credentials }),
      qc.invalidateQueries({ queryKey: keys.vault }),
      qc.invalidateQueries({ queryKey: keys.dashboard }),
    ]);
}

export function useToggleFavorite() {
  const invalidate = useInvalidateInventory();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      put<Device>(`/api/devices/${id}/favorite`, { favorite }),
    onMutate: async ({ id, favorite }) => {
      await qc.cancelQueries({ queryKey: keys.devices });
      qc.setQueryData<Device[]>(keys.devices, (old) => old?.map((d) => (d.id === id ? { ...d, favorite } : d)));
      qc.setQueryData<Device>(keys.device(id), (old) => (old ? { ...old, favorite } : old));
    },
    onSettled: invalidate,
  });
}

export function useCheckDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<Device>(`/api/devices/${id}/check`),
    onSuccess: (d) => {
      qc.setQueryData(keys.device(d.id), d);
      qc.setQueryData<Device[]>(keys.devices, (old) => old?.map((x) => (x.id === d.id ? d : x)));
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

