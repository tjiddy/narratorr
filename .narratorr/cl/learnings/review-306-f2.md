---
scope: [frontend]
files: [src/client/components/ManualAddFormModal.tsx, src/client/components/ManualAddFormModal.test.tsx]
issue: 306
source: review
date: 2026-04-02
---
Defense-in-depth guards (like `if (!isPending) onClose()` alongside `disabled={isPending}`) should still have a test even when the spec says "no test needed." The `disabled` attribute prevents normal clicks, but `fireEvent.click` bypasses it — use this to verify the guard independently. Without the test, reverting the guard leaves the suite green and the spec's "defense-in-depth" claim is unverifiable.
