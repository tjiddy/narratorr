import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from './services/auth.service.js';

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
