import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import type { Meta } from './types';
import Search from './pages/Search';
import Restaurant from './pages/Restaurant';
import Admin from './pages/Admin';
import Login from './pages/Login';

export default function App() {
  return (
    <>
      {meta?.dataMode === 'synthetic' && <div className="banner">{meta.notice}</div>}
      <header className="top">
        <Link to="/" className="brand">FoodLens</Link>
        <nav><NavLink to="/">Search</NavLink><NavLink to="/admin">Data quality</NavLink><NavLink to="/login">Log in</NavLink></nav>
      </header>

      <main>
        {down && <div className="state error">Can't reach the API. Start the backend with <code>npm run dev</code> in /backend.</div>}
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Search />} />
          <Route path="/r/:id" element={<Restaurant />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<div className="state">Page not found. <Link to="/">Back to search</Link></div>} />
        </Routes>
      </main>
      <footer id="contact"><div className="footer-brand"><span className="brand-orbit"><span>F</span></span><b>FoodLens</b><p>Make every penny worth spending.</p></div><div><span className="section-label">GET STARTED</span><h2>Start saving<br /><span>on every order</span></h2></div><a className="primary-button" href="https://github.com/ucloud/orderwise" target="_blank" rel="noreferrer">View on GitHub <span>↗</span></a></footer>
    </div>
  );
}
