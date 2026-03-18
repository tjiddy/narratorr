---
scope: [scope/backend]
files: [src/server/plugins/error-handler.ts]
issue: 448
date: 2026-03-18
---
Map<Constructor, ErrorEntry> pattern for error-to-status mapping. Use discriminated union for entries: `{type:'flat', status}` for single-code errors, `{type:'coded', codes: Record<string,number>}` for multi-code errors. The `for..of` loop over the map replaces the instanceof chain while preserving identical behavior. Key gotcha: constructor type needs `new (...args: any[]) => Error` to satisfy the Map generic.
