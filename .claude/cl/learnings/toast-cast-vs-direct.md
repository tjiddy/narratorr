---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 93
date: 2026-03-25
---
When asserting on a mocked `toast` object in Vitest, use `expect(toast.success).toHaveBeenCalledWith(...)` directly — do NOT cast `(toast as { success: ReturnType<typeof vi.fn> }).success`. The cast causes a TS2352 "not sufficiently overlapping" error because the real `sonner` toast type conflicts with the `Mock` type. The direct call works because TypeScript's jest-dom matchers accept function types without requiring the `Mock` generic.
