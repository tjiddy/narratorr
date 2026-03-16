---
scope: [scope/infra, scope/frontend]
files: [vite.config.ts, Dockerfile]
issue: 284
source: spec-review
date: 2026-03-09
---
Spec claimed `docker run -e URL_BASE=...` would affect Vite asset paths, but Vite `base` is a build-time setting baked into the bundle at `docker build`. A prebuilt Docker image can't retroactively change asset URLs at runtime. Fix: use Vite `base: './'` (relative assets) so images are portable, and only consume URL_BASE at runtime for Fastify prefix, Router basename, and API client. When speccing features that span build-time and runtime boundaries, always verify which settings are baked in vs. configurable per deployment.
