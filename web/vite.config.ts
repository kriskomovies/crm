import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Deliberately NOT `VITE_`-prefixed. Anything with that prefix is fair game to
 * be inlined into the client bundle, and this is a per-client API key that
 * grants the whole book of business -- it has to stay on the Node side of the
 * proxy. Read here, attached to the proxied request, never shipped.
 */
const API_KEY = process.env.SNAP_API_KEY ?? 'demo-key-001';
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * The API requires a per-client key on every /api and /v1 route, and the
 * browser is the one place the key cannot live. The dev proxy is already the
 * seam that hides the API's origin, so it is also the seam that authenticates:
 * the operator UI sends no credential and the proxy adds one. In production
 * Caddy does the same job in front of both.
 */
const proxy = (): ProxyOptions => ({
  target: API_URL,
  changeOrigin: true,
  configure: (p) => {
    p.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('authorization', `Bearer ${API_KEY}`);
    });
  },
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': proxy(),
      '/v1': proxy(),
    },
  },
});
