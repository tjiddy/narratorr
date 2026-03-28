---
scope: [frontend]
files: [src/client/pages/activity/DownloadActions.tsx]
issue: 58
date: 2026-03-22
---
ESLint's `complexity` rule counts JSX inline ternaries AND `&&` operators in JSX expressions — not just control flow statements. Adding `isRetrying ? 'Retrying...' : 'Retry'` to a component already at complexity 15 pushes it to 16. Extracting the ternary to a `const retryLabel` variable doesn't help — the ternary still counts. The reliable fix is to extract a sub-component (e.g., `PendingActionButtons`) that removes multiple branches from the parent function. This follows the existing DownloadCard.tsx pattern where `PendingReviewDetails` and `DownloadStatusDetails` are extracted for the same reason.
