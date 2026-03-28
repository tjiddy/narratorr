---
skill: respond-to-spec-review
issue: 421
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3]
---

### F1: AC2 missing runtime source of truth for service keys
**What was caught:** The spec said "derive service names dynamically" but `Services` is a TS interface with no runtime counterpart — the implementation mechanism was unspecified.
**Why I missed it:** Assumed the reader would infer the approach. Didn't verify whether the TypeScript interface had a runtime equivalent that could actually be iterated.
**Prompt fix:** Add to `/spec` AC checklist: "For ACs that reference TypeScript types (interfaces, type aliases), verify whether the type exists at runtime. If not, the AC must name the runtime artifact to introduce or reuse."

### F2: AC3 validation contract unspecified
**What was caught:** AC3 said "covering validation" but never defined what validation means — the component uses native HTML constraints, not JS validation.
**Why I missed it:** Used the word "validation" as a catch-all without inspecting the component's actual validation mechanism.
**Prompt fix:** Add to `/spec` test plan guidance: "When specifying validation coverage, inspect the component's actual validation approach (form library, native HTML constraints, JS guards) and specify the testable contract — don't use 'validation' as an unqualified term."

### F3: Blast radius not called out for shared helper change
**What was caught:** AC2 modifies `createMockServices` used ~60 times but didn't specify regression verification scope.
**Why I missed it:** Focused on the helper's internal behavior rather than its consumer surface.
**Prompt fix:** Add to `/spec` scope boundaries guidance: "For changes to shared test infrastructure (helpers, fixtures, factories), name the test suites that must pass as regression verification in the test plan."
