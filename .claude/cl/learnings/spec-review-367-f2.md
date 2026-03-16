---
scope: [scope/frontend]
files: [src/shared/schemas/settings/registry.ts]
issue: 367
source: spec-review
date: 2026-03-16
---
Spec referenced `settings.discovery` for nav gating and settings persistence without naming the schema file, registry wiring, or insertion surface. The settings registry (`registry.ts`) is the single source of truth — any spec that adds a settings category must name the exact schema file path, registry entry, and UI component where it will be wired. Without this, the feature is not implementable or testable because the reviewer can't verify the contract exists.
