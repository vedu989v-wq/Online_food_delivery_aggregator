import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setCsrfToken } from "./api";

export interface CustomerProfile {
  city: string | null;
  area: string | null;
  preferredCuisines: string[];
  vegetarianOnly: boolean;
  budgetPerPerson: number | null;
  priority: "value" | "cheapest" | "fastest" | "reliable" | "rated";
  interactionConsent: boolean;
}

export interface CustomerUser {
  id: string;
  email: string;
  displayName: string;
  role: "customer" | "admin";
  profile: CustomerProfile;
}

interface AuthContextValue {
  user: CustomerUser | null;
  ready: boolean;
  error: string;
  login(email: string, password: string): Promise<void>;
  register(displayName: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ user: CustomerUser; csrfToken: string }>("/auth/me");
      setUser(result.user);
      setCsrfToken(result.csrfToken);
      setError("");
    } catch (reason) {
      setUser(null);
      setCsrfToken(null);
      if (reason instanceof ApiError && reason.status === 401) setError("");
      else setError(reason instanceof Error ? reason.message : "Account service unavailable.");
    } finally { setReady(true); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api<{ user: CustomerUser; csrfToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setUser(result.user);
    setCsrfToken(result.csrfToken);
    setError("");
  }, []);

  const register = useCallback(async (displayName: string, email: string, password: string) => {
    const result = await api<{ user: CustomerUser; csrfToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) });
    setUser(result.user);
    setCsrfToken(result.csrfToken);
    setError("");
  }, []);

  const logout = useCallback(async () => {
    await api<void>("/auth/logout", { method: "POST" });
    setUser(null);
    setCsrfToken(null);
  }, []);

  const value = useMemo(() => ({ user, ready, error, login, register, logout, refresh }), [user, ready, error, login, register, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
