---
skill: respond-to-pr-review
issue: 146
pr: 155
round: 1
date: 2026-03-26
fixed_findings: [F1, F2]
---

### F1: Inline wrappers in .map() defeating memo
**What was caught:** `LibraryPage` extracted stable `useCallback` handlers but still passed inline wrappers around them in the `.map()` (e.g., `(e) => handleCardMenuToggle(book.id, e)`), because the card's prop signatures didn't accept the book-scoped data directly. This meant every parent render created fresh callback props, making React.memo useless for the grid.

**Why I missed it:** The focus was on "extract closures to useCallback" — which was done — but the card's prop signatures were not updated to close the loop. The wrappers were necessary given the existing `(e: React.MouseEvent) => void` signature. Spec didn't require updating the card's prop signatures, only extracting callbacks and wrapping card in memo.

**Prompt fix:** Add to `/implement` (or CLAUDE.md Gotchas): "When extracting `.map()` closures to `useCallback` for React.memo, verify the child component's prop signatures don't still require the parent to create wrapper closures per item. If the handler needs item-scoped data (id, full item object), shift that scope into the child: update prop types to accept the handler directly, have the child pass its own data when calling the handler."

### F2: Non-falsifiable memo test
**What was caught:** The memo test used `screen.getAllByText(...).length` as the assertion — which doesn't change on re-render (DOM reconciliation preserves nodes). Additionally, it passed fresh `vi.fn()` for callbacks on re-render, which would have caused memo to re-render anyway (props changed), making the test vacuously passing.

**Why I missed it:** Assumed DOM content count was a proxy for render count. Didn't consider that React reconciles and reuses DOM nodes even on full re-renders. Didn't think about the `vi.fn()` fresh reference issue.

**Prompt fix:** Add to CLAUDE.md Gotchas: "Memo test must be falsifiable: `screen.getBy...` content count does NOT prove memo worked — React reconciles to the same DOM even on full re-renders. Use `vi.spyOn` on a hook called every render (e.g., `useImageError`) and assert the call count is unchanged after rerender with stable prop references. Also: passing fresh `vi.fn()` props on rerender defeats memo — use same instances both times."
