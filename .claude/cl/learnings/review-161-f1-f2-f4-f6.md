---
scope: [frontend]
files: [src/client/components/ConfirmModal.tsx, src/client/components/SearchReleasesModal.tsx, src/client/components/book/BookMetadataModal.tsx, src/client/components/manual-import/BookEditModal.tsx]
issue: 161
source: review
date: 2026-03-28
---
When migrating modal components to a shared shell wrapper, the Escape key regression coverage was missed for 4 of 6 modals. Root cause: coverage review focused on backdrop-click and X-button tests, but didn't enumerate useEscapeKey as a separate behavior requiring a test. Worse, BookMetadataModal and BookEditModal had vi.mock('@/hooks/useEscapeKey') making Escape untestable in those files — the mock was silently masking the gap. Fix: when a component uses useEscapeKey, always verify the test file does NOT mock it (or has an unmocked escape path test). The mock was a legacy workaround from before the real hook was needed.
