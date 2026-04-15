---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.tsx]
issue: 562
date: 2026-04-15
---
When testing wrapper-specific prop forwarding (e.g., PathStep forwards libraryPath as fallbackBrowsePath to PathInput), mocking the child component is the pragmatic approach despite the "mock at API boundary" guideline. The mock captures props for assertion while providing a minimal DOM surface for interaction tests (onChange, onKeyDown). This avoids pulling in the child's internal dependencies (DirectoryBrowserModal) without sacrificing coverage of the wrapper contract.
