let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const method = (init?.method || "GET").toUpperCase();
  if (csrfToken && !path.startsWith("/auth/login") && !path.startsWith("/auth/register") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", csrfToken);
  }
  const base = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "/api";
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, credentials: "include" });
  } catch {
    throw new ApiError("The FoodLens API could not be reached. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
    const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : `Request failed (${response.status})`;
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
    if (code?.startsWith("PYTHON_SERVICE_") && typeof window !== "undefined") {
      window.dispatchEvent(new Event("foodlens:python-unavailable"));
    }
    throw new ApiError(message, response.status, code);
  }
  return body as T;
}

export const inr = (n: number | null | undefined) =>
  n == null ? "unknown" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
