import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "self-review-complete",
    prompt:
      "STOP BLOCKED: You are inside /handoff. Step 2 marker not written. Write the self-review-complete marker (step 2b) and continue. Do NOT stop.",
  },
  {
    marker: "coverage-complete",
    prompt:
      "STOP BLOCKED: You are inside /handoff. Coverage check has not been completed. Your next action: run the test coverage check (step 4), then write the coverage-complete marker. Do NOT stop.",
  },
  {
    marker: "verify-complete",
    prompt:
      "STOP BLOCKED: You are inside /handoff. Quality gates have not been run. Your next action: run `node scripts/verify.ts`, then write the verify-complete marker. Do NOT stop.",
  },
  {
    marker: "pr-created",
    prompt:
      "STOP BLOCKED: You are inside /handoff. PR has not been created. Your next action: push the branch, create the PR, update labels, post the handoff comment, and complete the CL retrospective. Do NOT stop.",
  },
];
