import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";

export default function Login() {
  const { user, ready, error: accountError, login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await register(displayName, email, password);
      else await login(email, password);
      navigate("/dashboard", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in right now.");
    } finally { setBusy(false); }
  }

  return <div className="login-page">
    <section className="login-shell" aria-labelledby="login-title">
      <div className="login-intro">
        <Link to="/" className="login-brand"><span>Food</span>Lens</Link>
        <p className="eyebrow">YOUR FOODLens ACCOUNT</p>
        <h1 id="login-title">Make the next choice more personal.</h1>
        <p className="login-copy">Save a location and preferences, keep a list of restaurants, and see why the canonical dataset recommends each match.</p>
        <div className="login-perks" aria-label="Customer account features">
          <div><span className="perk-icon">⌖</span><span><strong>Set your location</strong><small>Choose a supported city or area manually.</small></span></div>
          <div><span className="perk-icon">★</span><span><strong>Save preferences</strong><small>Use your cuisine, budget, and priority selections.</small></span></div>
        </div>
      </div>
      <div className="login-card">
        <div className="login-card-head"><h2>{mode === "register" ? "Create your account" : "Welcome back"}</h2><p>{mode === "register" ? "Your account is private and separate from the public demo." : "Sign in to load your saved customer preferences."}</p></div>
        {(error || accountError) && <div className="state error" role="alert">{error || accountError}</div>}
        <form className="login-form" onSubmit={submit}>
          {mode === "register" && <label htmlFor="display-name">Name<input id="display-name" autoComplete="name" maxLength={80} value={displayName} onChange={event => setDisplayName(event.target.value)} required /></label>}
          <label htmlFor="email">Email<input id="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} required /></label>
          <label htmlFor="password">Password<input id="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 10 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} required /></label>
          {mode === "register" && <small className="muted">Use at least 10 characters. FoodLens stores a password hash, never the plaintext password.</small>}
          <button className="login-submit" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}</button>
        </form>
        <p className="login-signup">{mode === "register" ? "Already have an account?" : "New to FoodLens?"} <button className="text-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Sign in" : "Create an account"}</button></p>
        <p className="login-terms">Account creation requires the FoodLens PostgreSQL service to be configured. <Link to="/demo">Try the public demo without an account.</Link></p>
      </div>
    </section>
  </div>;
}
