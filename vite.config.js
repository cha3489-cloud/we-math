import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ root: '.', base: './', build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { main: resolve(__dirname, 'index.html'), student: resolve(__dirname, 'student/index.html'), admin: resolve(__dirname, 'admin/index.html') } } }, server: { port: 5173, open: true } });
