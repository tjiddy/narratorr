---
scope: [frontend]
files: [src/client/pages/book/BookHero.tsx]
issue: 444
source: review
date: 2026-04-09
---
`handleMenuAction()` closes the overflow menu before the action's side effects (like `isPending`) can be observed. For non-destructive actions that show loading state in-menu (like Refresh & Scan), bypass `handleMenuAction` and call the callback directly so the menu stays open and the spinner remains visible. The component test with manually-set `isRefreshingScanning=true` passed but didn't catch this because it never exercised the real click → menu-close → invisible-spinner flow. Test the actual click path, not just isolated prop rendering.
