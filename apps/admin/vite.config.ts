import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.VITE_API_PROXY ?? 'http://localhost:8080';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: API },
      '/media': { target: API },
      '/g/': { target: API },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
});
