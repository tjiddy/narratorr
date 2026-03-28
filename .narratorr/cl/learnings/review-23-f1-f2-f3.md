---
scope: [core]
files: [src/core/utils/fetch-with-timeout.test.ts, src/core/download-clients/nzbget.test.ts, src/core/notifiers/slack.test.ts]
issue: 23
source: review
date: 2026-03-20
---
When an AC specifies that an error message must be "actionable" (e.g., "mentions using internal IP:port or whitelisting in proxy config"), the test must assert the actionable text, not just the primary identifier (URL, status code). Asserting only the URL + a broad category match (/auth proxy/i) leaves the guidance clause unprotected — it can be removed from the source without failing any test. The fix: for every error message AC, add one assertion per distinct clause the AC describes (redirect target, category hint, actionable advice). Also: notifier spec ACs that say "test() path" must test test(), not send() — even if test() delegates to send(), they are separate entry points with separate contract boundaries.
