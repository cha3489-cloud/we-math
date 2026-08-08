import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ root: '.', base: './', build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: {
// generated-vite-input:2026-08-08-algebraic-expression-parentheses:start
blog20260808AlgebraicExpressionParentheses: resolve(__dirname, 'blog/2026-08-08-algebraic-expression-parentheses/index.html'),
// generated-vite-input:2026-08-08-algebraic-expression-parentheses:end

// generated-vite-input:daily-math-learning-records:start
blogDailyMathLearningRecords: resolve(__dirname, 'blog/daily-math-learning-records/index.html'),
// generated-vite-input:daily-math-learning-records:end
 main: resolve(__dirname, 'index.html'), consultation: resolve(__dirname, 'consultation/index.html'), student: resolve(__dirname, 'student/index.html'), admin: resolve(__dirname, 'admin/index.html'), blog: resolve(__dirname, 'blog/index.html'), blogChoosingAcademy: resolve(__dirname, 'blog/choosing-math-academy/index.html'), blogHomeworkRoutine: resolve(__dirname, 'blog/homework-routine-recovery/index.html') } } }, server: { port: 5173, open: true } });
