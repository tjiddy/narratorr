---
scope: [frontend]
files: [src/client/pages/activity/DownloadActions.tsx]
issue: 54
date: 2026-03-21
---
ESLint's cyclomatic-complexity rule counts every `&&`, `||`, `?:` operator and `if` in JSX as +1 branch, including short-circuit renders like `{onApprove && <button>}`. When adding new conditionally-rendered buttons to a component near the complexity limit (max 15), the safest reduction is to merge sibling conditional blocks under a shared parent condition (e.g., combine two `{status === 'pending_review' && ...}` blocks into one). Extracting ternaries into variables has net-zero effect on JSX complexity.
