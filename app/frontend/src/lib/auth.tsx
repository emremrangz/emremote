import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, get, onUnauthorized, post, setCsrfToken } from "./api";
import type { Me, Permission, User } from "./types";

type State =
  | { status: "loading" }
  | { status: "setup"; tokenRequired: boolean }
  /** No accounts, but this server was set up before: the database looks lost. */
  | { status: "blocked" }
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
        const s = await get<{ setup_required: boolean; token_required?: boolean; setup_blocked?: boolean }>("/api/setup").catch(() => ({ setup_required: false, token_required: false, setup_blocked: false }));
        setState(s.setup_blocked ? { status: "blocked" } : s.setup_required ? { status: "setup", tokenRequired: !!s.token_required } : { status: "anonymous", notice: e.code === "vault_locked" || e.code === "session_ended" ? e.message : undefined });
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
        setState((s) => (s.status === "authenticated" ? { status: "anonymous", notice: code === "vault_locked" || code === "session_ended" ? message : "Your sign-in ended. Sign in again to continue." } : s));
      }),
    [qc],
  );

  // A tab nobody touches makes no requests, so it would keep showing the app after the sign-in ended on the server.
  // Ask in the background (this request does not count as activity) and when the tab is looked at again.
  const authenticated = state.status === "authenticated";
  useEffect(() => {
    if (!authenticated) return;
    const check = () => {
      if (document.visibilityState === "hidden" && !document.hasFocus()) return;
      get("/api/auth/session").catch(() => undefined); // a 401 reaches onUnauthorized below
    };
    const t = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, [authenticated]);

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
