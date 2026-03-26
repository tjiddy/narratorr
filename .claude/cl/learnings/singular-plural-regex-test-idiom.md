---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx, src/client/components/manual-import/ImportCard.test.tsx]
issue: 97
date: 2026-03-26
---
Testing singular vs plural text embedded in a larger string (e.g., "1 file · 500 MB" vs "1 files · 500 MB") works cleanly with `/1 file[^s]/` regex — the `[^s]` character class matches "1 file ·" but not "1 files". Pair with a negative assertion `expect(screen.queryByText(/1 files/)).not.toBeInTheDocument()` for completeness. This is more robust than trying to match the full text node including size formatting.
