---
skill: respond-to-pr-review
issue: 210
pr: 211
round: 1
date: 2026-03-29
fixed_findings: [F1, F2, F3]
---

### F1: Unsupported {series/} syntax in preset templates
**What was caught:** Audiobookshelf and Plex presets used `{series/}` which the template renderer doesn't recognize.
**Why I missed it:** The preset tests only verified the string values, not that they were valid template syntax. No test rendered the presets through the actual renderer.
**Prompt fix:** Add to `/plan` step 5 (test stubs): "When creating constant data structures that will be consumed by a parser/renderer (templates, format strings, regex patterns), generate a validity test that feeds each value through the consumer and asserts no syntax artifacts remain."

### F2: Preview reactivity untested due to options-ignoring mocks
**What was caught:** Frontend mocks for renderTemplate/renderFilename ignored the options argument, so preview changes from separator/case were untested.
**Why I missed it:** Standard pattern was to mock render functions as simple string replacements. When adding a new parameter, didn't update the mocks to be sensitive to it.
**Prompt fix:** Add to `/implement` step 4a (Red phase): "When a new parameter is added to a mocked function, update the mock to be sensitive to that parameter. If the mock ignores the new argument, any test that exercises the new feature through the mock is vacuous."

### F3: Service-level wiring untested
**What was caught:** Services extracting naming options from settings and forwarding to helpers were not tested at the service level.
**Why I missed it:** Assumed helper-level tests were sufficient. The coverage subagent flagged this during handoff but I didn't add all the tests.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When threading a new parameter through a call chain (settings → service → helper), verify tests exist at EACH layer boundary, not just the lowest helper. Service-level assertions catch wiring regressions that helper tests miss."
