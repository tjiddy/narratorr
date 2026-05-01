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
- `/api/health` — Kubernetes/Docker health probe; returns exactly `{ status: 'ok' }` (HTTP 200) on success and `{ status: 'error' }` (HTTP 503) on DB failure. No version, commit, timestamp, or error message is included in the response — failures are logged server-side via `request.log.warn` instead.
- `/api/system/status` — Returns exactly `{ version, status }`. Update info (whether a newer release is available) lives behind authentication at `/api/system/update-status`.
- `/api/auth/status` — Returns exactly `{ mode, authenticated }`. Admin/deployment fields (`hasUser`, `username`, `localBypass`, `bypassActive`, `envBypass`) live behind authentication at `/api/auth/admin-status`.
- `/api/auth/login` — Login endpoint
- `/api/auth/logout` — Logout endpoint
- `/api/auth/setup` — First-time credential setup (only available when no user exists)

Unauthenticated error responses use `{ error: 'Internal server error' }` with no commit SHA, stack, or internal error message. No configuration data, library paths, credentials, or internal state is exposed on unauthenticated endpoints.

### CSRF protection

Cross-site request forgery defenses depend on the active auth mode:

- **Forms-auth** — protected by `SameSite=lax` session cookies. Browsers do not attach the cookie to cross-site state-changing requests, so no extra header is required.
- **Basic-auth** — browsers replay cached `Authorization: Basic` credentials on any same-origin request, including those triggered by a malicious third-party site. To close this gap, the server requires an `X-Requested-With: XMLHttpRequest` header on every state-changing request (POST/PUT/PATCH/DELETE) once Basic credentials have been verified. Requests without the header return `403 { "error": "CSRF protection: missing X-Requested-With header" }`. Browsers cannot set this header cross-origin without triggering a CORS preflight, so classic form-submit and image-tag CSRF vectors are blocked. Same-origin XHR/fetch from the legitimate UI sets the header automatically. CLI users on basic-auth must add `-H 'X-Requested-With: XMLHttpRequest'` for mutating routes — or, preferred, use the `X-Api-Key` header, which is exempt from the CSRF check (machine clients have no ambient browser credentials). Read-only methods (`GET`/`HEAD`/`OPTIONS`) and the public auth endpoints (`/api/auth/login`, `/api/auth/logout`, `/api/auth/setup`, `/api/auth/status`, `/api/health`, `/api/system/status`) are exempt.
- **None-auth** — no CSRF defense by design. The mode disables authentication entirely and is intended for isolated environments only.

For browser-based usage, **forms-auth is recommended over basic-auth**. The UI displays a dismissible banner suggesting the switch when basic-auth is active.

### Rate Limiting

Authentication endpoints are rate-limited to prevent brute-force attacks:
- **Login:** 5 attempts per 15-minute window per IP
- **Setup:** 3 requests per 15-minute window per IP
- **API key regenerate:** 5 requests per hour per IP
- **Filesystem browse:** 60 requests per minute per IP — caps the rate at which an authenticated client (or an XSS in basic-auth mode) can sweep the host filesystem.
- Returns HTTP 429 with `Retry-After` header when limit is exceeded
- Window resets automatically after the time period expires

### Dev-mode CORS

In production, CORS is restricted to the operator-configured `CORS_ORIGIN`. In development, the allowlist is fixed to `http://localhost:5173` (Vite dev server) and `http://localhost:3000` (Fastify self-origin); any other origin is rejected. This avoids reflecting arbitrary origins with credentials, which would let any malicious page visited during local dev read authenticated responses from `localhost`.

### AUTH_BYPASS warning

When `AUTH_BYPASS=true` is combined with an existing user account, the server emits a `warn`-level log line at boot. AUTH_BYPASS disables authentication globally, so any client reaching the server can wipe credentials via `DELETE /api/auth/credentials` — the warning is meant to make this state visible in startup output.

## Credential Storage

### User Passwords
- Hashed with **scrypt** (64-byte key length) using a unique random 16-byte salt per password
- Password comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- The session secret is generated at initialization via `crypto.randomBytes(32)` and never exposed to the client

### API Keys
- API key validation hashes both the stored key and the supplied key with SHA-256 before `crypto.timingSafeEqual`. The fixed-length hash compare means key length is never disclosed via timing — an early length-mismatch return would leak length information to an attacker probing different inputs.

### Third-Party Credentials (Encryption at Rest)
All sensitive configuration values (API keys, passwords, proxy URLs) are encrypted at rest in the database using **AES-256-GCM**:

- **Algorithm:** AES-256-GCM with 12-byte IV and 16-byte authentication tag
- **Key management:** 32-byte encryption key loaded from (in priority order):
  1. `NARRATORR_SECRET_KEY` environment variable
  2. `secret.key` file in the config directory (auto-generated on first run with `0600` permissions)
- **Encrypted entities:** Indexer API keys + indexer base URLs (`apiUrl` may embed `user:pass@host` credentials for Prowlarr-managed indexers), download client passwords/API keys, Prowlarr API keys, import list API keys, proxy URLs, session secrets, notifier secrets (webhook URLs/headers, Discord/Slack webhook URLs, Telegram bot tokens, SMTP passwords, Pushover/Gotify tokens)
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

## Outbound Fetch (SSRF Protection)

The cover-download endpoint follows attacker-influenced URLs (cover art may come from an indexer response or a manually-pasted release URL). To prevent server-side request forgery against the host's metadata service or LAN-internal services, the fetch path goes through the SSRF helpers in `src/core/utils/network-service.ts` (a custom Undici DNS lookup function that rejects unsafe destinations before the connection is made).

**Blocked destinations:**
- RFC 1918 private networks (10/8, 172.16/12, 192.168/16)
- RFC 6598 CGNAT (100.64/10 — AWS Lambda VPC NAT range)
- Loopback (127/8, ::1)
- Link-local (169.254/16 — covers AWS/GCE/Alibaba metadata services; fe80::/10)
- IPv6 unique-local (fc00::/7, fd00::/8)
- IPv6 multicast (ff00::/8)
- Unspecified addresses (0.0.0.0, ::)
- IPv4-mapped IPv6 forms (e.g., `::ffff:169.254.169.254`)
- Hostname allowlist for known metadata names (e.g., `metadata.google.internal`) as a belt-and-suspenders check on top of the IP filter

**DNS rebinding mitigation:** the lookup function runs once per request and the connection is made to the resolved IP. A malicious DNS server that returns a public IP on first lookup and a private IP on a second cannot bypass the check.

**Response controls** (cover-download):
- Response size capped — truncation triggers an error before memory exhaustion
- Redirect limit caps redirect chains and prevents external→internal pivots
- AbortSignal timeout enforced

**Coverage scope:** SSRF blocking currently wraps the cover-download path. Outbound fetches in indexer adapters, download-client adapters, metadata providers, and the webhook notifier do not yet share this control surface — a sweep to extend coverage is tracked in the open issue queue. Until that lands, those paths fetch only operator-configured URLs, which is a meaningful trust boundary but not full defense-in-depth against a compromised upstream.

## Input Validation

- All API inputs are validated with **Zod schemas** before processing — including persisted JSON columns (`phaseHistory`, manual-import metadata) on read, and external API responses from download clients, metadata providers, and import-list sources
- The application uses **Drizzle ORM** with parameterized queries — no raw SQL with string interpolation
- **Path ancestry validation** for filesystem operations that could escape the configured library root uses `path.relative(root, candidate)` with `..`-prefix and self-resolve checks (not `startsWith()`, which would let `/library2/...` pass when root is `/library`). The canonical helper is `assertPathInsideLibrary` in `src/server/utils/paths.ts`, which throws `PathOutsideLibraryError` on escape; consumers include `cleanupOldBookPath`, `cleanEmptyParents`, and library-scan filtering — book-deletion `rm()` is gated on this check so a corrupt or attacker-influenced book record cannot escape the library root
- Streaming parser errors are mapped to 4xx responses by checking error messages, not blanket 500

## Dependencies

Dependency vulnerabilities are tracked via `pnpm audit`. As of 2026-04-30 (v747.04 — dependency modernization sweep), `pnpm audit` reports **zero vulnerabilities** at any severity. The earlier transitive `esbuild` (drizzle-kit, dev-only) and `file-type` (music-metadata) findings have been resolved.

Supply-chain hardening: `pnpm` 10's lifecycle scripts are restricted via `pnpm.onlyBuiltDependencies` in `package.json`, which limits postinstall script execution to an explicit allowlist. Re-run `pnpm audit` after dependency changes; new findings are filed and tracked in the issue queue.

## Error Message Exposure

Connection test endpoints return upstream API error messages to the authenticated user. These messages may contain internal hostnames, paths, or network details from the connected service. This is intentional — the user configuring the connection is the server operator and already has this context. Sanitizing errors would hinder debugging without security benefit.

Generic error responses for unauthenticated or unexpected errors use `{ error: 'Internal server error' }` with no stack traces or internal details.

## Public-compatibility API surfaces

A handful of endpoints have no in-tree caller but are preserved as a stable contract for external integrations (scripts, dashboards, CI helpers). They are kept intentionally — do not remove them without an external API review.

| Endpoint | Rationale |
|----------|-----------|
| `POST /api/system/tasks/search` | Manual trigger for the scheduled search cycle. The generic `POST /api/system/tasks/:name/run` is the preferred surface for new integrations, but legacy automations may target this dedicated path. Removed in code review only. |

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue. Contact the maintainer directly or use GitHub's private vulnerability reporting feature.
