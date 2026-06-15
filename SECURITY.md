# Security Model

## Overview

Narratorr is a self-hosted application designed to run on private networks. Its security model prioritizes protecting user credentials, preventing unauthorized access, and following the principle of least privilege — while remaining practical for a single-user self-hosted deployment.

## Authentication

Narratorr supports three authentication modes:

- **None** — No authentication (default on first run). Suitable for isolated environments.
- **Basic** — HTTP Basic Auth. Browser prompts for credentials on each session.
- **Forms** — Cookie-based session auth with a login page. Sessions are HMAC-SHA256 signed with a server-generated secret, `httpOnly`, `sameSite: lax`, and conditionally `secure` (set when `NODE_ENV=production` AND the request is detected as HTTPS via `request.protocol === 'https'`; this requires `TRUSTED_PROXIES` to be configured so Fastify can read `X-Forwarded-Proto` from a TLS-terminating reverse proxy). The cookie `Path` honors `URL_BASE` when the app is mounted under a sub-path. TTL is 7 days with sliding renewal. Changing the account password or username rotates the server-side session secret, invalidating every previously issued session cookie; the active session is immediately re-issued a fresh cookie so the operator stays logged in while any stolen or stale cookies are revoked.

### Protected Endpoints

All `/api/*` routes require authentication when an auth mode is enabled. Public endpoints are limited to:
- `/api/health` — Kubernetes/Docker health probe; returns exactly `{ status: 'ok' }` (HTTP 200) on success and `{ status: 'error' }` (HTTP 503) on DB failure. No version, commit, timestamp, or error message is included in the response — failures are logged server-side via `request.log.warn` instead.
- `/api/system/status` — Returns exactly `{ version, status }`.
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
- `verifyCredentials` runs a throwaway scrypt against a process-scoped dummy salt on the user-not-found and malformed-hash branches, so login response time does not distinguish "username exists" from "wrong password" (username-enumeration timing oracle)
- The session secret is generated at initialization via `crypto.randomBytes(32)` and never exposed to the client

### API Keys
- API key validation hashes both the stored key and the supplied key with SHA-256 before `crypto.timingSafeEqual`. The fixed-length hash compare means key length is never disclosed via timing — an early length-mismatch return would leak length information to an attacker probing different inputs.

### Third-Party Credentials (Encryption at Rest)
All sensitive configuration values (API keys, passwords, proxy URLs) are encrypted at rest in the database using **AES-256-GCM**:

- **Algorithm:** AES-256-GCM with 12-byte IV and 16-byte authentication tag
- **Key management:** 32-byte encryption key loaded from (in priority order):
  1. `NARRATORR_SECRET_KEY` environment variable
  2. `secret.key` file in the config directory (auto-generated on first run with `0600` permissions)
- **Encrypted entities** (the canonical list lives in `SECRET_FIELDS` at `src/server/utils/secret-codec.ts`): indexer API keys, indexer base URLs (`apiUrl` may embed `user:pass@host` credentials for Prowlarr-managed indexers), indexer FlareSolverr URLs, and MyAnonamouse session IDs (`mamId`); download client passwords/API keys; Prowlarr API keys; import list API keys; the Hardcover metadata API key; proxy URLs; the application's own API key and the forms-auth session secret; notifier secrets (webhook URLs/headers, Discord/Slack webhook URLs, Telegram bot tokens, SMTP passwords, Pushover/Gotify tokens)
- **Sentinel pattern:** API responses mask secrets with `********`. Updates that include the sentinel value preserve the existing encrypted value (no re-encryption of unchanged secrets)
- **Storage format:** `$ENC$<base64(iv + authTag + ciphertext)>` — encrypted values are distinguishable from plaintext

### Credential Redaction
- All credential fields are masked (`********`) in API responses — encrypted values never leave the server
- Proxy URLs are redacted before logging (credentials stripped from URL string)
- Request-trace logging passes URLs through a sanitizer that strips the query string, so credentials supplied as query parameters (e.g. `?apikey=`) do not appear in request logs
- Log output never contains decrypted credentials

## API Key Authentication

An API key is generated on first run (`crypto.randomUUID`). It can be regenerated at any time from Settings. Accepted via:
- `X-Api-Key` header (recommended)
- `?apikey=` query parameter (convenience for webhook URLs — note that query parameters may appear in server logs and referrer headers)

**Scope — the API key authenticates `/api/v*` only (#1453).** The key is no longer god-mode over the whole `/api/*` surface: a valid key authenticates the versioned public API (`/api/v1/...`) and is **rejected with 401 `{ error: 'Invalid API key' }`** on every other `/api/*` path (`/api/books`, `/api/settings`, the SSE endpoints, etc.). The scope check narrows only the API-key branch in `src/server/plugins/auth.ts` and is URL_BASE-aware (it composes with `config.urlBase` the same way the `/api/` interception does, and is pinned to `v` + digit so paths like `/api/version-history` are not swept in). All non-key credentials (forms session cookie, Basic-auth header, `none` mode, LAN/private-IP bypass, `AUTH_BYPASS`) are unchanged and still authorize the full `/api/*` surface with their existing CSRF rules. The Prowlarr/Readarr compatibility shim (`/api/v1/indexer*`, `/api/v1/system/status`) lives under `/api/v1/` and therefore stays key-reachable (see the documented contract exception under [API Versioning Policy](#api-versioning-policy)).

### SSE / stream auth — short-lived stream token (#1453)

The SSE/stream endpoints (`GET /api/events`, `GET /api/search/stream`) are **not API-key-reachable** — a bare key is rejected there, which is what makes "internal SSE stays numeric" honest (a public key-holder cannot pull numeric rowids off the event stream). The browser authenticates them with a **short-lived, session-scoped stream token**:

- The frontend mints one via `POST /api/auth/stream-token` (itself authenticated by the normal non-key chain — forms cookie / Basic+CSRF / `none` / LAN — and **not** key-reachable, since it sits outside `/api/v*`). The token travels as a `?token=` query param because `EventSource` cannot set request headers; it is re-minted transparently before/at expiry so live updates never drop.
- The token is HMAC-SHA256 signed (reusing the session-cookie machinery) with a **short TTL (minutes)**, independent of the 7-day session TTL and not sliding-renewed — a session renewal neither extends nor invalidates a live stream token.
- **Token-type domain separation.** Session cookies carry `kind: 'session'` + a `username`; stream tokens carry `kind: 'stream'` + no `username`, and are signed with a **domain-separated key** derived from the session secret (`HMAC(sessionSecret, 'stream-token')`). `verifyStreamToken` requires `kind === 'stream'`; `verifySessionCookie` requires a `username` and rejects a foreign `kind`. Net effect: a stream token never authenticates a session-cookie check and vice versa, even under secret reuse. (Legacy cookies issued before #1453 carry a `username` but no `kind` and stay valid until they expire or the session secret rotates.)
- The search-stream cancel route (`POST /api/search/stream/:sessionId/cancel/:indexerId`) is also key-unreachable; it authenticates via the ambient non-key credential the UI already sends (`fetchApi` → cookie/Basic+CSRF), not the stream token.

In `basic`/`none` modes the browser already authenticates same-origin `EventSource`/fetch via the Basic header or the open `none` chain; the stream token is the mechanism that lets **forms** mode authenticate SSE without putting a long-lived secret in the URL.

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

**Boot warning:** when forms-auth or local-network bypass is active and `TRUSTED_PROXIES` is unset, the server emits a `warn`-level log line at startup. If you run behind a reverse proxy, treat this as the signal to set `TRUSTED_PROXIES` — left unset, the forms-auth session cookie may be issued without the `Secure` attribute, and local-network bypass may treat every external client as local.

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

Three outbound code paths follow attacker-influenced URLs and route through the SSRF helpers in `src/core/utils/network-service.ts` (a custom Undici DNS lookup function that rejects unsafe destinations before the connection is made):

- **Cover-download** — cover art URLs from indexer responses or manually-pasted release URLs (`src/server/services/cover-download.ts`)
- **Torrent / NZB download** — download URLs from indexer search results, including 302 redirects to magnet links (`src/core/utils/download-url.ts`)
- **NZB content fetch** — NZB URLs from indexer XML during language enrichment, including 302 redirects to CDN-hosted content (`src/server/utils/enrich-usenet-languages.ts`)

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

**DNS rebinding mitigation:** the lookup function runs once per request and the connection is made to the resolved IP. A malicious DNS server that returns a public IP on first lookup and a private IP on a second cannot bypass the check. Per-redirect-hop revalidation re-runs the policy on each socket open, so 302→internal pivots are also caught.

**Response controls** (cover-download):
- Response size capped — truncation triggers an error before memory exhaustion
- Redirect limit caps redirect chains and prevents external→internal pivots
- AbortSignal timeout enforced

**Coverage scope:** SSRF address-blocking is intentionally scoped to attacker-influenced URLs. Operator-configured fetch destinations — indexer apiUrl, download-client host, notifier webhook URL, import-list source, metadata provider — are NOT address-blocked, by design. Self-hosted *arr deployments legitimately point at private-IP services (Prowlarr in Docker compose, qBittorrent on LAN, self-hosted Apprise instance). The trust boundary for those paths is "the operator configured this URL"; extending the block policy would break legitimate setups. See `CLAUDE.md` security section and closed issues #769 / #877 / #885 for the design rationale.

## Connector refresh (best-effort)

After an import/rename/scan changes the library, `ConnectorService` notifies the configured media-server connectors (Audiobookshelf, Plex) to refresh. This queue is **best-effort and in-memory by design** — pending work is held only as debounced `setTimeout` timers, with no durable/persistent backing.

- On graceful shutdown, `ConnectorService.stop()` (wired into the server's `shutdown()` handler before `app.close()`) clears pending timers, warn-logs any dropped batches with the connector id and item count, and awaits any in-flight flush (including one mid-retry-backoff) so it isn't cut off.
- All queue timers are `unref()`'d so a pending refresh can never delay graceful shutdown past SIGTERM.
- A hard crash (SIGKILL/OOM) or a refresh still inside its debounce window **is dropped** — accepted because the downstream media server reconciles on its own next library change or periodic scan. A durable/DB-backed queue is intentionally out of scope for this single-process self-hosted app (consistent with the no-over-engineering posture in #769/#877/#885).

## Input Validation

- All API inputs are validated with **Zod schemas** before processing — including persisted JSON columns (`phaseHistory`, manual-import metadata) on read, and external API responses from download clients, metadata providers, and import-list sources
- The application uses **Drizzle ORM** with parameterized queries — no raw SQL with string interpolation
- **Path ancestry validation** for filesystem operations that could escape the configured library root uses `path.relative(root, candidate)` with `..`-prefix and self-resolve checks (not `startsWith()`, which would let `/library2/...` pass when root is `/library`). The canonical helper is `assertPathInsideLibrary` in `src/server/utils/paths.ts`, which throws `PathOutsideLibraryError` on escape; consumers include `cleanupOldBookPath`, `cleanEmptyParents`, and library-scan filtering — book-deletion `rm()` is gated on this check so a corrupt or attacker-influenced book record cannot escape the library root
- Streaming parser errors are mapped to 4xx responses by checking error messages, not blanket 500

## Dependencies

Dependency vulnerabilities are tracked via `pnpm audit`. As of 2026-05-29, `pnpm audit` reports **zero vulnerabilities** at any severity. Where a transitive advisory has no fixed release from its direct parent yet, the patched version is pinned via `pnpm.overrides` in `package.json` (current pins include `esbuild`, `ajv`, `minimatch`, `file-type`, `fast-uri`, `ip-address`, `ws`, and `brace-expansion`).

Supply-chain hardening: `pnpm` 10's lifecycle scripts are restricted via `pnpm.onlyBuiltDependencies` in `package.json`, which limits postinstall script execution to an explicit allowlist. Re-run `pnpm audit` after dependency changes; new findings are filed and tracked in the issue queue.

## Error Message Exposure

Connection test endpoints return upstream API error messages to the authenticated user. These messages may contain internal hostnames, paths, or network details from the connected service. This is intentional — the user configuring the connection is the server operator and already has this context. Sanitizing errors would hinder debugging without security benefit.

Generic error responses for unauthenticated or unexpected errors use `{ error: 'Internal server error' }` with no stack traces or internal details.

## Public-compatibility API surfaces

A handful of endpoints have no in-tree caller but are preserved as a stable contract for external integrations (scripts, dashboards, CI helpers). They are kept intentionally — do not remove them without an external API review.

| Endpoint | Rationale |
|----------|-----------|
| `POST /api/system/tasks/search` | Manual trigger for the scheduled search cycle. The generic `POST /api/system/tasks/:name/run` is the preferred surface for new integrations, but legacy automations may target this dedicated path. Removed in code review only. |

## API Versioning Policy

Narratorr exposes two HTTP API surfaces with deliberately different stability guarantees:

- **`/api/*` — internal & unstable.** This is the surface the bundled web UI consumes. It carries **no backwards-compatibility promise**: routes, request/response shapes, and error envelopes may change between releases without notice. Do not build external integrations against it.
- **`/api/v1/*` — public & supported.** The versioned, native public API. Its contract is locked by the canonical v1 building blocks in `src/shared/schemas/v1/common.ts` and the conventions below. Breaking changes require a new version prefix (`/api/v2/*`), never a silent change under `/api/v1/`.

**Documented contract exception — Prowlarr/Readarr compatibility shim.** The endpoints `/api/v1/indexer*` and `/api/v1/system/status` (`src/server/routes/prowlarr-compat.ts`) live under the `/api/v1/` prefix but are **not** native v1. They impersonate Prowlarr/Readarr so those tools can manage narratorr as an indexer target, and their shapes are dictated by the external product, not by narratorr's v1 conventions. Treat them as a named exception; do not mistake them for, or align them with, the native v1 contract.

### v1 conventions (ADR)

These decisions are locked by S0 (#1442, part of the Public API v1 epic #1441) and codified in `src/shared/schemas/v1/common.ts`. Downstream stories import those types rather than re-deriving them.

| Concern | Decision |
|---------|----------|
| **Pagination** | Offset/limit (`limit`, `offset`), reusing `paginationParamsSchema` from `src/shared/schemas/common.ts`. A single-user library is not a feed — cursor pagination is explicitly rejected. The v1 schema does **not** fork a second pagination shape. |
| **Filter/sort param naming** | camelCase, short, optional (`sortField`, `sortDirection`, `author`, `series`, `narrator`) — never `sort_by` / `filter_author`. Matches `bookListQuerySchema`. |
| **Error envelope** | `{ error: { code, message } }` — an object with a stable machine-readable `code` and human-readable `message`, never a bare string. **v1-only:** the internal `/api/*` error handler (`src/server/plugins/error-handler.ts`) keeps its existing ad-hoc shape and is **not** retrofitted. |
| **List response** | `{ data, total }` (never a bare array), aligning with the existing `PaginatedResponse<T>`. |
| **Date format** | ISO 8601 strings. Fastify + `fastify-type-provider-zod` already serialize `Date → ISO` automatically; no new serialization code is needed. |
| **Request-validator strictness** | Native v1 request validators are schemas narratorr owns → Zod `.strict()`. This is the **opposite** of the prowlarr-compat surface, which must stay `.strip()` (the impersonated product controls that payload). v1 schemas must not drift toward `.strip()`/`.passthrough()`. |
| **CORS** | Target shape is a configurable comma-separated allowlist of origins, for future browser-based sidecars. **Documented now, implementation deferred** to the first browser consumer — today CORS is a single configurable `CORS_ORIGIN` (`src/server/cors-config.ts`) and that runtime behavior is unchanged by this policy. |
| **Rate-limiting** | Native public API v1 rate limiting is **deliberately out of scope** (single-user self-hosted threat model, not public abuse). This is a documented decision, not an oversight. The existing auth and filesystem-browse rate limits (see [Rate Limiting](#rate-limiting)) remain unchanged. |

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue. Contact the maintainer directly or use GitHub's private vulnerability reporting feature.
