---
scope: [scope/frontend]
files: []
issue: 339
date: 2026-03-11
---
When agents replace `userEvent.clear()+type()` with `fireEvent.change()`, they consistently leave behind unused `const user = userEvent.setup()` declarations. This triggers `@typescript-eslint/no-unused-vars` lint errors. When delegating Pattern B (number input) fixes to agents, explicitly instruct them to also remove the `user` variable if no other code in the test uses it.
