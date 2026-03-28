---
skill: respond-to-pr-review
issue: 329
pr: 340
round: 1
date: 2026-03-11
fixed_findings: [F1, F2, F3]
---

### F1: Runtime audit findings via archiver → minimatch
**What was caught:** `pnpm audit` still showed high-severity runtime findings through archiver's transitive minimatch dependency, plus phantom lockfile entries reporting already-fixed vulnerabilities.
**Why I missed it:** I ran `pnpm audit` at handoff but didn't investigate the `apps\narratorr` paths or realize they were phantom entries from a stale lockfile. I also didn't consider using `pnpm.overrides` to force patched transitive dep versions.
**Prompt fix:** Add to `/handoff` step 5 (verify): "After `verify.ts` passes, run `pnpm audit` and verify zero runtime high/critical findings. If transitive deps show runtime vulnerabilities with patched versions available, use `pnpm.overrides` to force the patched version. If audit paths reference directories that don't exist (e.g., `apps/`), the lockfile has phantom importers — regenerate it."

### F2: Inaccurate audit documentation in PR summary
**What was caught:** The PR summary said remaining advisories were "dev-only or latest-parent-only" but runtime findings for fastify→ajv and music-metadata→file-type were still present.
**Why I missed it:** Same root cause as F1 — the audit run at handoff didn't trigger deep investigation. The PR summary was written from memory of the spec's audit disposition table rather than verified against the live `pnpm audit` output.
**Prompt fix:** Add to `/handoff` PR body template: "Include a `## Audit Status` section with the exact `pnpm audit` summary count and list any remaining findings with their paths and severity, verified against live `pnpm audit` output."

### F3: @types/node-cron kept when bundled types exist
**What was caught:** `node-cron@4.2.1` ships bundled `.d.ts` files via its exports field, making `@types/node-cron` unnecessary and risky for type drift.
**Why I missed it:** The spec said to keep `@types/node-cron` based on an earlier assessment. I didn't re-verify after installation.
**Prompt fix:** Add to `/implement` dependency upgrade patterns: "After installing a major version bump of a package that previously needed @types/*, verify whether the new version ships bundled types by checking `node_modules/<pkg>/package.json` for `types`/`typings`/`exports` fields with `.d.ts` paths."
