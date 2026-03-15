import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "review-complete",
    prompt:
      "Spec review analysis complete. IMMEDIATELY continue — post the review comment to Gitea and update issue labels.",
  },
  {
    marker: "posted",
    prompt:
      "Review comment posted and labels updated. You may now stop.",
  },
];
