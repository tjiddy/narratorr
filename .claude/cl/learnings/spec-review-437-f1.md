---
scope: [scope/backend, scope/core]
files: [src/server/services/metadata.service.ts, src/server/routes/metadata.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the metadata-registry AC was underspecified — MetadataService has a split architecture (search providers[] vs hidden audnexus enrichment) that the spec glossed over with a generic "factory registry" AC. The spec assumed all providers are uniform, but the codebase has two distinct provider roles with different visibility (endpoints only surface search providers). Root cause: didn't read the full MetadataService source to understand the providers[] vs audnexus split before writing the AC. Prevention: when specifying a registry pattern refactor, always document the current architecture's provider roles and which ones the registry covers.
