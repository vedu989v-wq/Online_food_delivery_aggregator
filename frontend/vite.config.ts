import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The dev server proxies /api/* to the Express backend, so the browser only ever talks to one origin (no CORS pain).
export default defineConfig({ plugins: [react()], server: { host: true, port: 5173, allowedHosts: true, proxy: { '/api': 'http://localhost:4000' } } });
