---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 226
date: 2026-03-30
---
When writing tests that set cursor position via `setSelectionRange(pos, pos)`, always verify the position by computing `string.length` programmatically rather than counting characters manually. Tokens like `{seriesPosition:00}` are 20 chars, not 18 — off-by-one in position calculations caused 5 of 17 tests to fail on the first run. Use `node -e "console.log('string'.length)"` to verify.
