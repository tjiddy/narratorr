---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/useLibraryPageState.ts]
issue: 470
date: 2026-04-11
---
Extracting state/hooks from a complex page component into a custom hook relocates complexity rather than eliminating it. The hook inherits the same cyclomatic complexity from conditionals in `useCallback`/`useMemo`/`useEffect`. To actually reduce the hook's complexity below the ESLint threshold, extract pure helper functions (outside the hook) for computed values, ternary logic, and conditional state derivation. Each extracted function removes its branches from the hook's complexity count.
