---
scope: [frontend]
files: [src/client/components/SearchReleasesContent.tsx]
issue: 553
date: 2026-04-14
---
Extracting JSX with many conditional render branches into a single component preserves the cyclomatic complexity problem. The fix is to split by phase (SearchingPhase, ResultsPhase) so each sub-component handles one concern. This pattern maps naturally to state-machine-driven UIs where phases are mutually exclusive.
