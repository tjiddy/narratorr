---
scope: [frontend]
files: [src/client/components/settings/SelectWithChevron.test.tsx]
issue: 288
source: review
date: 2026-04-01
---
When testing variant-based styling, assert the full class contract — not just the visually obvious classes. The variant tests checked chevron size (w-3/h-3 vs w-4/h-4) and select class omissions (no w-full, no bg-background) but missed chevron positioning (right-2 vs right-3) and compact border omission. The AC defined exact classes for each variant; every class mentioned in the AC should map to a test assertion.
