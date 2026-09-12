import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Relative asset URLs: the same build runs from a web server and inside the desktop app.
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The 4000x3000 benchmark takes minutes; run it explicitly via `npm run bench`.
    exclude: ['tests/bench/**', 'node_modules/**', 'dist/**'],
  },
});
