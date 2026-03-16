import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "findings-addressed",
    prompt:
      "STOP BLOCKED: You are inside /respond-to-pr-review. Findings have not all been addressed. Your next action: continue fixing findings, then run quality gates via `node scripts/verify.ts`. Do NOT stop.",
  },
  {
    marker: "verify-complete",
    prompt:
      "STOP BLOCKED: You are inside /respond-to-pr-review. Quality gates have not been run. Your next action: run `node scripts/verify.ts`, then push the branch and post the Review Response comment. Do NOT stop.",
  },
  {
    marker: "response-posted",
    prompt:
      "STOP BLOCKED: You are inside /respond-to-pr-review. Response has not been posted. Your next action: push the branch, post the Review Response comment on the PR, and update labels. Do NOT stop.",
  },
];
