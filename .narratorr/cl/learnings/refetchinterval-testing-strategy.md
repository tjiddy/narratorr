---
scope: [frontend]
files: [src/client/pages/activity/useActivity.test.ts]
issue: 184
date: 2026-03-29
---
TanStack Query's `refetchInterval` callback is not directly testable — it runs internally. The indirect approach is: set up fake `setInterval`/`clearInterval`, let the hook render and initial queries resolve, clear mock call counts, advance time past the interval (e.g., 5100ms for a 5000ms interval), then assert whether new API calls were made for the relevant section. Use `mockImplementation` with section-based routing (not `mockResolvedValue`) to differentiate queue vs history calls and avoid cross-section interference.
