---
scope: [scope/frontend]
files: [src/client/pages/discover/DiscoverPage.tsx, src/client/pages/discover/DiscoverPage.test.tsx]
issue: 367
source: review
date: 2026-03-16
---
Refresh mutation test only covered click + loading spinner, not the success consequences (clears removedIds so dismissed cards reappear, success toast) or failure (error toast). Prevention: for every mutation, test the full lifecycle: click → pending state → resolve/reject → UI consequences.
