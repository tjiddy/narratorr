---
scope: [frontend]
files: [src/client/components/settings/NamingTokenModal.tsx]
issue: 484
source: review
date: 2026-04-12
---
Inserting a dialog wrapper `<div>` inside a `scrollable` Modal breaks the flex layout because the wrapper becomes a non-flex child that doesn't propagate `flex-1`/`min-h-0` constraints. When wrapping existing content in a new container inside a flex parent, always add `className="flex flex-col flex-1 min-h-0"` to the wrapper. This is the same pattern used in SearchReleasesModal's dialog wrapper (`:213`). Should have been caught by visually comparing the dialog wrapper patterns across all in-scope modals.
