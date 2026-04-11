---
scope: [frontend]
files: [src/client/components/icons.tsx, src/client/components/MergeStatusIcon.test.tsx]
issue: 465
date: 2026-04-11
---
The `LoadingSpinner` component in `icons.tsx` applies `animate-spin` as a base class (hardcoded in the SVG element), so asserting `not.toContain('animate-spin')` to distinguish it from `RefreshIcon` fails. Use `data-testid="loading-spinner"` (`screen.getByTestId`) instead of CSS class inspection to identify the spinner.