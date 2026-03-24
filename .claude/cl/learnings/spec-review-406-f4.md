---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught that the "inspectability" claim from the resolved question was never tied to a concrete surface. The test plan had an "if exposed" stats-route bullet that left the review surface ambiguous. Prevention: when a resolved question claims a benefit (like "inspectable"), verify the existing API surface that delivers it and either reference it explicitly or add an AC for the new surface. Don't leave conditional bullets in the test plan.