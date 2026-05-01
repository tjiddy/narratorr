import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { DEV_CORS_ORIGINS, buildCorsOptions } from './cors-config.js';

async function createCorsTestApp(isDev: boolean, prodOrigin = 'https://app.example.com'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, buildCorsOptions({ isDev, corsOrigin: prodOrigin }));
  app.get('/api/ping', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('CORS dev-mode allowlist (#742)', () => {
  it('dev: allows whitelisted origin (http://localhost:5173) with credentials', async () => {
    const app = await createCorsTestApp(true);
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/ping',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('dev: allows whitelisted server self-origin (http://localhost:3000)', async () => {
    const app = await createCorsTestApp(true);
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/ping',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    } finally {
      await app.close();
    }
  });

  it('dev: does NOT echo a non-allowlisted origin (https://evil.example.com)', async () => {
    const app = await createCorsTestApp(true);
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/ping',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    } finally {
      await app.close();
    }
  });

  it('production: honors configured origin and rejects others', async () => {
    const app = await createCorsTestApp(false, 'https://app.example.com');
    try {
      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/api/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      });
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

      const rejected = await app.inject({
        method: 'OPTIONS',
        url: '/api/ping',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'GET',
        },
      });
      expect(rejected.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    } finally {
      await app.close();
    }
  });

  it('exports the canonical dev allowlist', () => {
    expect(DEV_CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:3000']);
  });

  it('buildCorsOptions(dev) returns the dev allowlist, never true', () => {
    const opts = buildCorsOptions({ isDev: true, corsOrigin: 'https://app.example.com' });
    expect(opts.origin).toBe(DEV_CORS_ORIGINS);
    expect(Array.isArray(opts.origin)).toBe(true);
    expect(opts.origin).not.toBe(true);
    expect(opts.credentials).toBe(true);
  });

  it('buildCorsOptions(prod) returns the configured origin with credentials enabled', () => {
    const opts = buildCorsOptions({ isDev: false, corsOrigin: 'https://app.example.com' });
    expect(opts.origin).toBe('https://app.example.com');
    expect(opts.credentials).toBe(true);
  });
});
