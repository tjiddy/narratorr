import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError, NoCredentialsError, STREAM_TOKEN_TTL_MS } from '../services/auth.service.js';
import { loginSchema, setupCredentialsSchema, changePasswordSchema, updateAuthConfigSchema, type LoginInput, type SetupCredentialsInput, type ChangePasswordInput, type UpdateAuthConfigInput } from '@shared/schemas.js';
import { config } from '../config.js';
import { isPrivateIp } from '../plugins/auth.js';
import { serializeError } from '../utils/serialize-error.js';
import { sessionCookieOptions } from '../utils/cookie-options.js';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/** Reissue a forms cookie with the rotated secret and effective username. */
async function reissueSessionCookie(
  authService: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  effectiveUsername: string,
): Promise<void> {
  const status = await authService.getStatus();
  if (status.mode !== 'forms') return;
  const secret = await authService.getSessionSecret();
  const cookie = authService.createSessionCookie(effectiveUsername, secret);
  reply.setCookie('narratorr_session', cookie, {
    ...sessionCookieOptions(config, request),
    maxAge: SESSION_MAX_AGE_S,
  });
}

export async function authRoutes(app: FastifyInstance, authService: AuthService) {
  // Keep public status limited to mode/authenticated; deployment details require admin auth.
  app.get('/api/auth/status', async (request) => {
    try {
      const status = await authService.getStatus();

      let authenticated = true;
      if (status.mode === 'forms') {
        const cookie = request.cookies?.narratorr_session;
        if (cookie) {
          const secret = await authService.getSessionSecret();
          const session = authService.verifySessionCookie(cookie, secret);
          authenticated = session !== null;
        } else {
          authenticated = false;
        }
      }

      return { mode: status.mode, authenticated };
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Failed to fetch auth status');
      throw error;
    }
  });

  app.get('/api/auth/admin-status', async (request) => {
    const status = await authService.getStatus();
    const bypassActive = config.authBypass || (status.localBypass && isPrivateIp(request.ip));
    const envBypass = Boolean(config.authBypass);
    return {
      hasUser: status.hasUser,
      username: status.username,
      localBypass: status.localBypass,
      bypassActive,
      envBypass,
    };
  });

  app.delete('/api/auth/credentials', async (request, reply) => {
    if (!config.authBypass) {
      return reply.status(403).send({ error: 'Only available when AUTH_BYPASS is active' });
    }
    try {
      await authService.deleteCredentials();
      request.log.info('Credentials deleted via AUTH_BYPASS');
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof NoCredentialsError) {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Body: LoginInput }>(
    '/api/auth/login',
    {
      schema: { body: loginSchema },
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const verified = await authService.verifyCredentials(username, password);

      if (!verified) {
        request.log.info({ username }, 'Failed login attempt');
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      const secret = await authService.getSessionSecret();
      const cookie = authService.createSessionCookie(username, secret);

      reply.setCookie('narratorr_session', cookie, {
        ...sessionCookieOptions(config, request),
        maxAge: SESSION_MAX_AGE_S,
      });

      request.log.info({ username }, 'User logged in');
      return { success: true };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie('narratorr_session', sessionCookieOptions(config, request));
    return { success: true };
  });

  app.post<{ Body: SetupCredentialsInput }>(
    '/api/auth/setup',
    {
      schema: { body: setupCredentialsSchema },
      config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      try {
        const { username, password } = request.body;
        await authService.createUser(username, password);
        request.log.info({ username }, 'User account created');
        return { success: true };
      } catch (error: unknown) {
        if (error instanceof UserExistsError) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get('/api/auth/config', async () => {
    return authService.getConfig();
  });

  app.put<{ Body: UpdateAuthConfigInput }>(
    '/api/auth/config',
    { schema: { body: updateAuthConfigSchema } },
    async (request, reply) => {
      try {
        const updates = request.body;
        const result = await authService.updateConfig(updates);
        request.log.info({ updates }, 'Auth config updated');
        return result;
      } catch (error: unknown) {
        if (error instanceof AuthConfigError) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.put<{ Body: ChangePasswordInput }>(
    '/api/auth/password',
    { schema: { body: changePasswordSchema } },
    async (request, reply) => {
      try {
        const { currentPassword, newPassword, newUsername } = request.body;
        const user = request.user;

        if (!user) {
          return await reply.status(401).send({ error: 'Authentication required' });
        }

        const effectiveUsername = await authService.changePassword(user.username, currentPassword, newPassword, newUsername);
        request.log.info({ username: user.username, newUsername }, 'Credentials updated');

        await reissueSessionCookie(authService, request, reply, effectiveUsername);

        return { success: true };
      } catch (error: unknown) {
        if (error instanceof IncorrectPasswordError) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // API keys and existing stream tokens cannot authenticate this non-v1 minting route.
  // Basic-auth callers still pass through the CSRF gate.
  app.post('/api/auth/stream-token', async () => {
    const secret = await authService.getSessionSecret();
    const token = authService.mintStreamToken(secret);
    return { token, expiresInMs: STREAM_TOKEN_TTL_MS };
  });

  app.post('/api/auth/api-key/regenerate', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request) => {
    const newKey = await authService.regenerateApiKey();
    request.log.info('API key regenerated');
    return { apiKey: newKey };
  });
}
