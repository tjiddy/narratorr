---
scope: [scope/backend]
files: []
issue: 382
source: spec-review
date: 2026-03-15
---
AC7 said "new/updated tests cover Basic auth edge cases" but the spec changed 6 security surfaces. The test plan listed tests for all 6 areas, but the AC only enforced tests for one. Root cause: AC was written to match the original spec's emphasis on Basic auth as the most complex fix, without ensuring all test plan sections were reflected in AC. When AC references testing, it must explicitly enumerate all areas requiring test coverage, not just the most prominent one.
