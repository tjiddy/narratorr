---
name: issues
description: List all open GitHub issues for this project. Use when user says "list
  issues", "show issues", "open issues", or invokes /issues.
---

# /issues — List open GitHub issues

List all open issues for this project.

## Steps

1. Run: `gh issue list --state open --limit 100 --json number,state,title,labels,milestone --jq '.[] | "#\(.number) [\(.state | ascii_downcase)] \(.title)\n   labels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)"'`
2. Display the output to the user
