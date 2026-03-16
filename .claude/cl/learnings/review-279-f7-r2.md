---
scope: [backend]
files: [src/server/services/health-check.service.test.ts]
issue: 279
source: review
date: 2026-03-10
---
Health check methods with early-return guards (missing config) and catch blocks (probe failure) need tests for each branch. The guard branch and the error branch are distinct states with different severities (warning vs error). Missing them means unconfigured systems show incorrect health state.
