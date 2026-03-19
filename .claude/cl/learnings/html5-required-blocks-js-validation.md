---
scope: [frontend]
files: [src/client/pages/settings/CredentialsSection.tsx, src/client/pages/settings/CredentialsSection.test.tsx]
issue: 8
date: 2026-03-19
---
In jsdom (testing-library), HTML5 `required` on a form field fires browser-native validation before the React `onSubmit` handler runs. If a confirm password field has `required`, the form submit event is blocked entirely when the field is empty — the `onSubmit` handler never fires, causing `waitFor` to timeout in tests. Fix: omit `required` from confirm fields; JS mismatch validation (`password !== confirmPassword`) catches the empty case implicitly since empty-string !== non-empty-string.
