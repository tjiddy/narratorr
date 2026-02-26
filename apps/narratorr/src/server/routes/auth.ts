import { type FastifyInstance } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { loginSchema, setupCredentialsSchema, changePasswordSchema, updateAuthConfigSchema } from '../../shared/schemas.js';
import { config } from '../config.js';

export async function authRoutes(app: FastifyInstance, authService: AuthService) {
  // GET /api/auth/status — public, no secrets
  // Also checks session cookie to include `authenticated` flag for the frontend
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

      return { ...status, authenticated };
    } catch (error) {
      request.log.error(error, 'Failed to fetch auth status');
      throw error;
    }
  });

  // POST /api/auth/login — public, sets session cookie
  app.post(
    '/api/auth/login',
    { schema: { body: loginSchema } },
    async (request, reply) => {
      try {
        const { username, password } = request.body as { username: string; password: string };
        const verified = await authService.verifyCredentials(username, password);

        if (!verified) {
          request.log.info({ username }, 'Failed login attempt');
          return await reply.status(401).send({ error: 'Invalid credentials' });
        }

        // Set session cookie
        const secret = await authService.getSessionSecret();
        const cookie = authService.createSessionCookie(username, secret);

        reply.setCookie('narratorr_session', cookie, {
          httpOnly: true,
          sameSite: 'lax',
          secure: !config.isDev,
          path: '/',
          maxAge: 7 * 24 * 60 * 60, // 7 days
        });

        request.log.info({ username }, 'User logged in');
        return { success: true };
      } catch (error) {
        request.log.error(error, 'Login failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/auth/logout — public, clears cookie
  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('narratorr_session', { path: '/' });
    return { success: true };
  });

  // POST /api/auth/setup — public if no user exists, else protected (handled by middleware)
  app.post(
    '/api/auth/setup',
    { schema: { body: setupCredentialsSchema } },
    async (request, reply) => {
      try {
        const { username, password } = request.body as { username: string; password: string };
        await authService.createUser(username, password);
        request.log.info({ username }, 'User account created');
        return { success: true };
      } catch (error) {
        if (error instanceof Error && error.message === 'User already exists') {
          return reply.status(409).send({ error: 'User already exists' });
        }
        request.log.error(error, 'Failed to create user');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/auth/config — protected, returns config without sessionSecret
  app.get('/api/auth/config', async (request, reply) => {
    try {
      return await authService.getConfig();
    } catch (error) {
      request.log.error(error, 'Failed to fetch auth config');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /api/auth/config — protected, updates mode and/or localBypass
  app.put(
    '/api/auth/config',
    { schema: { body: updateAuthConfigSchema } },
    async (request, reply) => {
      try {
        const updates = request.body as { mode?: string; localBypass?: boolean };
        const result = await authService.updateConfig(updates as Parameters<typeof authService.updateConfig>[0]);
        request.log.info({ updates }, 'Auth config updated');
        return result;
      } catch (error) {
        if (error instanceof Error && error.message.includes('without credentials')) {
          return reply.status(400).send({ error: error.message });
        }
        request.log.error(error, 'Failed to update auth config');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // PUT /api/auth/password — protected, change password
  app.put(
    '/api/auth/password',
    { schema: { body: changePasswordSchema } },
    async (request, reply) => {
      try {
        const { currentPassword, newPassword, newUsername } = request.body as { currentPassword: string; newPassword: string; newUsername?: string };
        const user = (request as unknown as Record<string, unknown>).user as { username: string } | null;

        if (!user) {
          return await reply.status(401).send({ error: 'Authentication required' });
        }

        await authService.changePassword(user.username, currentPassword, newPassword, newUsername);
        request.log.info({ username: user.username, newUsername }, 'Credentials updated');
        return { success: true };
      } catch (error) {
        if (error instanceof Error && error.message === 'Current password is incorrect') {
          return reply.status(400).send({ error: error.message });
        }
        request.log.error(error, 'Failed to change password');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/auth/api-key/regenerate — protected
  app.post('/api/auth/api-key/regenerate', async (request, reply) => {
    try {
      const newKey = await authService.regenerateApiKey();
      request.log.info('API key regenerated');
      return { apiKey: newKey };
    } catch (error) {
      request.log.error(error, 'Failed to regenerate API key');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
