---
skill: respond-to-spec-review
issue: 353
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: W-3, W-11, W-12 stale against current prompts
**What was caught:** Three findings referenced prompt changes that were already made in current skill files.
**Why I missed it:** /elaborate built AC from debt scan findings without reading the actual skill files to verify the delta still existed. Trusted the debt scan as current truth.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each finding that proposes a skill prompt change, READ the actual skill file and confirm the proposed change is not already present. Report any stale findings as 'ALREADY ADDRESSED: <evidence>'."

### F2: W-10 claim/resume coexistence undefined
**What was caught:** claim.ts branch recovery had no policy defining interaction with existing status guards and /resume workflow.
**Why I missed it:** /elaborate focused on the mechanical fix (detect branch, check it out) without considering the workflow lifecycle implications — which guards stay, which shift, how this differs from /resume.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For script changes that modify lifecycle behavior (claim, resume, handoff, verify), define a policy section: which existing guards are preserved, which responsibilities shift between scripts, and how the change interacts with other lifecycle scripts."

### F3: W-7 insertion points unspecified
**What was caught:** AC said "every subagent launch" in /implement, but /implement delegates to skills, not subagents directly.
**Why I missed it:** Wrote AC against the conceptual fix description from the debt scan instead of reading the actual implement SKILL.md to understand its delegation model.
**Prompt fix:** Add to `/elaborate` step 4: "For AC items targeting skill prompt changes, name the exact step number, line range, or insertion point in the skill file. Read the skill file to verify the step structure before writing AC."

### F4: Output contract and test targets missing
**What was caught:** Changing claim.ts output format without noting the documented output contract in claim SKILL.md or the need for new test files.
**Why I missed it:** /elaborate subagent checked existing test files in the target area but didn't check for downstream documentation that parses/references script output.
**Prompt fix:** Add to `/elaborate` subagent step 9: "For script changes, also check skill files that invoke the script (grep for the script name across `.claude/skills/`) and note any output format documentation that would need updating."

### F5: Trigger files not concretized
**What was caught:** W-6 and W-9 used abstract descriptions ("root config, deps, build artifacts") instead of repo-specific file patterns.
**Why I missed it:** /elaborate copied the fix description from the debt scan verbatim instead of translating it into repo-specific terms.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For AC items with trigger conditions or file-scope qualifiers, translate abstract descriptions into concrete file glob patterns specific to this repo. Abstract triggers are not testable."
