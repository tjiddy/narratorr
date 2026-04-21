import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LISTEN_RETRY_DELAY_MS = 1000;

export async function registerStaticAndSpa(
  app: FastifyInstance,
  urlBasePrefix: string,
  clientPathOverride?: string,
) {
  const clientPath = clientPathOverride ?? path.join(__dirname, '../client');
  if (!fs.existsSync(clientPath)) return;

  // Read index.html once — nonce injection happens per-request
  const indexHtmlPath = path.join(clientPath, 'index.html');
  const rawIndexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

  function sendIndexHtml(reply: FastifyReply) {
    const nonce = reply.cspNonce?.script;
    const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
    const configScript = `<script${nonceAttr}>window.__NARRATORR_URL_BASE__=${JSON.stringify(urlBasePrefix)};</script>`;
    const baseHref = urlBasePrefix ? `${urlBasePrefix}/` : '/';
    let html = rawIndexHtml.replace('<head>', `<head><base href="${baseHref}">`);
    html = html.replace('</head>', `${configScript}\n</head>`);
    // Inject nonce into pre-existing inline <script> tags (those without a src attribute)
    if (nonce) {
      html = html.replace(/<script(?![^>]*\bsrc\b)(?![^>]*\bnonce\b)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
    }
    return reply.type('text/html').send(html);
  }

  // Register explicit routes for HTML entry points — these take priority
  // over @fastify/static's wildcard, ensuring config script + nonce injection
  const entryPaths = urlBasePrefix
    ? [`${urlBasePrefix}/`, `${urlBasePrefix}/index.html`]
    : ['/', '/index.html'];

  for (const entryPath of entryPaths) {
    app.get(entryPath, (_request, reply) => sendIndexHtml(reply));
  }

  // Serve static assets (JS, CSS, images, etc.)
  await app.register(fastifyStatic, {
    root: clientPath,
    prefix: urlBasePrefix || '/',
    index: false,
    wildcard: true,
  });

  // SPA fallback — serve index.html for in-scope non-API routes only
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

    return sendIndexHtml(reply);
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
        await new Promise((r) => setTimeout(r, LISTEN_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}
