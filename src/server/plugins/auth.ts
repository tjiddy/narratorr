import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { config } from '../config.js';
import { sessionCookieOptions } from '../utils/cookie-options.js';
import { isProwlarrCompatPath } from '../routes/prowlarr-compat.js';
import { isV1DocsPath } from '../routes/v1/openapi.js';

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

/** Require a non-simple header on Basic-auth mutations to block browser-replayed CSRF. */
function enforceCsrf(request: FastifyRequest, reply: FastifyReply): void {
  if (SAFE_METHODS.has(request.method)) return;
  if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
    reply.status(403).send({ error: 'CSRF protection: missing X-Requested-With header' });
  }
}

/** RFC1918, loopback, IPv4-mapped loopback, and link-local IPv6 ranges. */
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

/** Extract the supplied API key from the `X-Api-Key` header or `?apikey=` query (string-narrowed). */
function extractApiKey(request: FastifyRequest): string | undefined {
  const rawHeader = request.headers['x-api-key'];
  const apiKeyHeader = typeof rawHeader === 'string' ? rawHeader : undefined;
  const rawQuery = (request.query as Record<string, unknown>)?.apikey;
  const apiKeyQuery = typeof rawQuery === 'string' ? rawQuery : undefined;
  return apiKeyHeader || apiKeyQuery;
}

/**
 * Authenticate v-scoped keys. Rejections use the native v1 envelope except on
 * compatibility paths; validation faults propagate as 500s instead of bad-key 401s.
 */
async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  apiKey: string,
  useV1Envelope: boolean,
): Promise<void> {
  if (await authService.validateApiKey(apiKey)) {
    request.log.debug('Auth: API key validated');
    setUser(request, 'api-key');
    return;
  }
  request.log.debug('Auth: invalid API key');
  if (useV1Envelope) {
    reply.status(401).send({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
    return;
  }
  reply.status(401).send({ error: 'Invalid API key' });
}

/** Detect a real session or Basic credential so stale out-of-scope keys cannot shadow it. */
function hasAmbientCredential(request: FastifyRequest, mode: 'none' | 'basic' | 'forms'): boolean {
  if (mode === 'forms') return Boolean(request.cookies?.['narratorr_session']);
  if (mode === 'basic') {
    const header = request.headers.authorization;
    return typeof header === 'string' && header.startsWith('Basic ');
  }
  return false;
}

/** Accept valid SSE query tokens; absent or invalid tokens fall through to ambient credentials. */
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

  // Renew sliding sessions after half their TTL.
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

/** Apply LAN bypass, the active non-key auth mode, then the final 401. */
async function handleAmbientAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  outOfScopeApiKey: boolean,
): Promise<void> {
  const status = await authService.getStatus();

  if (status.localBypass && isPrivateIp(request.ip)) {
    request.log.debug({ ip: request.ip }, 'Auth: local bypass for private IP');
    setUser(request, 'local-bypass');
    return;
  }

  if (status.mode === 'none') return;

  // Out-of-scope keys never authenticate. Key-only requests keep the API-key error,
  // while real ambient credentials win over stale keys.
  if (outOfScopeApiKey && !hasAmbientCredential(request, status.mode)) {
    request.log.debug('Auth: out-of-scope API key rejected');
    reply.status(401).send({ error: 'Invalid API key' });
    return;
  }

  if (status.mode === 'basic') {
    await handleBasicAuth(request, reply, authService);
    // Failed Basic auth already sent its challenge; only authenticated requests reach CSRF.
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

  const PUBLIC_ROUTES = new Set(
    BASE_PUBLIC_ROUTES.map((route) => `${urlBase}${route}`),
  );
  const setupRoute = `${urlBase}/api/auth/setup`;

  // SSE accepts stream tokens and ambient credentials, never API keys.
  const STREAM_ROUTES = new Set([
    `${urlBase}/api/events`,
    `${urlBase}/api/search/stream`,
  ]);

  /** Match URL_BASE-aware `/api/v<digit>` paths without sweeping in names like version-history. */
  const isApiVScope = (routePath: string): boolean =>
    routePath.startsWith(apiPrefix) && /^v\d/.test(routePath.slice(apiPrefix.length));

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith(apiPrefix)) return;

    const routePath = request.url.split('?')[0]!;

    if (PUBLIC_ROUTES.has(routePath)) return;

    // Swagger UI is a public subtree; ordinary /api/v1 data routes remain protected.
    if (isV1DocsPath(routePath, urlBase)) return;

    // Setup is public only until the first user exists.
    if (routePath === setupRoute && request.method === 'POST') {
      const hasUser = await authService.hasUser();
      if (!hasUser) return;
    }

    if (config.authBypass) {
      request.log.debug('Auth bypassed via AUTH_BYPASS env var');
      return;
    }

    const apiKey = extractApiKey(request);
    const inVScope = isApiVScope(routePath);

    // Check stream tokens first so a stale apikey cannot shadow a valid SSE token.
    if (STREAM_ROUTES.has(routePath) && await tryStreamToken(request, authService)) return;

    // Key auth is terminal and CSRF-exempt; native v1 uses its envelope, compat stays legacy.
    if (apiKey && inVScope) {
      const useV1Envelope = !isProwlarrCompatPath(routePath, urlBase);
      await authenticateApiKey(request, reply, authService, apiKey, useV1Envelope);
      return;
    }

    // Ambient credentials beat stale out-of-scope keys; key-only requests retain key errors.
    await handleAmbientAuth(request, reply, authService, Boolean(apiKey) && !inVScope);
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});

export { isPrivateIp };
