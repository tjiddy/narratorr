import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4 },
}));

import { filesystemRoutes } from './filesystem.js';

describe('rate limiting: GET /api/filesystem/browse', () => {
  let fsApp: FastifyInstance;

  beforeAll(async () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(rateLimit, { global: false });
    await filesystemRoutes(app);
    await app.ready();
    fsApp = app;
  });

  afterAll(async () => {
    await fsApp.close();
  });

  it('allows 60 requests within the window from the same IP', async () => {
    const ip = '10.0.0.60';
    for (let i = 0; i < 60; i++) {
      const res = await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ip,
      });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('returns 429 on the 61st request from the same IP within the window', async () => {
    const ip = '10.0.0.61';
    for (let i = 0; i < 60; i++) {
      await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ip,
      });
    }
    const res = await fsApp.inject({
      method: 'GET',
      url: '/api/filesystem/browse?path=/tmp',
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('does not throttle a request from a different IP within the same window', async () => {
    const ipA = '10.0.0.62';
    const ipB = '10.0.0.63';
    for (let i = 0; i < 60; i++) {
      await fsApp.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/tmp',
        remoteAddress: ipA,
      });
    }
    const limitedA = await fsApp.inject({
      method: 'GET',
      url: '/api/filesystem/browse?path=/tmp',
      remoteAddress: ipA,
    });
    expect(limitedA.statusCode).toBe(429);

    const freeB = await fsApp.inject({
      method: 'GET',
      url: '/api/filesystem/browse?path=/tmp',
      remoteAddress: ipB,
    });
    expect(freeB.statusCode).not.toBe(429);
  });
});
