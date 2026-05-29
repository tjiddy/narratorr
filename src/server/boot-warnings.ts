import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from './services/auth.service.js';
import type { AuthMode } from '../shared/schemas.js';

/**
 * Emit a warn-level boot log when AUTH_BYPASS=true AND a user account exists.
 *
 * AUTH_BYPASS disables authentication globally; combined with an existing user
 * account it means anyone reaching the server can wipe credentials via
 * DELETE /api/auth/credentials. We log loudly at boot so operators see it in
 * startup output. One-shot only — no recurring poll. (#742)
 */
export async function warnIfAuthBypassWithUser(
  authBypass: boolean,
  authService: Pick<AuthService, 'hasUser'>,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!authBypass) return;
  if (!(await authService.hasUser())) return;
  log.warn(
    'AUTH_BYPASS is active and a user account exists; authentication is disabled for all requests',
  );
}

/**
 * Emit warn-level boot logs when TRUSTED_PROXIES is unset but reverse-proxy
 * auth features are active.
 *
 * With `trustedProxies === false`, Fastify reads `request.protocol`/`request.ip`
 * from the upstream socket rather than the proxy's forwarded headers. That
 * silently degrades two auth paths: the forms-auth session cookie loses its
 * Secure attribute (it sees `http`), and the local-network bypass treats the
 * proxy container's private-bridge IP as a local client, authenticating every
 * external request as `local-bypass`. SECURITY.md §Reverse-proxy deployments
 * documents the requirement; this is the programmatic boot-time guard. (#1174)
 */
export async function warnIfReverseProxyMisconfigured(
  authMode: AuthMode,
  localBypass: boolean,
  trustedProxies: boolean | string[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (trustedProxies !== false) return;
  if (authMode === 'forms') {
    log.warn(
      'Forms-auth is enabled but TRUSTED_PROXIES is unset. ' +
        'If Narratorr runs behind a TLS-terminating reverse proxy, the session cookie ' +
        'will be set without the Secure attribute. See SECURITY.md §Reverse-proxy deployments.',
    );
  }
  if (localBypass) {
    log.warn(
      'Local-network bypass is enabled but TRUSTED_PROXIES is unset. ' +
        'If Narratorr runs behind a reverse proxy on a private subnet, every external ' +
        'request will appear local and skip authentication. See SECURITY.md.',
    );
  }
}

/**
 * Boot orchestration for the reverse-proxy misconfiguration warning (#1174).
 *
 * Reads persisted auth status (must run AFTER `authService.initialize()`) and
 * forwards `mode`, `localBypass`, and the configured `trustedProxies` to
 * `warnIfReverseProxyMisconfigured`. Extracted from `main()` so the status read
 * and field mapping are unit-testable — the call site in `index.ts` is a single
 * line that TypeScript checks for field names, but the wiring (reading
 * `getStatus()` and passing the right values) is exercised here.
 */
export async function checkReverseProxyBootConfig(
  authService: Pick<AuthService, 'getStatus'>,
  trustedProxies: boolean | string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const status = await authService.getStatus();
  await warnIfReverseProxyMisconfigured(status.mode, status.localBypass, trustedProxies, log);
}
