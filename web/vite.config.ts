import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Cast guards against the monorepo hoisting @vitejs/plugin-react against a
  // different Vite version than web's local install (structurally identical,
  // nominally distinct Plugin types).
  plugins: [react() as unknown as PluginOption],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_BASE_URL ?? 'http://localhost:4000', changeOrigin: true },
      '/health': { target: process.env.VITE_API_BASE_URL ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
