// Thin fetch wrapper: same-origin cookies, CSRF header on mutations, typed errors.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

let csrfToken = "";
export function setCsrfToken(token: string) {
  csrfToken = token;
}
export function getCsrfToken() {
  return csrfToken;
}

type Listener = (code: string, message: string) => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the emremote server. Check your network connection.");
  }

  if (res.status === 204) return undefined as T;
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401 && !path.startsWith("/api/auth/login")) {
      unauthorizedListeners.forEach((fn) => fn(err?.code ?? "", err?.message ?? ""));
    }
    throw new ApiError(
      res.status,
      err?.code ?? "http_" + res.status,
      err?.message ?? `Request failed (${res.status})`,
      err?.fields ?? {},
    );
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body ?? {} });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: body ?? {} });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Unexpected error";
}
