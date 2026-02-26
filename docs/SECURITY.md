# Security Model

## Overview

Narratorr is a self-hosted application designed to run on private networks. Its security model reflects this — it provides authentication and access control, but assumes the host environment is trusted.

## Authentication

Narratorr supports three authentication modes:

- **None** — No authentication (default on first run). Suitable for isolated environments.
- **Basic** — HTTP Basic Auth. Browser prompts for credentials on each session.
- **Forms** — Cookie-based session auth with a login page. Sessions are HMAC-SHA256 signed with a server-generated secret, `httpOnly`, `sameSite: lax`, and `secure` in production. TTL is 7 days with sliding renewal.

All sensitive endpoints (`/api/settings`, `/api/auth/config`, `/api/indexers`, `/api/download-clients`, etc.) require authentication when an auth mode is enabled. Public endpoints are limited to `/api/health`, `/api/system/status`, `/api/auth/status`, `/api/auth/login`, `/api/auth/logout`, and initial `/api/auth/setup` (only when no user exists).

## Credential Storage

- Passwords are hashed with **scrypt** (64-byte key length) using a unique random 16-byte salt per password.
- Password comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
- The session secret is generated at initialization via `crypto.randomBytes(32)` and never exposed to the client.

## API Key Authentication

An API key is generated on first run (`crypto.randomUUID`). It can be passed via `X-Api-Key` header or `?apikey=` query parameter. The query parameter option exists for convenience (e.g., embedding in media player URLs) but note that query parameters may appear in server logs, browser history, and referrer headers.

## Local Network Bypass

When enabled, requests from private IP ranges (10.x, 172.16-31.x, 192.168.x, localhost) skip authentication. This is off by default and must be explicitly enabled in settings.

## Filesystem Access

The `/api/filesystem/browse` endpoint allows authenticated users to browse the host filesystem. This is intentional — users need to select library paths, download directories, and other filesystem locations during setup and configuration.

**Design decision:** Unlike a multi-tenant SaaS app, Narratorr is a single-user self-hosted application. The authenticated user is the server operator. Restricting filesystem browsing to a preconfigured root would prevent legitimate configuration workflows (selecting library paths, download client directories, etc.) without meaningful security benefit — an authenticated user on a self-hosted app already has the access level of the server operator. This matches the pattern used by other *arr applications (Sonarr, Radarr, Lidarr) which also expose full filesystem browsing to authenticated users.

## Input Validation

All API inputs are validated with Zod schemas before processing. The application uses Drizzle ORM with parameterized queries — no raw SQL with string interpolation.

## Dependencies

Dependency vulnerabilities are tracked via `pnpm audit`. Known findings as of 2026-02-25:

- **minimatch** (ReDoS) — transitive via eslint, vitest, @fastify/static. Dev/build tooling only.
- **rollup** (path traversal in build output) — transitive via vite. Build tooling only.
- **esbuild** (CORS in dev server) — transitive via drizzle-kit. Dev tooling only.
- **ajv** (ReDoS with `$data`) — transitive via fastify. Moderate severity, no direct exposure.

None of these affect runtime application security. They are tracked for resolution as upstream packages release patches.

## Error Message Exposure

Connection test endpoints (e.g., Prowlarr) return upstream API error messages to the authenticated user. These messages may contain internal hostnames, paths, or network details from the connected service. This is intentional — the user configuring the connection is the server operator and already knows these details. Sanitizing errors would hinder debugging without meaningful security benefit, since the endpoints are behind authentication.

## What's Not Implemented (Yet)

- **Rate limiting** on authentication endpoints. Brute-force protection is not yet in place. (#172)
- **Security headers** (HSTS, X-Frame-Options, CSP, X-Content-Type-Options). Consider adding `@fastify/helmet`. (#172)
- **Encryption at rest** for stored third-party credentials (indexer/download client API keys in the database).

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue.
