import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ root: '.', base: './', build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: {
// generated-vite-input:2026-08-23-math-question-habit-before-answer:start
blog20260823MathQuestionHabitBeforeAnswer: resolve(__dirname, 'blog/2026-08-23-math-question-habit-before-answer/index.html'),
// generated-vite-input:2026-08-23-math-question-habit-before-answer:end

// generated-vite-input:2026-08-22-fraction-common-denominator-first-line:start
blog20260822FractionCommonDenominatorFirstLine: resolve(__dirname, 'blog/2026-08-22-fraction-common-denominator-first-line/index.html'),
// generated-vite-input:2026-08-22-fraction-common-denominator-first-line:end

// generated-vite-input:2026-08-21-math-learning-records:start
blog20260821MathLearningRecords: resolve(__dirname, 'blog/2026-08-21-math-learning-records/index.html'),
// generated-vite-input:2026-08-21-math-learning-records:end

// generated-vite-input:2026-08-16-math-advance-readiness:start
blog20260816MathAdvanceReadiness: resolve(__dirname, 'blog/2026-08-16-math-advance-readiness/index.html'),
// generated-vite-input:2026-08-16-math-advance-readiness:end

// generated-vite-input:2026-08-13-math-error-note:start
blog20260813MathErrorNote: resolve(__dirname, 'blog/2026-08-13-math-error-note/index.html'),
// generated-vite-input:2026-08-13-math-error-note:end

// generated-vite-input:2026-08-11-middle-school-geometry-study-check:start
blog20260811MiddleSchoolGeometryStudyCheck: resolve(__dirname, 'blog/2026-08-11-middle-school-geometry-study-check/index.html'),
// generated-vite-input:2026-08-11-middle-school-geometry-study-check:end

// generated-vite-input:2026-08-08-algebraic-expression-parentheses:start
blog20260808AlgebraicExpressionParentheses: resolve(__dirname, 'blog/2026-08-08-algebraic-expression-parentheses/index.html'),
// generated-vite-input:2026-08-08-algebraic-expression-parentheses:end

// generated-vite-input:daily-math-learning-records:start
blogDailyMathLearningRecords: resolve(__dirname, 'blog/daily-math-learning-records/index.html'),
// generated-vite-input:daily-math-learning-records:end
 main: resolve(__dirname, 'index.html'), consultation: resolve(__dirname, 'consultation/index.html'), student: resolve(__dirname, 'student/index.html'), admin: resolve(__dirname, 'admin/index.html'), tablet: resolve(__dirname, 'tablet/index.html'), blog: resolve(__dirname, 'blog/index.html'), blogChoosingAcademy: resolve(__dirname, 'blog/choosing-math-academy/index.html'), blogHomeworkRoutine: resolve(__dirname, 'blog/homework-routine-recovery/index.html') } } }, server: { port: 5173, open: true } });
