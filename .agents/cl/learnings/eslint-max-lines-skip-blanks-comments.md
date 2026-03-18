---
scope: [backend, frontend]
files: [eslint.config.js]
issue: 237
date: 2026-02-25
---
The project's `max-lines` rule is configured with `skipBlankLines: true, skipComments: true`. This means removing blank lines or condensing comments does NOT reduce the line count — only removing actual code lines helps. When a file is at the 400-line limit, the only options are: condense code formatting, extract code to another file, or remove dead code. Discovered when 6 attempts to remove blank lines and comments didn't change the lint count.
