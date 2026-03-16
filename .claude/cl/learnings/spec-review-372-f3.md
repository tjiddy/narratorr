---
scope: [scope/frontend, scope/backend]
files: [src/client/pages/activity/useActivity.ts, src/client/pages/activity/ActivityPage.tsx]
issue: 372
source: spec-review
date: 2026-03-15
---
When paginating a list that the frontend splits into sections client-side (e.g., activity queue vs history), the spec must define whether sections become separate paginated queries or a server-side split. A single paginated response can't reliably drive both sections without specifying the contract.
