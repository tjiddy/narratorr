import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { config } from '../config.js';
import { sessionCookieOptions } from '../utils/cookie-options.js';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

export interface AuthPluginOptions {
  authService: AuthService;
  urlBase?: string;
}

/** Base public route paths (without URL_BASE prefix). */
const BASE_PUBLIC_ROUTES = [
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
  '/api/system/status',
];

/** Methods that don't require CSRF protection. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforce CSRF protection for authenticated basic-auth requests.
 * Browsers replay cached `Authorization: Basic` credentials cross-origin, so we require
 * `X-Requested-With: XMLHttpRequest` on state-changing methods. Browsers cannot set this
 * header cross-origin without a CORS preflight, blocking classic form-submit CSRF.
 */
function enforceCsrf(request: FastifyRequest, reply: FastifyReply): void {
  if (SAFE_METHODS.has(request.method)) return;
  if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
    reply.status(403).send({ error: 'CSRF protection: missing X-Requested-With header' });
  }
}

/**
 * Private IP ranges for local network bypass.
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, ::1, fe80::/10
 */
function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('127.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip === '::1') return true;
  if (ip === '::ffff:127.0.0.1') return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true;

  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) return isPrivateIp(v4Mapped[1]!);

  return false;
}

function setUser(request: FastifyRequest, username: string) {
  request.user = { username };
}

/**
 * Try API key auth. Returns true if handled (pass or reject), false to continue.
 *
 * De-god-moded in #1453: the API key only authenticates the versioned public
 * surface (`/api/v*`). When `inVScope` is false the key is treated as absent —
 * we return false so the non-key credential chain (forms cookie / basic / none /
 * LAN bypass) is still evaluated and a valid one wins. This is what prevents a
 * stray `?apikey=` from shadowing a valid cookie or stream token on the SSE
 * endpoints, while an API-key-*only* request to a non-`v*` path still falls
 * through to the mode handler's 401.
 */
async function tryApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  inVScope: boolean,
): Promise<boolean> {
  const rawHeader = request.headers['x-api-key'];
  const apiKeyHeader = typeof rawHeader === 'string' ? rawHeader : undefined;
  const rawQuery = (request.query as Record<string, unknown>)?.apikey;
  const apiKeyQuery = typeof rawQuery === 'string' ? rawQuery : undefined;
  const apiKey = apiKeyHeader || apiKeyQuery;

  if (!apiKey) return false;

  // Out of `/api/v*` scope the key is no longer god-mode — ignore it and let the
  // ambient credential chain decide (and reject if no other credential exists).
  if (!inVScope) return false;

  const valid = await authService.validateApiKey(apiKey);
  if (valid) {
    request.log.debug('Auth: API key validated');
    setUser(request, 'api-key');
    return true;
  }

  request.log.debug('Auth: invalid API key');
  reply.status(401).send({ error: 'Invalid API key' });
  return true;
}

/**
 * Try stream-token auth (#1453). Only consulted on the SSE endpoints. The token
 * travels as a `?token=` query param (EventSource cannot set headers). Returns
 * true only on a valid token (accept); an absent/invalid token returns false so
 * the ambient non-key credential chain still runs — never rejects here, so a
 * stale token cannot shadow a valid cookie.
 */
async function tryStreamToken(
  request: FastifyRequest,
  authService: AuthService,
): Promise<boolean> {
  const rawToken = (request.query as Record<string, unknown>)?.token;
  const token = typeof rawToken === 'string' ? rawToken : undefined;
  if (!token) return false;

  const secret = await authService.getSessionSecret();
  const payload = authService.verifyStreamToken(token, secret);
  if (!payload) return false;

  request.log.debug('Auth: stream token validated');
  setUser(request, 'stream-token');
  return true;
}

/** Handle Basic auth mode. Returns true if handled. */
async function handleBasicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<boolean> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    reply.header('www-authenticate', 'Basic realm="Narratorr"');
    reply.status(401).send({ error: 'Authentication required' });
    return true;
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const colonIndex = decoded.indexOf(':');
  if (colonIndex < 1) {
    reply.header('www-authenticate', 'Basic realm="Narratorr"');
    reply.status(401).send({ error: 'Invalid credentials' });
    return true;
  }
  const username = decoded.slice(0, colonIndex);
  const password = decoded.slice(colonIndex + 1);
  const verified = await authService.verifyCredentials(username, password);

  if (!verified) {
    reply.header('www-authenticate', 'Basic realm="Narratorr"');
    reply.status(401).send({ error: 'Invalid credentials' });
    return true;
  }

  setUser(request, verified.username);
  return true;
}

/** Handle Forms auth mode. Returns true if handled. */
async function handleFormsAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<boolean> {
  const sessionCookie = request.cookies?.['narratorr_session'];
  if (!sessionCookie) {
    reply.status(401).send({ error: 'Authentication required' });
    return true;
  }

  const secret = await authService.getSessionSecret();
  const result = authService.verifySessionCookie(sessionCookie, secret);

  if (!result) {
    reply.status(401).send({ error: 'Invalid or expired session' });
    return true;
  }

  setUser(request, result.payload.username);

  // Sliding expiry — renew cookie if >50% through TTL
  if (result.shouldRenew) {
    const newCookie = authService.createSessionCookie(result.payload.username, secret);
    reply.setCookie('narratorr_session', newCookie, {
      ...sessionCookieOptions(config, request),
      maxAge: SESSION_MAX_AGE_S,
    });
    request.log.debug({ username: result.payload.username }, 'Auth: session cookie renewed (sliding expiry)');
  }

  return true;
}

/**
 * Authorize via the ambient (non-key, non-stream-token) credential chain:
 * LAN/private-IP bypass, then the active auth mode (`none`/`basic`/`forms`),
 * falling back to 401. Extracted from the onRequest hook to keep that hook under
 * the cyclomatic-complexity cap once the stream-token branch was added (#1453).
 */
async function handleAmbientAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<void> {
  const status = await authService.getStatus();

  // Local network bypass
  if (status.localBypass && isPrivateIp(request.ip)) {
    request.log.debug({ ip: request.ip }, 'Auth: local bypass for private IP');
    setUser(request, 'local-bypass');
    return;
  }

  if (status.mode === 'none') return;
  if (status.mode === 'basic') {
    await handleBasicAuth(request, reply, authService);
    // Apply CSRF protection only after successful basic-auth (request.user populated).
    // Unauthenticated requests already received the 401 + WWW-Authenticate challenge.
    if (request.user) enforceCsrf(request, reply);
    return;
  }
  if (status.mode === 'forms') { await handleFormsAuth(request, reply, authService); return; }

  reply.status(401).send({ error: 'Authentication required' });
}

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  const { authService, urlBase: rawUrlBase } = opts;
  const urlBase = rawUrlBase && rawUrlBase !== '/' ? rawUrlBase : '';
  const apiPrefix = `${urlBase}/api/`;

  // Build public routes set with URL_BASE prefix
  const PUBLIC_ROUTES = new Set(
    BASE_PUBLIC_ROUTES.map((route) => `${urlBase}${route}`),
  );
  const setupRoute = `${urlBase}/api/auth/setup`;

  // SSE/stream endpoints (#1453): these accept a short-lived stream token (query
  // param) in addition to ambient non-key credentials, and reject the API key.
  const STREAM_ROUTES = new Set([
    `${urlBase}/api/events`,
    `${urlBase}/api/search/stream`,
  ]);

  /**
   * Is `routePath` under the versioned public surface `/api/v<digit>` (#1453)?
   * Derived from `urlBase` the same way `apiPrefix` is — never a hardcoded
   * `/api/` literal — so `URL_BASE=/narratorr` still matches
   * `/narratorr/api/v1/...`. Pinned to `v` + digit so non-versioned paths that
   * merely start with `v` (e.g. `/api/version-history`) are NOT swept in. The
   * Prowlarr-compat shim (`/api/v1/indexer*`, `/api/v1/system/status`) lives
   * under `/api/v1/` and therefore stays key-reachable by this rule.
   */
  const isApiVScope = (routePath: string): boolean =>
    routePath.startsWith(apiPrefix) && /^v\d/.test(routePath.slice(apiPrefix.length));

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only intercept {urlBase}/api/* routes
    if (!request.url.startsWith(apiPrefix)) return;

    const routePath = request.url.split('?')[0]!;

    // Public routes
    if (PUBLIC_ROUTES.has(routePath)) return;

    // /api/auth/setup is public when no user exists
    if (routePath === setupRoute && request.method === 'POST') {
      const hasUser = await authService.hasUser();
      if (!hasUser) return;
    }

    // AUTH_BYPASS env var
    if (config.authBypass) {
      request.log.debug('Auth bypassed via AUTH_BYPASS env var');
      return;
    }

    // Stream token (#1453) — accepted only on the SSE endpoints, before the API
    // key is consulted, so a valid token authenticates even when a stale
    // `?apikey=` is also present. Absent/invalid token falls through.
    if (STREAM_ROUTES.has(routePath)) {
      if (await tryStreamToken(request, authService)) return;
    }

    // API key auth — scoped to `/api/v*` only (#1453). On non-`v*` paths the key
    // is ignored and the request continues to the ambient credential chain.
    if (await tryApiKey(request, reply, authService, isApiVScope(routePath))) {
      // tryApiKey may have set request.user (success) or sent 401 (failure).
      // CSRF check is skipped either way: api-key clients are exempt (AC5),
      // and on 401 the reply has already been sent.
      return;
    }

    // Ambient (non-key) credential chain: LAN bypass → mode handler → 401.
    await handleAmbientAuth(request, reply, authService);
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});

export { isPrivateIp };
