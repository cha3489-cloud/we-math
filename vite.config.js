import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ root: '.', base: './', build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { main: resolve(__dirname, 'index.html'), consultation: resolve(__dirname, 'consultation/index.html'), student: resolve(__dirname, 'student/index.html'), admin: resolve(__dirname, 'admin/index.html'), blog: resolve(__dirname, 'blog/index.html'), blogChoosingAcademy: resolve(__dirname, 'blog/choosing-math-academy/index.html') } } }, server: { port: 5173, open: true } });
