---
scope: [frontend, infra]
files: [vite.config.ts, src/client/index.css]
issue: 329
date: 2026-03-10
---
Tailwind CSS 4 migration: replace `tailwindcss` PostCSS plugin + `autoprefixer` with `@tailwindcss/vite` Vite plugin. Remove `tailwind.config.js` and `postcss.config.js`. In CSS: `@tailwind base/components/utilities` → `@import "tailwindcss"`, theme config → `@theme` block with `--color-*`, `--radius-*`, `--shadow-*`, `--animate-*` vars, custom utilities → `@utility name { ... }` blocks, dark mode class → `@variant dark (&:where(.dark, .dark *))`. CSS variable values and `@layer base/components` blocks stay the same.
