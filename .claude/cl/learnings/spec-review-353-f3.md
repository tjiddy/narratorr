---
scope: [infra]
files: [.claude/skills/implement/SKILL.md]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec said "add branch guard before every subagent launch" in /implement, but /implement doesn't launch subagents directly — it delegates to /plan, frontend-design, and /handoff. The AC was ambiguous because it described the fix in terms of the wrong abstraction. Fix: when writing AC for skill prompt changes, read the actual skill file to identify the specific steps/lines that need modification, not just the concept.
