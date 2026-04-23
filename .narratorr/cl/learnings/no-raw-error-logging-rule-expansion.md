---
scope: [backend, services, tooling]
files: [eslint-rules/no-raw-error-logging.cjs, eslint-rules/no-raw-error-logging.test.cjs]
issue: 677
date: 2026-04-23
---
`no-raw-error-logging` originally flagged only the object-key shape `{ error: <catchBinding> }` in log calls, which left two loopholes: bare-first-arg `log.error(err, '…')` and bare-first-arg `log.error(serializeError(err), '…')`. Both produce `"error":{}` or bypass the canonical log-record field respectively. Rule was extended with two `CallExpression` matchers that autofix to `{ error: serializeError(err) }`. Also replaced the binary `utils-vs-non-utils` import-path heuristic with a depth-aware `path.posix.relative()` computation anchored at `/src/server/`, so `src/server/services/import-adapters/*.ts` (depth-2) produces `'../../utils/serialize-error.js'` instead of the broken `'../utils/serialize-error.js'`. When extending an AST rule with new first-argument shapes, centralize the shared parts (log-call detection, catch-source tracing, import insertion) and dispatch per `firstArg.type` — keeps cyclomatic complexity under 15 and each matcher narrowly scoped.
