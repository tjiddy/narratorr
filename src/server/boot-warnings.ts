import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from './services/auth.service.js';
import type { AuthMode } from '@shared/schemas.js';

/** Warn when auth bypass plus an existing user exposes credential deletion to any caller. */
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
 * Warn when forms auth or local bypass depends on forwarded protocol/IP but
 * trusted proxies are disabled; cookies can lose Secure and proxy clients can appear local.
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

/** Read initialized auth state and check reverse-proxy-dependent settings. */
export async function checkReverseProxyBootConfig(
  authService: Pick<AuthService, 'getStatus'>,
  trustedProxies: boolean | string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const status = await authService.getStatus();
  await warnIfReverseProxyMisconfigured(status.mode, status.localBypass, trustedProxies, log);
}
