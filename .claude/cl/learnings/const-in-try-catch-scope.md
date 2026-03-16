---
scope: [backend]
files: [apps/narratorr/src/server/services/import.service.ts]
issue: 237
date: 2026-02-25
---
A `const` declared inside a try block is in the TDZ (temporal dead zone) in the catch block if the error occurs before the assignment line. To reference a variable in both try and catch, declare it as `let` before the try block. This bit us when `targetPath` was `const` inside try and the catch cleanup tried to use it — errors thrown before `buildTargetPath()` caused "targetPath is not defined" instead of the original error.
