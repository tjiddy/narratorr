import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "self-review-complete",
    prompt:
      "Self-review complete. IMMEDIATELY continue to step 3 — check for remaining test stubs.",
  },
  {
    marker: "coverage-complete",
    prompt:
      "Coverage review complete. IMMEDIATELY continue to step 5 — run quality gates via verify.ts.",
  },
  {
    marker: "verify-complete",
    prompt:
      "Quality gates passed. IMMEDIATELY continue to step 6 — push the branch, create the PR, update labels, post the handoff comment, and complete the CL retrospective.",
  },
  {
    marker: "pr-created",
    prompt:
      "PR created and all post-PR steps complete. You may now report the result to the caller.",
  },
];
