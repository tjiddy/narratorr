---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx]
issue: 430
source: review
date: 2026-04-09
---
When changing a hook to surface previously-hidden state (terminal entries), the consuming component must also update its rendering to handle the new states. MergeProgressIndicator always showed a spinning RefreshIcon because it never needed terminal states before. The spec's AC said "fade-out animation" but didn't explicitly require terminal-specific icons — the reviewer correctly identified this as a UI inconsistency with the sibling MergeCard. Prevention: when surfacing new state to a component, review all visual elements that depend on the old state contract.
