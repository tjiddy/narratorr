---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
source: review
date: 2026-03-29
---
Testing navigation requires asserting the navigate call, not just verifying the element has a role="link" attribute. The role attribute is set by the component's JSX, not by the navigate function — so a role-only assertion would still pass if the onClick handler were deleted. Mock `useNavigate` via `vi.mock('react-router-dom')` and assert `mockNavigate` was called with the expected path.
