---
scope: [frontend]
files: [src/client/components/settings/ToggleSwitch.tsx]
issue: 289
date: 2026-04-01
---
When extending `React.InputHTMLAttributes<HTMLInputElement>` and adding a custom `size` prop with a string union type, it conflicts with the native HTML `size` attribute (which is a number). Use `Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>` to avoid the TS2430 incompatible types error. This applies to any component that redefines an existing HTML attribute with a different type.
