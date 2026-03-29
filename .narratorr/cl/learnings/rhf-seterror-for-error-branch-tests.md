---
scope: [frontend]
files: [src/client/components/settings/NotifierFields.test.tsx]
issue: 201
date: 2026-03-29
---
To test React Hook Form error-state rendering branches without triggering real validation (which requires async submit + zodResolver), use a wrapper component that calls `setError()` in a `useEffect` to inject errors for specific field paths. This avoids the complexity of form submission while reliably exercising errorInputClass/conditional error `<p>` branches.
