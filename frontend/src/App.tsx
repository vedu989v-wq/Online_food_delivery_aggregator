import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { AuthProvider, useAuth } from "./AuthContext";
import type { Meta } from "./types";
import Search from "./pages/Search";
import Restaurant from "./pages/Restaurant";
import Admin from "./pages/Admin";
import Login from "./pages/Login";
import SmartMeal from "./pages/SmartMeal";
import SharedCart from "./pages/SharedCart";
import { Sustainability, Savings } from "./pages/Insights";
import Landing from "./pages/Landing";
import Demo from "./pages/Demo";
import Dashboard from "./pages/Dashboard";

export default function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}

function RequireAccount({ admin = false }: { admin?: boolean }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="state">Checking your account…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== "admin") return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

function AppShell() {
  const { user, logout } = useAuth();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [down, setDown] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    setDown(false);
    api<Meta>("/meta").then(data => { setMeta(data); setDown(false); }).catch(() => setDown(true));
  }, [retryCount]);

  useEffect(() => {
    const showUnavailable = () => setDown(true);
    window.addEventListener("foodlens:python-unavailable", showUnavailable);
    return () => window.removeEventListener("foodlens:python-unavailable", showUnavailable);
  }, []);

  async function handleLogout() {
    setLogoutError("");
    try { await logout(); window.location.assign("/"); }
    catch (error) { setLogoutError(error instanceof Error ? error.message : "Could not sign out."); }
  }

  return <>
    {meta?.dataMode === "synthetic" && <div className="banner">{meta.notice}</div>}
    <header className="top">
      <Link to="/" className="brand">FoodLens</Link>
      <nav aria-label="Main navigation">
        <NavLink to="/demo">Demo</NavLink>
        <NavLink to="/search">Explore</NavLink>
        <NavLink to="/smart-meal">Smart meal</NavLink>
        <NavLink to="/shared-cart">Basket split</NavLink>
        {user ? <><NavLink to="/dashboard">My space</NavLink>{user.role === "admin" && <NavLink to="/admin">Data quality</NavLink>}<button className="nav-button" onClick={handleLogout}>Sign out</button></> : <NavLink to="/login">Sign in</NavLink>}
      </nav>
    </header>

    <main>
      {down && <div className="state error" role="alert">The restaurant data API is unavailable. If the Render Python service is asleep, open its health endpoint, wait until it reports <code>status: ok</code>, then retry. <a className="btn ghost" href={import.meta.env.VITE_PYTHON_WAKE_URL || "https://foodlens-python-api.onrender.com/api/health"} target="_blank" rel="noreferrer">Wake Python service</a> <button className="btn ghost" onClick={() => setRetryCount(count => count + 1)}>Retry connection</button></div>}
      {logoutError && <div className="state error" role="alert">{logoutError}</div>}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/search" element={<Search />} />
        <Route path="/r/:id" element={<Restaurant />} />
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAccount />}><Route path="/dashboard" element={<Dashboard />} /></Route>
        <Route element={<RequireAccount admin />}><Route path="/admin" element={<Admin />} /></Route>
        <Route path="/smart-meal" element={<SmartMeal />} />
        <Route element={<RequireAccount />}><Route path="/shared-cart" element={<SharedCart />} /></Route>
        <Route path="/sustainability" element={<Sustainability />} />
        <Route path="/savings" element={<Savings />} />
        <Route path="*" element={<div className="state">Page not found. <Link to="/">Back to FoodLens</Link></div>} />
      </Routes>
    </main>

    <footer id="contact">
      <div className="footer-brand"><span className="brand-orbit"><span>F</span></span><b>FoodLens</b><p>Make every penny worth spending.</p></div>
      <div><span className="section-label">GET STARTED</span><h2>Compare clearly<br /><span>choose confidently</span></h2></div>
      <Link className="primary-button" to="/demo">Try the sample demo <span>↗</span></Link>
    </footer>
  </>;
}
