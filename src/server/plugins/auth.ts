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

/** Try API key auth. Returns true if handled (pass or reject), false to continue. */
async function tryApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<boolean> {
  const rawHeader = request.headers['x-api-key'];
  const apiKeyHeader = typeof rawHeader === 'string' ? rawHeader : undefined;
  const rawQuery = (request.query as Record<string, unknown>)?.apikey;
  const apiKeyQuery = typeof rawQuery === 'string' ? rawQuery : undefined;
  const apiKey = apiKeyHeader || apiKeyQuery;

  if (!apiKey) return false;

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

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  const { authService, urlBase: rawUrlBase } = opts;
  const urlBase = rawUrlBase && rawUrlBase !== '/' ? rawUrlBase : '';
  const apiPrefix = `${urlBase}/api/`;

  // Build public routes set with URL_BASE prefix
  const PUBLIC_ROUTES = new Set(
    BASE_PUBLIC_ROUTES.map((route) => `${urlBase}${route}`),
  );
  const setupRoute = `${urlBase}/api/auth/setup`;

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

    // API key auth — works in all modes
    if (await tryApiKey(request, reply, authService)) {
      // tryApiKey may have set request.user (success) or sent 401 (failure).
      // CSRF check is skipped either way: api-key clients are exempt (AC5),
      // and on 401 the reply has already been sent.
      return;
    }

    // Get auth status for mode + bypass checks
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
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});

export { isPrivateIp };
