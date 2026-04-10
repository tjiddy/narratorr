---
scope: [frontend]
files: [src/client/pages/activity/DownloadActions.tsx, src/client/pages/activity/DownloadCard.tsx]
issue: 409
date: 2026-04-10
---
When removing dead code from a child component (e.g., PendingActionButtons from DownloadActions), also check callers that pass now-removed props. DownloadCard still passed `onApprove`, `onReject`, `isApproving`, `isRejecting` to DownloadActions even though the component never rendered for pending_review. Removing the props from the child's interface immediately surfaces these stale prop-passing sites via TypeScript errors, which is the desired behavior — but you need to fix them in the same commit.
