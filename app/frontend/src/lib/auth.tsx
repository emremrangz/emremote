import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, get, onUnauthorized, post, setCsrfToken } from "./api";
import type { Me, Permission, User } from "./types";

type State =
  | { status: "loading" }
  | { status: "setup"; tokenRequired: boolean }
  | { status: "anonymous"; notice?: string }
  | { status: "authenticated"; user: User; expiresAt: string };

interface AuthCtx {
  state: State;
  /** Resolves with a challenge when the account needs a second factor; then call login2fa. */
  login: (username: string, password: string) => Promise<{ challenge: string } | null>;
  login2fa: (challenge: string, code: string) => Promise<void>;
  setup: (token: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const qc = useQueryClient();

  const accept = useCallback((me: Me) => {
    setCsrfToken(me.csrf_token);
    setState({ status: "authenticated", user: me.user, expiresAt: me.expires_at });
  }, []);

  const refresh = useCallback(async () => {
    try {
      accept(await get<Me>("/api/auth/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const s = await get<{ setup_required: boolean; token_required?: boolean }>("/api/setup").catch(() => ({ setup_required: false, token_required: false }));
        setState(s.setup_required ? { status: "setup", tokenRequired: !!s.token_required } : { status: "anonymous", notice: e.code === "vault_locked" ? e.message : undefined });
      } else {
        // Server unreachable: show login, which will surface the error on submit.
        setState({ status: "anonymous" });
      }
    }
  }, [accept]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      onUnauthorized((code, message) => {
        setCsrfToken("");
        qc.clear();
        setState((s) => (s.status === "authenticated" ? { status: "anonymous", notice: code === "vault_locked" ? message : undefined } : s));
      }),
    [qc],
  );

  const value: AuthCtx = {
    state,
    refresh,
    login: async (username, password) => {
      const r = await post<Me | { two_factor_required: true; challenge: string }>("/api/auth/login", { username, password });
      if ("two_factor_required" in r) return { challenge: r.challenge };
      accept(r);
      return null;
    },
    login2fa: async (challenge, code) => accept(await post<Me>("/api/auth/login/2fa", { challenge, code })),
    setup: async (setup_token, username, password) =>
      accept(await post<Me>("/api/setup", { setup_token, username, password })),
    logout: async () => {
      try {
        await post("/api/auth/logout");
      } finally {
        setCsrfToken("");
        qc.clear();
        setState({ status: "anonymous" });
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}

/** What the signed-in user may do. Administrators may do everything. */
export function useAccess() {
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const can = (p: Permission) => !!user && (user.role === "admin" || user.effective_permissions.includes(p));
  return { user, isAdmin: user?.role === "admin", can };
}
