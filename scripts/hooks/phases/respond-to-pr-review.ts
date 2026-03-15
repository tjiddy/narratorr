import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "findings-addressed",
    prompt:
      "All findings addressed. IMMEDIATELY continue — run quality gates via verify.ts.",
  },
  {
    marker: "verify-complete",
    prompt:
      "Quality gates passed. IMMEDIATELY continue — push the branch, post the Review Response comment on the PR, and update labels.",
  },
  {
    marker: "response-posted",
    prompt:
      "Response posted and labels updated. You may now report the final status.",
  },
];
