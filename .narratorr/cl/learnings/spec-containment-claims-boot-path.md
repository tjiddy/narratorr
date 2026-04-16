---
scope: [infra, workflow]
files: []
issue: 612
date: 2026-04-16
---
Containment claims in specs ("no external network calls," "empty settings disable X") must be verified against the actual boot path, not assumed from user-configurable settings. During review of #612, the first version claimed "empty settings mean no metadata providers are configured and therefore no external calls" — wrong on both counts: `MetadataService` eagerly instantiates provider objects in its constructor regardless of settings, and `startJobs()` always registers the `version-check` cron which fetches `api.github.com`. The honest containment story had to acknowledge both. Process lesson: when writing a spec that makes a hermetic-environment claim, grep the job registry (`src/server/jobs/index.ts`) and service constructors for unconditional outbound paths before committing to categorical language. The codebase's startup sequence — not the settings schema — is the source of truth for what runs on boot.
