import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { type ZodTypeProvider, validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';

vi.mock('./config.js', () => ({
  config: { isDev: false, logLevel: 'silent', trustedProxies: false },
}));

import { buildFastifyOptions } from './fastify-options.js';

describe('buildFastifyOptions (production Fastify constructor options)', () => {
  it('sets routerOptions.maxParamLength above Fastify\'s 100-char default', () => {
    const opts = buildFastifyOptions();
    expect(opts.routerOptions).toBeDefined();
    expect(opts.routerOptions.maxParamLength).toBeGreaterThanOrEqual(2048);
  });

  // Boot real Fastify: without the cap bump, the router rejects before the handler.
  it('boots a Fastify instance that routes long preview-token path params (>100 chars)', async () => {
    const app = Fastify(buildFastifyOptions()).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const params = z.object({ token: z.string().min(1).max(2048) });
    app.get<{ Params: z.infer<typeof params> }>(
      '/api/import/preview/:token',
      { schema: { params } },
      async (request) => ({ tokenLen: (request.params as { token: string }).token.length }),
    );
    await app.ready();

    try {
      const longToken = 'a'.repeat(300);
      const res = await app.inject({ method: 'GET', url: `/api/import/preview/${longToken}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ tokenLen: 300 });
    } finally {
      await app.close();
    }
  });

  // Default Fastify rejects before the handler; current find-my-way reports 414.
  it('default-cap Fastify (no maxParamLength override) rejects the same long token with 414', async () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const params = z.object({ token: z.string().min(1).max(2048) });
    app.get<{ Params: z.infer<typeof params> }>(
      '/api/import/preview/:token',
      { schema: { params } },
      async () => ({ ok: true }),
    );
    await app.ready();

    try {
      const longToken = 'a'.repeat(300);
      const res = await app.inject({ method: 'GET', url: `/api/import/preview/${longToken}` });
      expect(res.statusCode).toBe(414);
    } finally {
      await app.close();
    }
  });
});
