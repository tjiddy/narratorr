---
scope: [scope/frontend]
files: [src/client/pages/search/SearchPage.test.tsx, src/client/pages/search/SearchPage.tsx]
issue: 69
source: review
date: 2026-03-24
---
Subtitle copy changes are invisible to tests that only check headings. The existing test iterated over role="heading" elements and checked for the absence of "Discover" — but the subtitle is a <p> tag, not a heading, so it was never checked.

Why we missed it: The AC said "no Discover language" and the test implemented that correctly for headings. The subtitle is not a heading element, so it fell outside the test's scope. The new subtitle copy was never asserted to exist.

What would have prevented it: When an AC involves copy changes (not just removals), write a positive assertion for the new string alongside the negative assertion for the old one. For subtitles outside role="heading", use getByText() with the exact new string to make sure it's present and regression-sensitive.
