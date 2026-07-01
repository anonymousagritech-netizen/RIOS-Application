import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Cast guards against the monorepo hoisting @vitejs/plugin-react against a
  // different Vite version than web's local install (structurally identical,
  // nominally distinct Plugin types).
  plugins: [react() as unknown as PluginOption],
  build: {
    rollupOptions: {
      output: {
        // Keep the stable framework code in one long-cacheable vendor chunk so
        // the (now route-split, D-4) app chunks stay small and change without
        // re-downloading React et al.
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // Bind all interfaces so the dev server is reachable on both 127.0.0.1 and
    // ::1 (CI runners resolve `localhost` to IPv6 first; the API binds 0.0.0.0,
    // so the web server must too for the e2e readiness probe to connect).
    host: true,
    proxy: {
      '/api': { target: process.env.VITE_API_BASE_URL ?? 'http://localhost:4000', changeOrigin: true },
      '/health': { target: process.env.VITE_API_BASE_URL ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
