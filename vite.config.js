import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/we-math/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
  },
});
