---
skill: respond-to-spec-review
issue: 339
round: 2
date: 2026-03-11
fixed_findings: [F1, F2]
---

### F1: Gitignored debt-file cited as shared evidence
**What was caught:** The spec referenced `.claude/cl/debt.md` which is gitignored and not verifiable by other implementers/reviewers.
**Why I missed it:** In round 1, I disputed this finding by showing the file exists locally, without checking whether it's gitignored. The file IS local-only state — the reviewer was right about the conclusion even though their search method was flawed.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "When disputing a finding about file existence, also check `git check-ignore -v <path>` — a gitignored file that exists locally is not a verifiable repo artifact."

### F2: Shell-specific loop syntax in test plan
**What was caught:** Bash `for` loops aren't portable; fail in PowerShell.
**Why I missed it:** Round 1 reviewer said `--repeat` doesn't work, so I replaced it with bash loops without considering shell portability. The fix introduced a new variant of the same problem (shell-specific commands that not everyone can run).
**Prompt fix:** Add to `/elaborate` and `/respond-to-spec-review` step 6: "Test plan commands must be single portable invocations or prose descriptions ('run N times'). Never use shell-specific loop syntax (bash `for`, PowerShell `1..N | ForEach`)."
