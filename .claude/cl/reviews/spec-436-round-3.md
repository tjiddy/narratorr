---
skill: respond-to-spec-review
issue: 436
round: 3
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: AC1 too broad for actual service boundary
**What was caught:** AC says "only file import + DB state" but service also owns queue admission and torrent removal.
**Why I missed it:** Wrote the AC as an aspirational goal ("strip it down") without cross-checking it against the actual method list on `ImportService`. The test plan contradicted the AC by including queue/torrent tests.
**Prompt fix:** Add to `/spec` AC checklist: "For SRP extraction specs, after writing ACs, list every public method on the target class and verify each one is accounted for — either staying (with justification) or moving."

### F2: Missing caller matrix
**What was caught:** Spec didn't name which callers switch to the orchestrator.
**Why I missed it:** Focused entirely on what moves out of the service, not on who calls in. The approve route and cron job are both callers with different characteristics.
**Prompt fix:** Add to `/spec` template for extraction/refactor issues: "### Caller Matrix — list every call site that references the target class/method, with current and post-change call paths."

### F3: Inconsistent failure contract
**What was caught:** "Error at any step → handleImportFailure" contradicts individual side effects being isolated/best-effort.
**Why I missed it:** Copied the integration test description from a mental model of "everything fails the same way" without auditing the actual error handling per side effect in the existing code.
**Prompt fix:** Add to `/spec` for extraction issues: "When moving side effects out of a service, audit each one's current error handling (fatal/best-effort/fire-and-forget) and include an explicit classification table. Don't flatten different contracts into one description."

### F4: Didn't call out existing extraction seam
**What was caught:** Most side-effect helpers already exist in `import-steps.ts` — the spec should name this prior art.
**Why I missed it:** Treated the helpers as implementation detail rather than architectural context that shapes the design.
**Prompt fix:** Add to `/spec` for extraction issues: "Identify existing helper files/modules that already contain the logic being extracted and state whether the new layer composes or replaces them."

### F5: SSE ownership ambiguity on approve path
**What was caught:** Two services emit the same `importing` SSE transition on the approve path.
**Why I missed it:** Didn't trace the approve → import flow end-to-end across service boundaries. Only looked at ImportService in isolation.
**Prompt fix:** Add to `/spec` for specs that move event/notification responsibilities: "Trace each call path end-to-end and document which component owns each event emission, especially where multiple services touch the same status transition."

### F6: Vague test restructuring note
**What was caught:** "May need restructuring" is too vague for a 7-suite blast radius.
**Why I missed it:** Treated test impact as an afterthought rather than a first-class deliverable of the spec.
**Prompt fix:** Add to `/spec` test plan section: "For refactor specs, enumerate every affected test suite with a brief impact description (what changes, what stays as-is)."