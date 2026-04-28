import { type FastifyRequest } from 'fastify';
import type { config } from '../config.js';

type CookieAppConfig = Pick<typeof config, 'isDev' | 'urlBase'>;

export function sessionCookieOptions(cfg: CookieAppConfig, request: FastifyRequest) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !cfg.isDev && request.protocol === 'https',
    path: cfg.urlBase || '/',
  } as const;
}
