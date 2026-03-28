---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.tsx, src/client/index.css]
issue: 98
date: 2026-03-25
---
Unpolished folder-row cards use `bg-white/3 border border-white/5` (nearly invisible on light mode); the correct pattern is `glass-card hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out` matching SearchBookCard/SuggestionCard. For action icon buttons: filled/active state = `text-primary` (not `text-primary/70` — opacity signals inactive); destructive remove buttons = `hover:text-destructive` (not `hover:text-muted-foreground`). These three substitutions are the canonical polish diff for any new folder-list component.
