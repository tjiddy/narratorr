---
scope: [scope/backend, scope/services]
files: [src/server/services/settings.service.test.ts]
issue: 157
source: review
date: 2026-03-27
---
New boolean field (welcomeSeen) was added to general settings but no service test verified that patching other fields preserves it.

Why: Added the field and schema, but didn't add service tests specifically for the new field's preservation under partial updates.

What would have prevented it: When adding a new field to a settings category, add a patch/update test starting with the new field at a non-default value, verifying it survives partial updates of other fields in the same category.
