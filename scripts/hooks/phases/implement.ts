import type { PhaseDefinition } from "../stop-gate.ts";

export const phases: PhaseDefinition[] = [
  {
    marker: "claim-complete",
    prompt:
      "Claim phase complete. IMMEDIATELY continue to Phase 2 — run the branch guard and invoke /plan.",
  },
  {
    marker: "plan-complete",
    prompt:
      "Plan phase complete. IMMEDIATELY continue to Phase 3 — read the issue spec and begin red/green TDD implementation.",
  },
  {
    marker: "implement-complete",
    prompt:
      "Implementation phase complete. IMMEDIATELY continue to Phase 4 — run the branch guard and invoke /handoff.",
  },
  {
    marker: "handoff-complete",
    prompt:
      "Handoff phase complete. IMMEDIATELY continue to step 8 — verify label transitions on both the issue and PR, then report completion.",
  },
];
