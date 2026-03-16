---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When a spec promises to fix a problem but the implementation path preserves the exact behavior that causes the problem, the spec is dishonest about its scope. This happened with #355: the issue was opened to fix unbounded queries, but after two rounds of review the spec evolved to preserve full-result semantics for all current callers — which means queries stay unbounded. The fix was to honestly rescope the issue as "Phase 1: pagination infrastructure" and create a Phase 2 follow-up for actual limit enforcement + pagination UI. When you hit this tension (fix vs. backwards compatibility), split the work explicitly rather than pretending one issue does both.
