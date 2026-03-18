---
skill: review-spec
issue: 366
round: 2
date: 2026-03-16
new_findings_on_original_spec: [F9]
---

### F9: Library status scope for signal extraction is still undefined
**What I missed in round 1:** The spec says discovery analyzes "the user's library" but never defines which `books.status` values count toward author affinity, genre distribution, series gaps, narrator affinity, and duration preference.
**Why I missed it:** I focused on missing artifacts and mismatched APIs, but I did not explicitly trace the existing `books.status` surface and ask whether the spec had pinned the analysis query to a specific subset of statuses.
**Prompt fix:** Add: "When a spec says it analyzes the library/books table, enumerate all persisted status/state variants in the real schema and require the spec to name which ones are included and excluded in the analysis query."
