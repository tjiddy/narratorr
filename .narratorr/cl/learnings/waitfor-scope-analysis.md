---
scope: [scope/frontend]
files: []
issue: 339
date: 2026-03-11
---
Not all assertion types after async operations need `waitFor()`. The spec for #339 listed specific types: `toBeDisabled`, `toHaveValue`, `toBeChecked`, `toHaveTextContent`, `toHaveClass`. Other assertion types like `toBeInTheDocument`, `toHaveAttribute`, and count-based assertions (`toBeGreaterThan`) are generally safe outside `waitFor` when the preceding `waitFor` already confirmed the element exists. AuthorPage and BackupScheduleForm had zero violations despite being listed in scope — always verify against the actual assertion types, don't assume file presence in the spec means violations exist.
