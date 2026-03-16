---
scope: [backend, services]
files: [src/server/services/settings.service.ts, src/shared/schemas/settings/network.ts]
issue: 315
source: review
date: 2026-03-11
---
Schema validation runs BEFORE service-layer sentinel handling. If a secret field has a schema refinement (URL validation, format check), the sentinel '********' will fail validation before it ever reaches the service's isSentinel() check. Sentinel passthrough must be allowed at the schema level for any validated secret field. This applies to both Zod schemas and Fastify schema validation.
