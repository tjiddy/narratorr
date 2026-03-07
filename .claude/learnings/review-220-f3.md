---
scope: [scope/backend]
files: [src/server/services/download-client.service.ts]
issue: 220
source: review
date: 2026-02-24
---
Reviewer caught missing log statement in getCategoriesFromConfig catch block. Project rule: every catch block must log. The getCategories (by-id) method had proper logging in its catch but the getCategoriesFromConfig (by-config) method didn't. Easy to miss when two similar methods are written — always audit both paths.
