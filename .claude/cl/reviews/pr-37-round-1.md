---
skill: respond-to-pr-review
issue: 37
pr: 44
round: 1
date: 2026-03-20
fixed_findings: [F1]
---

### F1: tsup bundle injection path untested

**What was caught:** The reviewer identified that `esbuildOptions.define` in `tsup.config.ts` wires a new build-time contract, but all added tests only exercise `process.env.GIT_COMMIT` at the source level. A broken define (wrong syntax, silently ignored, tsup version regression) would never be caught because route/component tests mock the module.

**Why I missed it:** The implementation correctly handled both the source-level caching pattern and the tsup config. The test plan addressed "getCommit() returns the injected SHA" — but this only validates the fallback runtime path via module mocks. The build-artifact path (tsup actually inlines the value into dist/server/index.js) was assumed to work once the config was written. The self-review subagent noted "Build configs are intentionally not unit-tested" which was technically true but too broad — build *injection* contracts are testable and high-value.

**Prompt fix:** Add to `/plan` step 5 or `/implement` step 4d: "When a change introduces a new build-time injection (tsup/esbuild define, Vite define, environment variable baked at compile time), the test plan must include a build-artifact test: run the actual build with a known value, read the emitted bundle, assert the literal value appears. Source-level mocks of process.env are not sufficient for build-time injection contracts."
