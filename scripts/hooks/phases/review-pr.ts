import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "review-complete",
    prompt:
      "Review analysis complete. IMMEDIATELY continue — post the review comment to Gitea and update PR/issue labels.",
  },
  {
    marker: "posted",
    prompt:
      "Review comment posted and labels updated. You may now stop.",
  },
];
