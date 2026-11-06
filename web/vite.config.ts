import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the backend runs on :8080; the app calls it through the same origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/rpc': 'http://127.0.0.1:8080',
    },
  },
  build: { target: 'es2020', sourcemap: false },
});
