---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 142
date: 2026-03-26
---
`waitFor(() => expect(screen.queryByText(...)).not.toBeInTheDocument())` is vacuous when the element was never going to appear — it passes immediately before the component has processed the input. Fix: use `expect(await screen.findByDisplayValue('<typed value>')).toBeInTheDocument()` as a positive signal first, then the synchronous negative assertion. The `findByDisplayValue` waits for the React state to settle with the input value, proving the component actually processed the event before the negative check runs.
