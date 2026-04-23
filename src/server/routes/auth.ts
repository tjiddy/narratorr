import { type FastifyInstance } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError, NoCredentialsError } from '../services/auth.service.js';
import { loginSchema, setupCredentialsSchema, changePasswordSchema, updateAuthConfigSchema, type LoginInput, type SetupCredentialsInput, type ChangePasswordInput, type UpdateAuthConfigInput } from '../../shared/schemas.js';
import { config } from '../config.js';
import { isPrivateIp } from '../plugins/auth.js';
import { serializeError } from '../utils/serialize-error.js';


export async function authRoutes(app: FastifyInstance, authService: AuthService) {
  // GET /api/auth/status — public, no secrets
  // Also checks session cookie to include `authenticated` and `bypassActive` flags for the frontend
  app.get('/api/auth/status', async (request) => {
    try {
      const status = await authService.getStatus();

      // Determine if the current request is authenticated
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

      // Request-scoped bypass: true when AUTH_BYPASS env var is set OR local network bypass applies
      const bypassActive = config.authBypass || (status.localBypass && isPrivateIp(request.ip));
      // env-only bypass: true only when AUTH_BYPASS env var is set (not local network bypass)
      const envBypass = Boolean(config.authBypass);

      return { ...status, authenticated, bypassActive, envBypass };
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Failed to fetch auth status');
      throw error;
    }
  });

  // DELETE /api/auth/credentials — only allowed when AUTH_BYPASS is active
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

  // POST /api/auth/login — public, sets session cookie
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

      // Set session cookie
      const secret = await authService.getSessionSecret();
      const cookie = authService.createSessionCookie(username, secret);

      reply.setCookie('narratorr_session', cookie, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });

      request.log.info({ username }, 'User logged in');
      return { success: true };
    },
  );

  // POST /api/auth/logout — public, clears cookie
  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('narratorr_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    return { success: true };
  });

  // POST /api/auth/setup — public if no user exists, else protected (handled by middleware)
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

  // GET /api/auth/config — protected, returns config without sessionSecret
  app.get('/api/auth/config', async () => {
    return authService.getConfig();
  });

  // PUT /api/auth/config — protected, updates mode and/or localBypass
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

  // PUT /api/auth/password — protected, change password
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

        await authService.changePassword(user.username, currentPassword, newPassword, newUsername);
        request.log.info({ username: user.username, newUsername }, 'Credentials updated');
        return { success: true };
      } catch (error: unknown) {
        if (error instanceof IncorrectPasswordError) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // POST /api/auth/api-key/regenerate — protected
  app.post('/api/auth/api-key/regenerate', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request) => {
    const newKey = await authService.regenerateApiKey();
    request.log.info('API key regenerated');
    return { apiKey: newKey };
  });
}
