---
name: issue
description: Read the full spec for a GitHub issue. Use when user says "show issue",
  "read issue", or invokes /issue.
argument-hint: <issue-id>
---

# /issue <id> — Read a GitHub issue

Read the full spec for a GitHub issue.

## Steps

1. Run: `node scripts/gh.ts issue view $ARGUMENTS --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'`
2. Display the full output to the user
