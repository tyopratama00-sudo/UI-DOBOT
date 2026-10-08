import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** glambot Go backend (API, /storage photos & frames, /health). */
const API = process.env.VITE_API_PROXY ?? 'http://localhost:8080';
/** dobot Flask service (sequence state at /detection). */
const ROBOT = process.env.VITE_ROBOT_PROXY ?? 'http://localhost:5001';
const proxy = {
  '/api': { target: API, changeOrigin: false },
  '/storage': { target: API, changeOrigin: false },
  '/health': { target: API, changeOrigin: false },
  '/dobot': { target: ROBOT, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/dobot/, '') },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: true, proxy },
  preview: { port: 5173, strictPort: true, host: true, proxy },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
