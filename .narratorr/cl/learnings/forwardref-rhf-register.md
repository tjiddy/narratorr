---
scope: [frontend]
files: []
date: 2026-04-10
---
When extracting a React component that consumers spread `register()` onto (from react-hook-form), the component MUST use `forwardRef`. Without it, the `ref` from `register()` silently drops — the component renders fine, but form dirty tracking and validation stop working. The failure is silent: no error, no warning, just broken form state.
