---
scope: [frontend, backend]
files: [apps/narratorr/src/client/pages/settings/GeneralSettings.tsx]
issue: 127
date: 2026-02-23
---
ESLint's `complexity` rule counts every `??` and `||` operator as a branch. A flat object mapping with 15+ null-coalescing operators (like `settingsToFormData`) hits the limit even though there's zero actual branching logic. The right fix is an `eslint-disable-next-line complexity` comment with a justification, not refactoring into something worse. Similarly, JSX components with multiple conditional renders hit complexity limits — extract subcomponents to reduce per-function branch count.
