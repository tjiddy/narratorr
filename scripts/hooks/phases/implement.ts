import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "claim-complete",
    prompt:
      "STOP BLOCKED: You are inside /implement. Claim succeeded but you have not started Phase 2. Your next action: run the branch guard (`git branch --show-current`) then invoke /plan via the Skill tool. Do NOT stop.",
  },
  {
    marker: "plan-complete",
    prompt:
      "STOP BLOCKED: You are inside /implement Phase 3. /plan returned but implementation has not started. Your next action: write the plan-complete marker, then run `gh issue view <id>` to re-read the spec, then begin red/green TDD. Do NOT stop.",
  },
  {
    marker: "implement-complete",
    prompt:
      "STOP BLOCKED: You are inside /implement Phase 4. Code is written but handoff has not started. Your next action: run the branch guard (`git branch --show-current`) then invoke /handoff via the Skill tool. Do NOT stop.",
  },
  {
    marker: "handoff-complete",
    prompt:
      "STOP BLOCKED: You are inside /implement step 8. /handoff returned but label verification is not done. Your next action: run `gh issue view <id>` and `gh pr view <number>` to verify labels, then report completion. Do NOT stop.",
  },
];
