import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function registerStaticAndSpa(
  app: FastifyInstance,
  urlBasePrefix: string,
  clientPathOverride?: string,
) {
  const clientPath = clientPathOverride ?? path.join(__dirname, '../client');
  if (!fs.existsSync(clientPath)) return;

  // Read index.html once and inject URL_BASE config for the frontend
  const indexHtmlPath = path.join(clientPath, 'index.html');
  const rawIndexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
  const configScript = `<script>window.__NARRATORR_URL_BASE__=${JSON.stringify(urlBasePrefix)};</script>`;
  const indexHtml = rawIndexHtml.replace('</head>', `${configScript}\n</head>`);

  await app.register(fastifyStatic, {
    root: clientPath,
    prefix: urlBasePrefix || '/',
  });

  // SPA fallback - serve index.html for in-scope non-API routes only
  app.setNotFoundHandler((request, reply) => {
    const urlPath = request.url.split('?')[0];
    const apiPrefix = urlBasePrefix ? `${urlBasePrefix}/api/` : '/api/';

    // Reject requests outside the URL_BASE scope
    if (urlBasePrefix && !urlPath.startsWith(`${urlBasePrefix}/`) && urlPath !== urlBasePrefix) {
      return reply.status(404).send({ error: 'Not found' });
    }

    // Don't serve SPA for API routes
    if (urlPath.startsWith(apiPrefix)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    return reply.type('text/html').send(indexHtml);
  });
}

export async function listenWithRetry(app: FastifyInstance, port: number, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await app.listen({ port, host: '0.0.0.0' });
      return;
    } catch (err: unknown) {
      const isAddrInUse = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (isAddrInUse && attempt < maxRetries) {
        app.log.warn({ port, attempt }, 'Port in use, retrying…');
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}
