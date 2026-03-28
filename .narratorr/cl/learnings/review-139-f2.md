---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.test.tsx]
issue: 139
source: review
date: 2026-03-26
---
When testing "row is not dimmed", assert the absence of ALL dim classes, not just the one being removed. The original fix removed `opacity-60` and the test checked `not.toContain('opacity-60')` — but the component could still apply `opacity-50` and the test would pass. Tests for "fully undimmed" must assert `not.toContain('opacity-60')` AND `not.toContain('opacity-50')`. Also: when the spec says "selected duplicate rows should not be dimmed", the test fixture must omit `matchResult` to reflect the actual Manual Import state (where duplicate rows have no match).
