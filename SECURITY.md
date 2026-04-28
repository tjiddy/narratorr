# Security Model

## Overview

Narratorr is a self-hosted application designed to run on private networks. Its security model prioritizes protecting user credentials, preventing unauthorized access, and following the principle of least privilege — while remaining practical for a single-user self-hosted deployment.

## Authentication

Narratorr supports three authentication modes:

- **None** — No authentication (default on first run). Suitable for isolated environments.
- **Basic** — HTTP Basic Auth. Browser prompts for credentials on each session.
- **Forms** — Cookie-based session auth with a login page. Sessions are HMAC-SHA256 signed with a server-generated secret, `httpOnly`, `sameSite: lax`, and conditionally `secure` (set when `NODE_ENV=production` AND the request is detected as HTTPS via `request.protocol === 'https'`; this requires `TRUSTED_PROXIES` to be configured so Fastify can read `X-Forwarded-Proto` from a TLS-terminating reverse proxy). The cookie `Path` honors `URL_BASE` when the app is mounted under a sub-path. TTL is 7 days with sliding renewal.

### Protected Endpoints

All `/api/*` routes require authentication when an auth mode is enabled. Public endpoints are limited to:
- `/api/health` — Kubernetes/Docker health probe (returns only UP/DOWN status, no internal details)
- `/api/system/status` — App version only
- `/api/auth/status` — Auth mode and authenticated flag
- `/api/auth/login` — Login endpoint
- `/api/auth/logout` — Logout endpoint
- `/api/auth/setup` — First-time credential setup (only available when no user exists)

No configuration data, library paths, credentials, or internal state is exposed on unauthenticated endpoints.

### Rate Limiting

Authentication endpoints are rate-limited to prevent brute-force attacks:
- **Login:** 5 attempts per 15-minute window per IP
- Returns HTTP 429 with `Retry-After` header when limit is exceeded
- Window resets automatically after the time period expires

## Credential Storage

### User Passwords
- Hashed with **scrypt** (64-byte key length) using a unique random 16-byte salt per password
- Password comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- The session secret is generated at initialization via `crypto.randomBytes(32)` and never exposed to the client

### Third-Party Credentials (Encryption at Rest)
All sensitive configuration values (API keys, passwords, proxy URLs) are encrypted at rest in the database using **AES-256-GCM**:

- **Algorithm:** AES-256-GCM with 12-byte IV and 16-byte authentication tag
- **Key management:** 32-byte encryption key loaded from (in priority order):
  1. `NARRATORR_SECRET_KEY` environment variable
  2. `secret.key` file in the config directory (auto-generated on first run with `0600` permissions)
- **Encrypted entities:** Indexer API keys, download client passwords/API keys, Prowlarr API keys, import list API keys, proxy URLs, session secrets, notifier secrets (webhook URLs/headers, Discord/Slack webhook URLs, Telegram bot tokens, SMTP passwords, Pushover/Gotify tokens)
- **Sentinel pattern:** API responses mask secrets with `********`. Updates that include the sentinel value preserve the existing encrypted value (no re-encryption of unchanged secrets)
- **Storage format:** `$ENC$<base64(iv + authTag + ciphertext)>` — encrypted values are distinguishable from plaintext

### Credential Redaction
- All credential fields are masked (`********`) in API responses — encrypted values never leave the server
- Proxy URLs are redacted before logging (credentials stripped from URL string)
- Log output never contains decrypted credentials

## API Key Authentication

An API key is generated on first run (`crypto.randomUUID`). It can be regenerated at any time from Settings. Accepted via:
- `X-Api-Key` header (recommended)
- `?apikey=` query parameter (convenience for webhook URLs — note that query parameters may appear in server logs and referrer headers)

## Security Headers

Narratorr uses `@fastify/helmet` for HTTP security headers in production:

- **Content-Security-Policy:** Strict CSP with nonce-based script execution (`script-src 'self'`, no `unsafe-inline` in script-src); `style-src` permits `'unsafe-inline'` (and explicitly no nonce — a Fastify `onSend` hook strips the `@fastify/helmet`-injected style nonce before the response is sent, because per CSP Level 2 a nonce's presence silently disables `unsafe-inline` in the same directive)
- **X-Frame-Options:** `DENY` — prevents clickjacking
- **Referrer-Policy:** `strict-origin-when-cross-origin`
- **X-Content-Type-Options:** `nosniff` (helmet default)
- **X-DNS-Prefetch-Control:** `off` (helmet default)
- **Cross-Origin-Embedder-Policy:** Disabled (allows external cover art images)

CSP nonces are injected per-request for the inline configuration script (`window.__NARRATORR_URL_BASE__`).

### eval() in CSP

A CSP `script-src` `eval()` violation may appear in the browser console. First-party application source (`src/`, excluding `*.test.ts`) contains no `eval()` calls, so the violation originates outside the app codebase — likely from a third-party runtime bundled into the page. This is treated as out-of-scope for application code; a bundle trace would be needed to identify the exact source.

## Local Network Bypass

When enabled, requests from private IP ranges (10.x, 172.16-31.x, 192.168.x, localhost) skip authentication. This is **off by default** and must be explicitly enabled in settings. This exists for convenience in isolated home lab environments but is not recommended for networks with untrusted devices.

### Reverse-proxy deployments — `TRUSTED_PROXIES`

Behind a reverse proxy on a private subnet (the standard Docker pattern), the socket peer Fastify sees is the proxy itself, not the original client. Without configuration, `request.ip` resolves to the proxy IP — so every external request looks local, and local-bypass auth (and per-IP rate limiting) collapses to a single shared bucket. **This is unsafe whenever local-bypass is enabled and the app sits behind any proxy.**

Set the `TRUSTED_PROXIES` env var to a comma-separated list of every IP/CIDR in the proxy chain so Fastify can resolve the real client IP from `X-Forwarded-For`. Examples:

```bash
# Single proxy on a private subnet
TRUSTED_PROXIES=10.0.0.0/8

# Multiple subnets / a list of explicit proxies
TRUSTED_PROXIES=10.0.0.0/8,192.168.0.0/16,172.16.0.0/12

# proxy-addr keyword (also: linklocal, uniquelocal)
TRUSTED_PROXIES=loopback
```

When unset (default), Fastify ignores `X-Forwarded-For` and `request.ip` is the socket peer — preserving today's behavior for direct-exposure deploys.

**Critical:** list **every** proxy in the chain. `@fastify/proxy-addr` walks `X-Forwarded-For` right-to-left, returning the first address that is NOT in the trust list. If any intermediate hop is untrusted, `request.ip` falls back to that intermediate hop — and in a Docker/private-subnet deploy that hop is itself likely a private IP, which re-enables local-bypass for external clients. Trust the entire chain or none of it.

## User-Configured Scripts

Two features execute user-configured scripts on the server: the **script notifier** (notification events) and the **post-processing script** (after a successful import). Both spawn a child process via `execFile` (no shell) with an **explicit env-var allowlist** — `process.env` is NOT spread into the child.

The encryption-at-rest design assumes `NARRATORR_SECRET_KEY` is never reachable from user-controlled code. Spreading the parent process's environment would have made it trivially exfiltratable from any settings-write surface (e.g. `echo $NARRATORR_SECRET_KEY > /tmp/exfil` in a configured notifier script). The allowlist closes that gap; only generic shell-environment keys flow through.

**Allowlisted keys** that user scripts can rely on:

| Key | Purpose |
|-----|---------|
| `PATH` | Binary resolution |
| `HOME` | User home directory (some tools require this) |
| `TMPDIR`, `TEMP`, `TMP` | Tempfile locations |
| `LANG`, `LC_ALL`, `LC_CTYPE` | Locale |
| `TZ` | Timezone |

In addition, scripts receive the call-site-specific `NARRATORR_*` extras documented in the script notifier and post-processing settings (e.g. `NARRATORR_EVENT`, `NARRATORR_BOOK_TITLE`, `NARRATORR_IMPORT_PATH`). All other parent-process environment variables — including `NARRATORR_SECRET_KEY`, `DATABASE_URL`, and any other deployment secrets — are stripped before the child process is spawned. The allowlist lives at `src/core/utils/sanitized-env.ts`; expand it explicitly if a future script need surfaces.

## Filesystem Access

The `/api/filesystem/browse` endpoint allows authenticated users to browse the host filesystem. This is intentional — users need to select library paths, download directories, and other filesystem locations during setup and configuration.

**Design decision:** Narratorr is a single-user self-hosted application. The authenticated user is the server operator. Restricting filesystem browsing would prevent legitimate configuration workflows without meaningful security benefit. This matches the pattern used by other *arr applications.

## Input Validation

- All API inputs are validated with **Zod schemas** before processing
- The application uses **Drizzle ORM** with parameterized queries — no raw SQL with string interpolation
- Path traversal prevention uses `path.relative()` with `..` prefix checks (not `startsWith()`)
- Streaming parser errors are mapped to 4xx responses by checking error messages, not blanket 500

## Dependencies

Dependency vulnerabilities are tracked via `pnpm audit`. Current findings as of 2026-03-18:

| Package | Severity | Source | Impact |
|---------|----------|--------|--------|
| `esbuild` | Moderate | `drizzle-kit` (dev only) | Dev server CORS — not in production |
| `file-type` | Moderate | `music-metadata` | ZIP bomb DoS — only processes local audio files, no remote attack vector |

No high or critical vulnerabilities. Both findings are in transitive dependencies awaiting upstream patches and do not affect production runtime security.

## Error Message Exposure

Connection test endpoints return upstream API error messages to the authenticated user. These messages may contain internal hostnames, paths, or network details from the connected service. This is intentional — the user configuring the connection is the server operator and already has this context. Sanitizing errors would hinder debugging without security benefit.

Generic error responses for unauthenticated or unexpected errors use `{ error: 'Internal server error' }` with no stack traces or internal details.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue. Contact the maintainer directly or use GitHub's private vulnerability reporting feature.
