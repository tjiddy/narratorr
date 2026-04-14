import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { manualChunks } from './src/client/lib/manual-chunks';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/client',
  base: './',
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, './src/core'),
      '@': path.resolve(__dirname, './src/client'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
