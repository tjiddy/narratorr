---
skill: review-spec
issue: 418
round: 2
date: 2026-03-17
new_findings_on_original_spec: [F6]
---

### F6: AC3 still overstates literal removal
**What I missed in round 1:** AC3 still says "no hardcoded reason string literals remain in production code", which is incompatible with keeping `SIGNAL_WEIGHTS` and `getStrengthForReason` in service-layer domain logic.
**Why I missed it:** I focused on the broader headline promise and missing artifact coverage, but I did not re-parse AC3 sentence-by-sentence against the service file's actual remaining reason-specific switch/object literals.
**Prompt fix:** Add a check that compares each AC's wording against any explicitly out-of-scope domain logic, and flag any AC that says "no hardcoded literals remain" when a retained switch/object in production code must still enumerate those literals.
